import { WorkerEntrypoint } from "cloudflare:workers";
import {
  writeAssetCacheMetric,
  writeWorkersCacheMetric,
  type AssetCacheOutcome,
  type WorkersCacheOutcome,
} from "./cache-metrics";

const RELEASE_ROOT = "releases";
const DEFAULT_DOCUMENT = "pzmap.html";
const HEALTH_PATH = "/.well-known/fanmap42-health";
const WORKERS_CACHE_KEY_SCHEMA = "v1";
const WORKERS_CACHE_STATUS_HEADER = "X-FanMap42-Workers-Cache";
const WORKER_VERSION_HEADER = "X-FanMap42-Worker-Version";
const WORKER_VERSION_TAG_HEADER = "X-FanMap42-Worker-Version-Tag";
const NEGATIVE_CACHE_MARKER_HEADER = "X-FanMap42-Negative-Cache";
const NOT_FOUND_BODY = "Not Found";
const NOT_FOUND_RESPONSE_BYTES = NOT_FOUND_BODY.length;

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  dzi: "application/xml; charset=utf-8",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  sha256: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  zip: "application/zip",
};

export function normalizeAssetPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }

  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  const path = segments.join("/");
  if (path === "" || path === "index.html") {
    return DEFAULT_DOCUMENT;
  }
  if (path === RELEASE_ROOT || path.startsWith(`${RELEASE_ROOT}/`)) {
    return null;
  }
  return path;
}

export function fallbackContentType(key: string): string | undefined {
  const filename = key.split("/").at(-1) ?? "";
  const extension = filename.includes(".") ? filename.split(".").at(-1)?.toLowerCase() : undefined;
  return extension === undefined ? undefined : MIME_TYPES[extension];
}

export function cacheControlFor(key: string): string {
  if (key === "robots.txt") {
    return "public, max-age=3600";
  }
  if (key.endsWith("/READY") || key === "READY") {
    return "no-store";
  }
  // Public URLs are intentionally unversioned, while the internal edge key is
  // release/manifest scoped. Browsers therefore get bounded, asset-specific
  // freshness and Cloudflare keeps the immutable release generation for a year.
  let browserSeconds = 3600;
  if (/(?:^|\/)pzmap(?:_config)?\.(?:html|json)$/.test(key)) {
    browserSeconds = 0;
  } else if (/(?:^|\/)map_data\/[^/]+\/layer-?\d+_files\/\d+\/\d+_\d+\.(?:jpe?g|png|webp)$/i.test(key)) {
    browserSeconds = 86400;
  }
  return `public, max-age=${browserSeconds}, must-revalidate, s-maxage=31536000`;
}

function workerVersion(env: Env): { id: string; tag: string } {
  return {
    id: env.CF_VERSION_METADATA.id,
    tag: env.CF_VERSION_METADATA.tag ?? "",
  };
}

function withWorkerVersion(response: Response, env: Env): Response {
  const version = workerVersion(env);
  const headers = new Headers(response.headers);
  headers.set(WORKER_VERSION_HEADER, version.id);
  if (version.tag !== "") {
    headers.set(WORKER_VERSION_TAG_HEADER, version.tag);
  } else {
    headers.delete(WORKER_VERSION_TAG_HEADER);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function addSecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
}

export function refreshPublicAssetHeaders(response: Response, assetPath: string): Response {
  if (![200, 206, 304].includes(response.status)) {
    return response;
  }
  const headers = new Headers(response.headers);
  // Cache objects can outlive a Worker deploy. Reassert current policy on
  // every positive response so legacy metadata cannot retain an unsafe browser
  // lifetime after the code has changed.
  headers.set("Cache-Control", cacheControlFor(assetPath));
  addSecurityHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function matchesIfNoneMatch(request: Request, httpEtag: string): boolean {
  const value = request.headers.get("If-None-Match");
  if (value === null) {
    return false;
  }
  return value
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === httpEtag);
}

function cacheKeyFor(request: Request, release: string, manifestHash: string, objectKey: string): Request {
  const url = new URL(request.url);
  url.pathname = `/__fanmap42_cache/${encodeURIComponent(release)}/${manifestHash}/${encodeURIComponent(objectKey)}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

export function releaseSelectionForAsset(
  env: Env,
  assetPath: string,
): { release: string; manifestHash: string } {
  const clientRelease = env.CLIENT_ASSET_RELEASE?.trim();
  const clientManifestHash = env.CLIENT_ASSET_MANIFEST_SHA256?.trim();
  if (assetPath !== "robots.txt" && !assetPath.startsWith("map_data/") &&
      clientRelease !== undefined && clientRelease !== "" &&
      clientManifestHash !== undefined && /^[0-9a-f]{64}$/.test(clientManifestHash)) {
    return { release: clientRelease, manifestHash: clientManifestHash };
  }
  return {
    release: env.ACTIVE_RELEASE,
    manifestHash: env.EXPECTED_MANIFEST_SHA256,
  };
}

export function mapFloorLayer(assetPath: string): number | null {
  const match = /^map_data\/[A-Za-z0-9_-]+\/layer(-?\d+)(?:_files\/|\.dzi$)/.exec(assetPath);
  if (match === null) {
    return null;
  }
  const layer = Number(match[1]);
  return Number.isSafeInteger(layer) ? layer : null;
}

export function isNegativeCacheableTile(assetPath: string): boolean {
  return /^map_data\/[A-Za-z0-9_-]+\/layer-?\d+_files\/\d+\/\d+_\d+\.(?:jpe?g|png|webp)$/i.test(assetPath);
}

export function isNegativeCacheableMapMetadata(assetPath: string): boolean {
  return /^map_data\/[A-Za-z0-9_-]+\/(?:layer-?\d+\.dzi|map_info\.json|marks\.json)$/.test(assetPath);
}

export function isNegativeCacheableMapAsset(assetPath: string): boolean {
  return isNegativeCacheableTile(assetPath) || isNegativeCacheableMapMetadata(assetPath);
}

export function isNegativeCacheableViewerAsset(assetPath: string): boolean {
  return assetPath !== "robots.txt" && !assetPath.startsWith("map_data/");
}

export function isNegativeCacheableAsset(assetPath: string): boolean {
  return isNegativeCacheableMapAsset(assetPath) || isNegativeCacheableViewerAsset(assetPath);
}

function configuredLayerBounds(env: Env): { min: number; maxExclusive: number } | null {
  if (env.ENFORCE_MAP_LAYER_BOUNDS !== "1") {
    return null;
  }
  const min = Number(env.MAP_LAYER_MIN);
  const maxExclusive = Number(env.MAP_LAYER_MAX_EXCLUSIVE);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(maxExclusive) || min >= maxExclusive) {
    return null;
  }
  return { min, maxExclusive };
}

function boundedCacheSeconds(value: string): number {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : 0;
}

export function negativeCacheSecondsFor(env: Env, assetPath: string): number {
  if (isNegativeCacheableTile(assetPath)) {
    return boundedCacheSeconds(env.NEGATIVE_TILE_CACHE_SECONDS);
  }
  if (isNegativeCacheableMapMetadata(assetPath)) {
    return boundedCacheSeconds(env.NEGATIVE_METADATA_CACHE_SECONDS);
  }
  if (isNegativeCacheableViewerAsset(assetPath)) {
    return boundedCacheSeconds(env.NEGATIVE_VIEWER_ASSET_CACHE_SECONDS);
  }
  return 0;
}

function readinessCacheSeconds(env: Env): number {
  const seconds = Number(env.READINESS_CACHE_SECONDS);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : 0;
}

function workersCacheGatewayEnabled(env: Env): boolean {
  return env.USE_WORKERS_CACHE_GATEWAY === "1";
}

function notFoundResponse(edgeCacheSeconds = 0): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  // Keep browsers from retaining a missing viewer module while allowing the
  // release-scoped Workers Cache key to absorb repeated probes at the edge.
  if (edgeCacheSeconds > 0) {
    headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${edgeCacheSeconds}`);
  }
  addSecurityHeaders(headers);
  return new Response(NOT_FOUND_BODY, { status: 404, headers });
}

function negativeCacheSentinel(seconds: number): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": `public, max-age=${seconds}`,
      [NEGATIVE_CACHE_MARKER_HEADER]: "1",
    },
  });
}

function isNegativeCacheSentinel(response: Response): boolean {
  return response.status === 404 && response.headers.get(NEGATIVE_CACHE_MARKER_HEADER) === "1";
}

function responseContentLength(response: Response): number {
  const value = response.headers.get("Content-Length");
  if (value === null) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function recordAssetCacheLookup(
  request: Request,
  env: Env,
  assetPath: string,
  outcome: AssetCacheOutcome,
  status: number,
  responseBytes: number,
  r2Bytes: number,
  lookupMilliseconds: number,
): void {
  const url = new URL(request.url);
  const colo = typeof request.cf?.colo === "string" ? request.cf.colo : "unknown";
  writeAssetCacheMetric(env.CACHE_METRICS, {
    outcome,
    method: request.method,
    hostname: url.hostname,
    assetPath,
    colo,
    release: env.ACTIVE_RELEASE,
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag ?? "",
    status,
    responseBytes,
    r2Bytes,
    lookupMilliseconds,
  });
}

function readinessCacheKey(request: Request, release: string, manifestHash: string): Request {
  const url = new URL(request.url);
  url.pathname = `/__fanmap42_ready/${encodeURIComponent(release)}/${manifestHash}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function releaseIsReady(request: Request, env: Env, ctx: ExecutionContext): Promise<boolean> {
  const cacheKey = readinessCacheKey(request, env.ACTIVE_RELEASE, env.EXPECTED_MANIFEST_SHA256);
  const cacheSeconds = readinessCacheSeconds(env);
  if (cacheSeconds > 0 && await caches.default.match(cacheKey) !== undefined) {
    return true;
  }

  const readyKey = `${RELEASE_ROOT}/${env.ACTIVE_RELEASE}/READY`;
  const ready = await env.BUCKET.get(readyKey);
  if (ready === null || ready.size > 1024) {
    return false;
  }

  const fields = new Map(
    (await ready.text())
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
  const manifestHash = fields.get("manifest_sha256") ?? "";
  if (fields.get("release_id") !== env.ACTIVE_RELEASE ||
      manifestHash !== env.EXPECTED_MANIFEST_SHA256 ||
      !/^[0-9a-f]{64}$/.test(manifestHash)) {
    return false;
  }

  if (cacheSeconds > 0) {
    const cacheResponse = new Response("ready", {
      headers: { "Cache-Control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` },
    });
    ctx.waitUntil(
      caches.default.put(cacheKey, cacheResponse).catch((error: unknown) => {
        console.error(JSON.stringify({
          message: "readiness cache put failed",
          release: env.ACTIVE_RELEASE,
          error: error instanceof Error ? error.message : String(error),
        }));
      }),
    );
  }
  return true;
}

export function parseSingleByteRange(value: string, size: number): R2Range | null {
  if (!Number.isSafeInteger(size) || size < 0 || value.includes(",")) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null) {
    return null;
  }

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    return null;
  }
  if (startText === "") {
    const suffix = Number(endText);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix: Math.min(suffix, size) } : null;
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return null;
  }
  if (endText === "") {
    return { offset: start, length: size - start };
  }

  const requestedEnd = Number(endText);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

function ifRangeMatches(value: string, object: R2Object): boolean {
  const candidate = value.trim();
  if (candidate.startsWith('"') || candidate.startsWith("W/")) {
    return candidate.replace(/^W\//, "") === object.httpEtag;
  }
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) && object.uploaded.getTime() <= timestamp;
}

function responseHeaders(object: R2Object, objectKey: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControlFor(objectKey));

  const existingType = headers.get("Content-Type");
  if (existingType === null || existingType === "application/octet-stream") {
    const inferredType = fallbackContentType(objectKey);
    if (inferredType !== undefined) {
      headers.set("Content-Type", inferredType);
    }
  }

  addSecurityHeaders(headers);
  return headers;
}

function partialResponseHeaders(object: R2Object, headers: Headers, range?: R2Range): number {
  if (range === undefined) {
    return 200;
  }

  let start: number;
  let length: number;
  if ("suffix" in range) {
    length = Math.min(range.suffix, object.size);
    start = object.size - length;
  } else {
    start = range.offset ?? 0;
    length = range.length ?? object.size - start;
  }

  headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
  headers.set("Content-Length", String(length));
  return 206;
}

async function readObject(env: Env, objectKey: string, range?: R2Range): Promise<R2ObjectBody | null> {
  if (range !== undefined) {
    return env.BUCKET.get(objectKey, { range });
  }
  return env.BUCKET.get(objectKey);
}

async function serveAssetByPath(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  assetPath: string,
): Promise<Response> {
  const selectedRelease = releaseSelectionForAsset(env, assetPath);
  const objectKey = assetPath === "robots.txt"
    ? "robots.txt"
    : `${RELEASE_ROOT}/${selectedRelease.release}/${assetPath}`;

  const canUseCache = request.method === "GET" &&
    !request.headers.has("Range") &&
    !request.headers.has("If-None-Match");
  const configuredNegativeCacheSeconds = negativeCacheSecondsFor(env, assetPath);
  const floorLayer = mapFloorLayer(assetPath);
  const layerBounds = configuredLayerBounds(env);
  if (floorLayer !== null && layerBounds !== null &&
      (floorLayer < layerBounds.min || floorLayer >= layerBounds.maxExclusive)) {
    if (canUseCache) {
      recordAssetCacheLookup(
        request,
        env,
        assetPath,
        "invalid_map_layer",
        404,
        NOT_FOUND_RESPONSE_BYTES,
        0,
        0,
      );
    }
    return request.method === "HEAD"
      ? new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } })
      : notFoundResponse();
  }

  if (request.method === "HEAD") {
    const object = await env.BUCKET.head(objectKey);
    if (object === null) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const headers = responseHeaders(object, objectKey);
    if (matchesIfNoneMatch(request, object.httpEtag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const cacheKey = cacheKeyFor(
    request,
    selectedRelease.release,
    selectedRelease.manifestHash,
    objectKey,
  );
  let cacheMissLookupMilliseconds: number | undefined;
  if (canUseCache) {
    const lookupStarted = performance.now();
    let cached: Response | undefined;
    try {
      cached = await caches.default.match(cacheKey);
    } catch (error: unknown) {
      recordAssetCacheLookup(
        request,
        env,
        assetPath,
        "lookup_error",
        503,
        0,
        0,
        performance.now() - lookupStarted,
      );
      throw error;
    }
    const lookupMilliseconds = performance.now() - lookupStarted;
    if (cached !== undefined) {
      if (isNegativeCacheSentinel(cached)) {
        if (configuredNegativeCacheSeconds > 0) {
          recordAssetCacheLookup(
            request,
            env,
            assetPath,
            "negative_hit",
            404,
            NOT_FOUND_RESPONSE_BYTES,
            0,
            lookupMilliseconds,
          );
          return notFoundResponse(
            isNegativeCacheableViewerAsset(assetPath) ? configuredNegativeCacheSeconds : 0,
          );
        }
      } else {
        recordAssetCacheLookup(
          request,
          env,
          assetPath,
          "hit",
          cached.status,
          responseContentLength(cached),
          0,
          lookupMilliseconds,
        );
        return refreshPublicAssetHeaders(cached, assetPath);
      }
    }
    cacheMissLookupMilliseconds = lookupMilliseconds;
  }

  let requestedRange: R2Range | undefined;
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader !== null) {
    const metadata = await env.BUCKET.head(objectKey);
    if (metadata === null) {
      return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const ifRange = request.headers.get("If-Range");
    if (ifRange === null || ifRangeMatches(ifRange, metadata)) {
      const parsedRange = parseSingleByteRange(rangeHeader, metadata.size);
      if (parsedRange === null) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Cache-Control": "no-store", "Content-Range": `bytes */${metadata.size}` },
        });
      }
      requestedRange = parsedRange;
    }
  }

  let object: R2ObjectBody | null;
  try {
    object = await readObject(env, objectKey, requestedRange);
  } catch (error: unknown) {
    if (cacheMissLookupMilliseconds !== undefined) {
      recordAssetCacheLookup(
        request,
        env,
        assetPath,
        "miss_r2_error",
        503,
        0,
        0,
        cacheMissLookupMilliseconds,
      );
    }
    throw error;
  }
  if (object === null) {
    if (cacheMissLookupMilliseconds !== undefined) {
      recordAssetCacheLookup(
        request,
        env,
        assetPath,
        "miss_not_found",
        404,
        NOT_FOUND_RESPONSE_BYTES,
        0,
        cacheMissLookupMilliseconds,
      );
    }
    const response = notFoundResponse(
      isNegativeCacheableViewerAsset(assetPath) ? configuredNegativeCacheSeconds : 0,
    );
    if (cacheMissLookupMilliseconds !== undefined && configuredNegativeCacheSeconds > 0 &&
        isNegativeCacheableAsset(assetPath)) {
      ctx.waitUntil(
        caches.default.put(
          cacheKey,
          negativeCacheSentinel(configuredNegativeCacheSeconds),
        ).catch((error: unknown) => {
          console.error(JSON.stringify({
            message: "negative cache put failed",
            path: assetPath,
            error: error instanceof Error ? error.message : String(error),
          }));
        }),
      );
    }
    return response;
  }

  const headers = responseHeaders(object, objectKey);
  if (matchesIfNoneMatch(request, object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  const status = partialResponseHeaders(object, headers, requestedRange);
  if (status === 200) {
    headers.set("Content-Length", String(object.size));
  }
  const response = new Response(object.body, { status, headers });
  if (cacheMissLookupMilliseconds !== undefined) {
    recordAssetCacheLookup(
      request,
      env,
      assetPath,
      "miss",
      status,
      object.size,
      object.size,
      cacheMissLookupMilliseconds,
    );
  }
  if (canUseCache && status === 200 && cacheControlFor(objectKey) !== "no-store") {
    ctx.waitUntil(
      caches.default.put(cacheKey, response.clone()).catch((error: unknown) => {
        console.error(JSON.stringify({
          message: "cache put failed",
          path: assetPath,
          error: error instanceof Error ? error.message : String(error),
        }));
      }),
    );
  }
  return response;
}

export function workersCacheKeyFor(release: string, manifestHash: string, assetPath: string): string {
  return `/__fanmap42_asset/${WORKERS_CACHE_KEY_SCHEMA}/${encodeURIComponent(release)}/` +
    `${manifestHash}/${encodeURIComponent(assetPath)}`;
}

export function workersCacheKeyForAsset(env: Env, assetPath: string): string {
  const selected = releaseSelectionForAsset(env, assetPath);
  return workersCacheKeyFor(selected.release, selected.manifestHash, assetPath);
}

export function workersCacheOutcome(cacheStatus: string | null): WorkersCacheOutcome {
  switch (cacheStatus?.toUpperCase()) {
    case "HIT":
      return "hit";
    case "MISS":
      return "miss";
    case "BYPASS":
      return "bypass";
    case "ERROR_FALLBACK":
      return "fallback";
    case "EXPIRED":
      return "expired";
    case "REVALIDATED":
      return "revalidated";
    case "UPDATING":
      return "updating";
    case "STALE":
      return "stale";
    default:
      return "unknown";
  }
}

const CACHE_FRAGMENTING_REQUEST_HEADERS = [
  "origin",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-forwarded-host",
  "x-host",
  "x-forwarded-scheme",
  "x-original-url",
  "x-rewrite-url",
  "forwarded",
] as const;

export function requestForAssetBackend(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of CACHE_FRAGMENTING_REQUEST_HEADERS) {
    headers.delete(header);
  }
  // Preserve Cloudflare's version-routing headers. The ctx.exports loopback
  // must stay on the explicitly selected Worker version during a 0% smoke
  // test. They cannot fragment the asset cache because the backend call uses
  // an explicit release-and-manifest-based cf.cacheKey.
  return new Request(request, { headers });
}

function releaseNotReadyResponse(): Response {
  return new Response("Release Not Ready", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "30" },
  });
}

function recordWorkersCacheLookup(
  request: Request,
  env: Env,
  assetPath: string,
  response: Response,
  cacheStatus: string,
  gatewayMilliseconds: number,
): void {
  const url = new URL(request.url);
  const colo = typeof request.cf?.colo === "string" ? request.cf.colo : "unknown";
  writeWorkersCacheMetric(env.CACHE_METRICS, {
    outcome: workersCacheOutcome(cacheStatus),
    cacheStatus,
    method: request.method,
    hostname: url.hostname,
    assetPath,
    colo,
    release: env.ACTIVE_RELEASE,
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag ?? "",
    status: response.status,
    responseBytes: responseContentLength(response),
    gatewayMilliseconds,
  });
}

async function serveThroughWorkersCache(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  assetPath: string,
): Promise<Response> {
  const started = performance.now();
  // Forward the original Request object so Cloudflare carries hidden version-
  // override routing state into the loopback during a 0% smoke test. The
  // explicit cache key below prevents request headers from fragmenting cache.
  const backendResponse = await ctx.exports.AssetBackend.fetch(request, {
    cf: {
      cacheKey: workersCacheKeyForAsset(env, assetPath),
    },
  });
  let response: Response;
  let cacheStatus: string;
  if (backendResponse.status >= 500) {
    // A named-entrypoint cache failure must not become an end-user failure.
    // The direct path retains the inner Cache API/R2 error handling and is
    // deliberately marked so rollout telemetry can gate on every recovery.
    response = refreshPublicAssetHeaders(
      await serveAssetByPath(requestForAssetBackend(request), env, ctx, assetPath),
      assetPath,
    );
    cacheStatus = "ERROR_FALLBACK";
  } else {
    response = refreshPublicAssetHeaders(backendResponse, assetPath);
    cacheStatus = response.headers.get("Cf-Cache-Status") ?? "UNKNOWN";
  }
  recordWorkersCacheLookup(
    request,
    env,
    assetPath,
    response,
    cacheStatus,
    performance.now() - started,
  );

  const headers = new Headers(response.headers);
  headers.set(WORKERS_CACHE_STATUS_HEADER, cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class AssetBackend extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      });
    }

    // Sanitize only after crossing the cached entrypoint boundary. Cloning
    // before ctx.exports.fetch would discard Cloudflare's hidden routing state.
    const backendRequest = requestForAssetBackend(request);
    const assetPath = normalizeAssetPath(new URL(backendRequest.url).pathname);
    if (assetPath === null) {
      return notFoundResponse();
    }
    return serveAssetByPath(backendRequest, this.env, this.ctx, assetPath);
  }
}

async function healthResponse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const version = workerVersion(env);
  try {
    const ready = await releaseIsReady(request, env, ctx);
    return withWorkerVersion(Response.json(
      {
        status: ready ? "ok" : "not_ready",
        release: env.ACTIVE_RELEASE,
        manifest_sha256: env.EXPECTED_MANIFEST_SHA256,
        worker_version: version.id,
        worker_version_tag: version.tag,
      },
      {
        status: ready ? 200 : 503,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(ready ? {} : { "Retry-After": "30" }),
        },
      },
    ), env);
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "health check failed",
      release: env.ACTIVE_RELEASE,
      error: error instanceof Error ? error.message : String(error),
    }));
    return withWorkerVersion(Response.json(
      {
        status: "not_ready",
        release: env.ACTIVE_RELEASE,
        manifest_sha256: env.EXPECTED_MANIFEST_SHA256,
        worker_version: version.id,
        worker_version_tag: version.tag,
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "5",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ), env);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname !== env.CANONICAL_HOST) {
      url.hostname = env.CANONICAL_HOST;
      url.protocol = "https:";
      return withWorkerVersion(Response.redirect(url.toString(), 308), env);
    }

    if (url.pathname === HEALTH_PATH) {
      return healthResponse(request, env, ctx);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withWorkerVersion(new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      }), env);
    }

    try {
      const assetPath = normalizeAssetPath(url.pathname);
      if (assetPath === null) {
        return withWorkerVersion(notFoundResponse(), env);
      }
      if (assetPath !== "robots.txt" && !(await releaseIsReady(request, env, ctx))) {
        return withWorkerVersion(releaseNotReadyResponse(), env);
      }
      if (workersCacheGatewayEnabled(env)) {
        return withWorkerVersion(await serveThroughWorkersCache(request, env, ctx, assetPath), env);
      }
      return withWorkerVersion(await serveAssetByPath(request, env, ctx, assetPath), env);
    } catch (error: unknown) {
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return withWorkerVersion(new Response("Service Unavailable", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      }), env);
    }
  },
} satisfies ExportedHandler<Env>;

import {
  writeAssetCacheMetric,
  writeSiteRouteMetric,
  type AssetCacheOutcome,
  type SiteRouteFamily,
} from "./cache-metrics";

const RELEASE_ROOT = "releases";
const DEFAULT_DOCUMENT = "pzmap.html";
const HEALTH_PATH = "/.well-known/fanmap42-health";
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
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
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
  if (key.endsWith("/READY") || key === "READY") {
    return "no-store";
  }
  return "public, max-age=3600, must-revalidate, s-maxage=31536000";
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
  if (![200, 304].includes(response.status)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControlFor(assetPath));
  addSecurityHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isLegacyTileAsset(assetPath: string): boolean {
  return /^map_data\/[A-Za-z0-9_-]+\/layer-?\d+_files\/\d+\/\d+_\d+\.(?:jpe?g|png|webp)$/i
    .test(assetPath);
}

export function isCompatibilityMapAsset(assetPath: string): boolean {
  return assetPath.startsWith("map_data/") && !isLegacyTileAsset(assetPath);
}

interface DirectTileEnv {
  DIRECT_TILE_ORIGIN: string;
  ACTIVE_RELEASE: string;
}

export function directTileUrl(
  requestUrl: string,
  env: DirectTileEnv,
  assetPath: string,
): string {
  const origin = new URL(env.DIRECT_TILE_ORIGIN);
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" ||
      origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new Error("DIRECT_TILE_ORIGIN must be an HTTPS origin without a path");
  }
  const request = new URL(requestUrl);
  origin.pathname = `/${RELEASE_ROOT}/${env.ACTIVE_RELEASE}/${assetPath}`;
  origin.search = request.search;
  return origin.toString();
}

function matchesIfNoneMatch(request: Request, httpEtag: string): boolean {
  const value = request.headers.get("If-None-Match");
  if (value === null) return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === httpEtag);
}

function cacheKeyFor(request: Request, env: Env, assetPath: string): Request {
  const url = new URL(request.url);
  url.pathname = `/__fanmap42_map_compat/${encodeURIComponent(env.ACTIVE_RELEASE)}/` +
    `${env.EXPECTED_MANIFEST_SHA256}/${encodeURIComponent(assetPath)}`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

function boundedCacheSeconds(value: string): number {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : 0;
}

function readinessCacheSeconds(env: Env): number {
  return boundedCacheSeconds(env.READINESS_CACHE_SECONDS);
}

function negativeMetadataCacheSeconds(env: Env): number {
  return boundedCacheSeconds(env.NEGATIVE_METADATA_CACHE_SECONDS);
}

function notFoundResponse(head = false): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  addSecurityHeaders(headers);
  return new Response(head ? null : NOT_FOUND_BODY, { status: 404, headers });
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
  const parsed = Number(response.headers.get("Content-Length"));
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
  writeAssetCacheMetric(env.CACHE_METRICS, {
    outcome,
    method: request.method,
    hostname: url.hostname,
    assetPath,
    colo: typeof request.cf?.colo === "string" ? request.cf.colo : "unknown",
    release: env.ACTIVE_RELEASE,
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag ?? "",
    status,
    responseBytes,
    r2Bytes,
    lookupMilliseconds,
  });
}

function finalizeRoute(
  request: Request,
  env: Env,
  assetPath: string,
  routeFamily: SiteRouteFamily,
  response: Response,
): Response {
  const url = new URL(request.url);
  writeSiteRouteMetric(env.CACHE_METRICS, {
    routeFamily,
    method: request.method,
    hostname: url.hostname,
    assetPath,
    colo: typeof request.cf?.colo === "string" ? request.cf.colo : "unknown",
    release: env.ACTIVE_RELEASE,
    workerVersionId: env.CF_VERSION_METADATA.id,
    workerVersionTag: env.CF_VERSION_METADATA.tag ?? "",
    status: response.status,
  });
  return withWorkerVersion(response, env);
}

function readinessCacheKey(request: Request, env: Env): Request {
  const url = new URL(request.url);
  url.pathname = `/__fanmap42_ready/${encodeURIComponent(env.ACTIVE_RELEASE)}/` +
    env.EXPECTED_MANIFEST_SHA256;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function releaseIsReady(request: Request, env: Env, ctx: ExecutionContext): Promise<boolean> {
  const cacheKey = readinessCacheKey(request, env);
  const cacheSeconds = readinessCacheSeconds(env);
  if (cacheSeconds > 0 && await caches.default.match(cacheKey) !== undefined) {
    return true;
  }

  const ready = await env.BUCKET.get(`${RELEASE_ROOT}/${env.ACTIVE_RELEASE}/READY`);
  if (ready === null || ready.size > 1024) return false;
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
    ctx.waitUntil(caches.default.put(cacheKey, new Response("ready", {
      headers: { "Cache-Control": `public, max-age=${cacheSeconds}` },
    })).catch((error: unknown) => {
      console.error(JSON.stringify({
        message: "readiness cache put failed",
        release: env.ACTIVE_RELEASE,
        error: error instanceof Error ? error.message : String(error),
      }));
    }));
  }
  return true;
}

function responseHeaders(object: R2Object, objectKey: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", cacheControlFor(objectKey));
  const existingType = headers.get("Content-Type");
  if (existingType === null || existingType === "application/octet-stream") {
    const inferredType = fallbackContentType(objectKey);
    if (inferredType !== undefined) headers.set("Content-Type", inferredType);
  }
  addSecurityHeaders(headers);
  return headers;
}

async function serveCompatibilityMapAsset(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  assetPath: string,
): Promise<Response> {
  const objectKey = `${RELEASE_ROOT}/${env.ACTIVE_RELEASE}/${assetPath}`;
  if (request.method === "HEAD") {
    const object = await env.BUCKET.head(objectKey);
    if (object === null) return notFoundResponse(true);
    const headers = responseHeaders(object, objectKey);
    if (matchesIfNoneMatch(request, object.httpEtag)) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const canUseCache = !request.headers.has("If-None-Match");
  const cacheKey = cacheKeyFor(request, env, assetPath);
  let lookupMilliseconds = 0;
  if (canUseCache) {
    const started = performance.now();
    let cached: Response | undefined;
    try {
      cached = await caches.default.match(cacheKey);
    } catch (error: unknown) {
      recordAssetCacheLookup(request, env, assetPath, "lookup_error", 503, 0, 0, performance.now() - started);
      throw error;
    }
    lookupMilliseconds = performance.now() - started;
    if (cached !== undefined) {
      if (isNegativeCacheSentinel(cached)) {
        recordAssetCacheLookup(
          request, env, assetPath, "negative_hit", 404, NOT_FOUND_RESPONSE_BYTES, 0, lookupMilliseconds,
        );
        return notFoundResponse(request.method === "HEAD");
      }
      recordAssetCacheLookup(
        request, env, assetPath, "hit", cached.status, responseContentLength(cached), 0, lookupMilliseconds,
      );
      return refreshPublicAssetHeaders(cached, assetPath);
    }
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.BUCKET.get(objectKey);
  } catch (error: unknown) {
    recordAssetCacheLookup(request, env, assetPath, "miss_r2_error", 503, 0, 0, lookupMilliseconds);
    throw error;
  }
  if (object === null) {
    recordAssetCacheLookup(
      request, env, assetPath, "miss_not_found", 404, NOT_FOUND_RESPONSE_BYTES, 0, lookupMilliseconds,
    );
    const seconds = negativeMetadataCacheSeconds(env);
    if (canUseCache && seconds > 0) {
      ctx.waitUntil(caches.default.put(cacheKey, negativeCacheSentinel(seconds)).catch((error: unknown) => {
        console.error(JSON.stringify({
          message: "negative metadata cache put failed",
          path: assetPath,
          error: error instanceof Error ? error.message : String(error),
        }));
      }));
    }
    return notFoundResponse();
  }

  const headers = responseHeaders(object, objectKey);
  if (matchesIfNoneMatch(request, object.httpEtag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(object.size));
  const response = new Response(object.body, { status: 200, headers });
  recordAssetCacheLookup(request, env, assetPath, "miss", 200, object.size, object.size, lookupMilliseconds);
  if (canUseCache && cacheControlFor(objectKey) !== "no-store") {
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch((error: unknown) => {
      console.error(JSON.stringify({
        message: "metadata cache put failed",
        path: assetPath,
        error: error instanceof Error ? error.message : String(error),
      }));
    }));
  }
  return response;
}

function releaseNotReadyResponse(head = false): Response {
  return new Response(head ? null : "Release Not Ready", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "30" },
  });
}

async function healthResponse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const version = workerVersion(env);
  try {
    const ready = await releaseIsReady(request, env, ctx);
    const response = Response.json({
      status: ready ? "ok" : "not_ready",
      release: env.ACTIVE_RELEASE,
      manifest_sha256: env.EXPECTED_MANIFEST_SHA256,
      worker_version: version.id,
      worker_version_tag: version.tag,
    }, {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(ready ? {} : { "Retry-After": "30" }),
      },
    });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "health check failed",
      release: env.ACTIVE_RELEASE,
      error: error instanceof Error ? error.message : String(error),
    }));
    const response = Response.json({
      status: "not_ready",
      release: env.ACTIVE_RELEASE,
      manifest_sha256: env.EXPECTED_MANIFEST_SHA256,
      worker_version: version.id,
      worker_version_tag: version.tag,
    }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5", "X-Content-Type-Options": "nosniff" },
    });
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  }
}

function robotsResponse(head = false): Response {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  addSecurityHeaders(headers);
  return new Response(head ? null : "User-agent: *\nDisallow:\n", { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== env.CANONICAL_HOST) {
      url.hostname = env.CANONICAL_HOST;
      url.protocol = "https:";
      return finalizeRoute(
        request,
        env,
        url.pathname,
        "canonical_redirect",
        new Response(null, { status: 308, headers: { Location: url.toString(), "Cache-Control": "no-store" } }),
      );
    }
    if (url.pathname === HEALTH_PATH) {
      return finalizeRoute(request, env, HEALTH_PATH, "health", await healthResponse(request, env, ctx));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return finalizeRoute(request, env, url.pathname, "method_rejected", new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
      }));
    }

    const assetPath = normalizeAssetPath(url.pathname);
    if (assetPath === null) {
      return finalizeRoute(request, env, url.pathname, "invalid_path", notFoundResponse(request.method === "HEAD"));
    }
    if (assetPath === "robots.txt") {
      return finalizeRoute(request, env, assetPath, "robots", robotsResponse(request.method === "HEAD"));
    }
    if (isLegacyTileAsset(assetPath)) {
      return finalizeRoute(request, env, assetPath, "legacy_tile_redirect", new Response(null, {
        status: 308,
        headers: {
          Location: directTileUrl(request.url, env, assetPath),
          "Cache-Control": "public, max-age=3600",
        },
      }));
    }
    if (!isCompatibilityMapAsset(assetPath)) {
      return finalizeRoute(request, env, assetPath, "static_miss", notFoundResponse(request.method === "HEAD"));
    }

    try {
      if (!(await releaseIsReady(request, env, ctx))) {
        return finalizeRoute(
          request,
          env,
          assetPath,
          "map_compat",
          releaseNotReadyResponse(request.method === "HEAD"),
        );
      }
      const response = await serveCompatibilityMapAsset(request, env, ctx, assetPath);
      return finalizeRoute(request, env, assetPath, "map_compat", response);
    } catch (error: unknown) {
      console.error(JSON.stringify({
        message: "compatibility request failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return finalizeRoute(request, env, assetPath, "unhandled_error", new Response("Service Unavailable", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      }));
    }
  },
} satisfies ExportedHandler<Env>;

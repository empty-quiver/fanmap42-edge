import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

const release = "pilot-b42.20-steam24574865-pzmap53b73b8-fma485d32-r1";
const manifestHash = "a".repeat(64);
const prefix = `releases/${release}`;
const clientRelease = "pilot-client-r1";
const clientPrefix = `releases/${clientRelease}`;
const readyCacheKey = new Request(
  `https://fanmap42.com/__fanmap42_ready/${encodeURIComponent(release)}/${manifestHash}`,
);
const sampleObjectKey = `${prefix}/sample.txt`;
const sampleCacheKey = new Request(
  `https://fanmap42.com/__fanmap42_cache/${encodeURIComponent(release)}/${manifestHash}/${encodeURIComponent(sampleObjectKey)}`,
);
const missingTilePath = "map_data/base/layer-15_files/0/0_0.webp";
const missingMetadataPath = "map_data/base/marks.json";
const missingViewerAssetPath = "missing-viewer-module.js";
const validUndergroundTilePath = "map_data/base/layer-15_files/13/1_0.webp";
const invalidLayerTilePath = "map_data/base/layer-18_files/0/0_0.webp";

function assetCacheKey(assetPath: string): Request {
  const objectKey = `${prefix}/${assetPath}`;
  return new Request(
    `https://fanmap42.com/__fanmap42_cache/${encodeURIComponent(release)}/${manifestHash}/${encodeURIComponent(objectKey)}`,
  );
}

function metricEnv(
  points: AnalyticsEngineDataPoint[],
  negativeTileCacheSeconds: Env["NEGATIVE_TILE_CACHE_SECONDS"] | "0" = "21600",
  enforceMapLayerBounds: Env["ENFORCE_MAP_LAYER_BOUNDS"] = "1",
  negativeMetadataCacheSeconds: Env["NEGATIVE_METADATA_CACHE_SECONDS"] | "0" = "300",
  negativeViewerAssetCacheSeconds: Env["NEGATIVE_VIEWER_ASSET_CACHE_SECONDS"] | "0" = "300",
): Env {
  return {
    BUCKET: env.BUCKET,
    ACTIVE_RELEASE: env.ACTIVE_RELEASE,
    EXPECTED_MANIFEST_SHA256: env.EXPECTED_MANIFEST_SHA256,
    CLIENT_ASSET_RELEASE: "",
    CLIENT_ASSET_MANIFEST_SHA256: "",
    CANONICAL_HOST: env.CANONICAL_HOST,
    // These tests isolate the inner Cache API and R2 behavior. Workers Cache
    // gateway behavior is exercised through the named-entrypoint unit helpers
    // and the live fixture/staging validation matrix.
    USE_WORKERS_CACHE_GATEWAY: "0",
    READINESS_CACHE_SECONDS: env.READINESS_CACHE_SECONDS,
    NEGATIVE_TILE_CACHE_SECONDS: negativeTileCacheSeconds as Env["NEGATIVE_TILE_CACHE_SECONDS"],
    NEGATIVE_METADATA_CACHE_SECONDS: negativeMetadataCacheSeconds as Env["NEGATIVE_METADATA_CACHE_SECONDS"],
    NEGATIVE_VIEWER_ASSET_CACHE_SECONDS:
      negativeViewerAssetCacheSeconds as Env["NEGATIVE_VIEWER_ASSET_CACHE_SECONDS"],
    ENFORCE_MAP_LAYER_BOUNDS: enforceMapLayerBounds,
    MAP_LAYER_MIN: env.MAP_LAYER_MIN,
    MAP_LAYER_MAX_EXCLUSIVE: env.MAP_LAYER_MAX_EXCLUSIVE,
    CACHE_METRICS: {
      writeDataPoint(point?: AnalyticsEngineDataPoint): void {
        if (point !== undefined) {
          points.push(point);
        }
      },
    },
    CF_VERSION_METADATA: env.CF_VERSION_METADATA,
  };
}

async function seedReadyRelease(): Promise<void> {
  await caches.default.delete(readyCacheKey);
  await caches.default.delete(sampleCacheKey);
  await caches.default.delete(assetCacheKey(missingTilePath));
  await caches.default.delete(assetCacheKey(missingMetadataPath));
  await caches.default.delete(assetCacheKey(missingViewerAssetPath));
  await caches.default.delete(assetCacheKey(validUndergroundTilePath));
  await caches.default.delete(assetCacheKey(invalidLayerTilePath));
  await env.BUCKET.put(
    `${prefix}/READY`,
    `release_id=${release}\nmanifest_sha256=${manifestHash}\n`,
    { httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "no-store" } },
  );
  await env.BUCKET.put(`${prefix}/pzmap.html`, "<html>FanMap42</html>", {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.BUCKET.put(`${prefix}/sample.txt`, "abcdefghij", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.BUCKET.put(`${clientPrefix}/pzmap.html`, "<html>FanMap42</html>", {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.BUCKET.put(`${clientPrefix}/sample.txt`, "abcdefghij", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.BUCKET.put(`${clientPrefix}/client-only.txt`, "client release", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await env.BUCKET.delete(`${prefix}/${missingTilePath}`);
  await env.BUCKET.delete(`${prefix}/${missingMetadataPath}`);
  await env.BUCKET.delete(`${prefix}/${missingViewerAssetPath}`);
  await env.BUCKET.put(`${prefix}/${validUndergroundTilePath}`, "underground", {
    httpMetadata: { contentType: "image/webp" },
  });
  await env.BUCKET.put(`${prefix}/${invalidLayerTilePath}`, "must-not-be-served", {
    httpMetadata: { contentType: "image/webp" },
  });
}

beforeEach(async () => {
  await seedReadyRelease();
});

describe("FanMap42 Worker", () => {
  it("reports readiness from the active release marker", async () => {
    const response = await exports.default.fetch(new Request("https://fanmap42.com/.well-known/fanmap42-health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      release,
      manifest_sha256: manifestHash,
      worker_version: env.CF_VERSION_METADATA.id,
      worker_version_tag: env.CF_VERSION_METADATA.tag,
    });
    expect(response.headers.get("x-fanmap42-worker-version")).toBe(env.CF_VERSION_METADATA.id);
  });

  it("normalizes readiness storage failures to a structured no-store 503", async () => {
    await caches.default.delete(readyCacheKey);
    const failingBucket = new Proxy(env.BUCKET, {
      get(target, property, receiver) {
        if (property === "get") {
          return async () => {
            throw new Error("synthetic R2 failure");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const testEnv = { ...metricEnv([]), BUCKET: failingBucket };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://fanmap42.com/.well-known/fanmap42-health"),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("x-fanmap42-worker-version")).toBe(env.CF_VERSION_METADATA.id);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      release,
      manifest_sha256: manifestHash,
      worker_version: env.CF_VERSION_METADATA.id,
    });
    await waitOnExecutionContext(ctx);
  });

  it("refuses to serve an unready release", async () => {
    await caches.default.delete(readyCacheKey);
    await env.BUCKET.delete(`${prefix}/READY`);

    const response = await exports.default.fetch(new Request("https://fanmap42.com/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Release Not Ready");
  });

  it("refuses a READY marker for a different manifest generation", async () => {
    await caches.default.delete(readyCacheKey);
    await env.BUCKET.put(
      `${prefix}/READY`,
      `release_id=${release}\nmanifest_sha256=${"b".repeat(64)}\n`,
      { httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "no-store" } },
    );

    const response = await exports.default.fetch(new Request("https://fanmap42.com/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Release Not Ready");
  });

  it("maps the root document and returns bounded metadata", async () => {
    const response = await exports.default.fetch(new Request("https://fanmap42.com/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-length")).toBe("21");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate, s-maxage=31536000");
    expect(await response.text()).toBe("<html>FanMap42</html>");
  });

  it("exposes the named asset backend for the staging gateway loopback", async () => {
    const response = await exports.AssetBackend.fetch(new Request("https://fanmap42.com/sample.txt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abcdefghij");
  });

  it("serves viewer assets from the client release and map data from the full release", async () => {
    const clientAsset = await exports.default.fetch(new Request("https://fanmap42.com/client-only.txt"));
    expect(clientAsset.status).toBe(200);
    expect(await clientAsset.text()).toBe("client release");

    const mapAsset = await exports.default.fetch(
      new Request(`https://fanmap42.com/${validUndergroundTilePath}`),
    );
    expect(mapAsset.status).toBe(200);
    expect(new TextDecoder().decode(await mapAsset.arrayBuffer())).toBe("underground");
  });

  it("records a cold cache miss followed by a warm cache hit", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);

    const coldContext = createExecutionContext();
    const cold = await worker.fetch(
      new Request("https://fanmap42.com/sample.txt"),
      testEnv,
      coldContext,
    );
    expect(cold.status).toBe(200);
    expect(await cold.text()).toBe("abcdefghij");
    await waitOnExecutionContext(coldContext);

    const warmContext = createExecutionContext();
    const warm = await worker.fetch(
      new Request("https://fanmap42.com/sample.txt"),
      testEnv,
      warmContext,
    );
    expect(warm.status).toBe(200);
    expect(await warm.text()).toBe("abcdefghij");
    await waitOnExecutionContext(warmContext);

    expect(points.map((point) => point.blobs?.[1])).toEqual(["miss", "hit"]);
    expect(points[0]?.doubles).toEqual([1, 10, 0, 10, expect.any(Number)]);
    expect(points[1]?.doubles).toEqual([1, 10, 10, 0, expect.any(Number)]);
  });

  it("keeps missing metadata on the shorter negative-cache TTL", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://fanmap42.com/${missingMetadataPath}`),
      testEnv,
      ctx,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await response.text();
    await waitOnExecutionContext(ctx);

    const sentinel = await caches.default.match(assetCacheKey(missingMetadataPath));
    expect(sentinel?.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("negative-caches missing viewer modules while keeping browsers no-store", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);
    const request = new Request(`https://fanmap42.com/${missingViewerAssetPath}`);

    const coldContext = createExecutionContext();
    const cold = await worker.fetch(request, testEnv, coldContext);
    expect(cold.status).toBe(404);
    expect(cold.headers.get("cache-control")).toBe("no-store");
    expect(cold.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=300");
    expect(cold.headers.get("x-fanmap42-negative-cache")).toBeNull();
    expect(await cold.text()).toBe("Not Found");
    await waitOnExecutionContext(coldContext);

    const sentinel = await caches.default.match(assetCacheKey(missingViewerAssetPath));
    expect(sentinel?.headers.get("cache-control")).toBe("public, max-age=300");

    const warmContext = createExecutionContext();
    const warm = await worker.fetch(request, testEnv, warmContext);
    expect(warm.status).toBe(404);
    expect(warm.headers.get("cache-control")).toBe("no-store");
    expect(warm.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=300");
    expect(warm.headers.get("x-fanmap42-negative-cache")).toBeNull();
    expect(await warm.text()).toBe("Not Found");
    await waitOnExecutionContext(warmContext);

    expect(points.map((point) => point.blobs?.[1])).toEqual(["miss_not_found", "negative_hit"]);
  });

  it("negative-caches an absent underground tile without exposing the sentinel", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);
    const request = new Request(`https://fanmap42.com/${missingTilePath}`);

    const coldContext = createExecutionContext();
    const cold = await worker.fetch(request, testEnv, coldContext);
    expect(cold.status).toBe(404);
    expect(cold.headers.get("cache-control")).toBe("no-store");
    expect(cold.headers.get("x-fanmap42-negative-cache")).toBeNull();
    expect(await cold.text()).toBe("Not Found");
    await waitOnExecutionContext(coldContext);
    const sentinel = await caches.default.match(assetCacheKey(missingTilePath));
    expect(sentinel?.headers.get("cache-control")).toBe("public, max-age=21600");

    const warmContext = createExecutionContext();
    const warm = await worker.fetch(request, testEnv, warmContext);
    expect(warm.status).toBe(404);
    expect(warm.headers.get("cache-control")).toBe("no-store");
    expect(warm.headers.get("x-fanmap42-negative-cache")).toBeNull();
    expect(await warm.text()).toBe("Not Found");
    await waitOnExecutionContext(warmContext);

    expect(points.map((point) => point.blobs?.[1])).toEqual(["miss_not_found", "negative_hit"]);
    expect(points[0]?.doubles).toEqual([1, 9, 0, 0, expect.any(Number)]);
    expect(points[1]?.doubles).toEqual([1, 9, 0, 0, expect.any(Number)]);

    const headContext = createExecutionContext();
    const head = await worker.fetch(
      new Request(request.url, { method: "HEAD" }),
      testEnv,
      headContext,
    );
    expect(head.status).toBe(404);
    await waitOnExecutionContext(headContext);

    const rangeContext = createExecutionContext();
    const range = await worker.fetch(
      new Request(request.url, { headers: { Range: "bytes=0-1" } }),
      testEnv,
      rangeContext,
    );
    expect(range.status).toBe(404);
    await range.text();
    await waitOnExecutionContext(rangeContext);
    expect(points).toHaveLength(2);
  });

  it("leaves negative caching disabled when the environment TTL is zero", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const request = new Request(`https://fanmap42.com/${missingTilePath}`);

    const seedContext = createExecutionContext();
    const seed = await worker.fetch(request, metricEnv(points), seedContext);
    expect(seed.status).toBe(404);
    await seed.text();
    await waitOnExecutionContext(seedContext);

    const testEnv = metricEnv(points, "0");

    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, testEnv, ctx);
      expect(response.status).toBe(404);
      await response.text();
      await waitOnExecutionContext(ctx);
    }

    expect(points.map((point) => point.blobs?.[1])).toEqual([
      "miss_not_found",
      "miss_not_found",
      "miss_not_found",
    ]);
  });

  it("serves valid underground tiles and rejects only out-of-range floors", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);

    const validContext = createExecutionContext();
    const valid = await worker.fetch(
      new Request(`https://fanmap42.com/${validUndergroundTilePath}`),
      testEnv,
      validContext,
    );
    expect(valid.status).toBe(200);
    expect(new TextDecoder().decode(await valid.arrayBuffer())).toBe("underground");
    await waitOnExecutionContext(validContext);

    const invalidContext = createExecutionContext();
    const invalid = await worker.fetch(
      new Request(`https://fanmap42.com/${invalidLayerTilePath}`),
      testEnv,
      invalidContext,
    );
    expect(invalid.status).toBe(404);
    expect(await invalid.text()).toBe("Not Found");
    await waitOnExecutionContext(invalidContext);

    expect(points.map((point) => point.blobs?.[1])).toEqual(["miss", "invalid_map_layer"]);
  });

  it("leaves floor rejection disabled in a production-style environment", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points, "0", "0");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://fanmap42.com/${invalidLayerTilePath}`),
      testEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("must-not-be-served");
    await waitOnExecutionContext(ctx);
    expect(points.map((point) => point.blobs?.[1])).toEqual(["miss"]);
  });

  it("serves valid byte ranges and rejects invalid ranges", async () => {
    const partial = await exports.default.fetch(new Request("https://fanmap42.com/sample.txt", {
      headers: { Range: "bytes=2-5" },
    }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("cdef");

    const invalid = await exports.default.fetch(new Request("https://fanmap42.com/sample.txt", {
      headers: { Range: "bytes=20-30" },
    }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    await invalid.text();
  });

  it("ignores a range when If-Range does not match", async () => {
    const response = await exports.default.fetch(new Request("https://fanmap42.com/sample.txt", {
      headers: { Range: "bytes=2-5", "If-Range": '"not-the-current-etag"' },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abcdefghij");
  });

  it("redirects www and rejects writes and direct release paths", async () => {
    const ctx = createExecutionContext();
    const redirect = await worker.fetch(
      new Request("https://www.fanmap42.com/map_data/base/layer0.dzi"),
      env,
      ctx,
    );
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://fanmap42.com/map_data/base/layer0.dzi");
    await redirect.text();
    await waitOnExecutionContext(ctx);

    const write = await exports.default.fetch(new Request("https://fanmap42.com/", { method: "POST" }));
    expect(write.status).toBe(405);
    await write.text();

    const hidden = await exports.default.fetch(new Request(`https://fanmap42.com/releases/${release}/pzmap.html`));
    expect(hidden.status).toBe(404);
    await hidden.text();
  });
});

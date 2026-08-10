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
const descriptorPath = "map_data/base/layer0.dzi";
const metadataPath = "map_data/base/map_info.json";
const missingMetadataPath = "map_data/base/marks.json";
const tilePath = "map_data/base/layer0_files/0/0_0.jpg";
const readyCacheKey = new Request(
  `https://fanmap42.com/__fanmap42_ready/${encodeURIComponent(release)}/${manifestHash}`,
);

function assetCacheKey(assetPath: string): Request {
  return new Request(
    `https://fanmap42.com/__fanmap42_map_compat/${encodeURIComponent(release)}/` +
    `${manifestHash}/${encodeURIComponent(assetPath)}`,
  );
}

function metricEnv(points: AnalyticsEngineDataPoint[]): Env {
  return {
    BUCKET: env.BUCKET,
    CACHE_METRICS: {
      writeDataPoint(point?: AnalyticsEngineDataPoint): void {
        if (point !== undefined) points.push(point);
      },
    },
    CF_VERSION_METADATA: env.CF_VERSION_METADATA,
    ACTIVE_RELEASE: env.ACTIVE_RELEASE,
    EXPECTED_MANIFEST_SHA256: env.EXPECTED_MANIFEST_SHA256,
    CANONICAL_HOST: env.CANONICAL_HOST,
    DIRECT_TILE_ORIGIN: env.DIRECT_TILE_ORIGIN,
    READINESS_CACHE_SECONDS: env.READINESS_CACHE_SECONDS,
    NEGATIVE_METADATA_CACHE_SECONDS: env.NEGATIVE_METADATA_CACHE_SECONDS,
  };
}

async function seedReadyRelease(): Promise<void> {
  await caches.default.delete(readyCacheKey);
  for (const path of [descriptorPath, metadataPath, missingMetadataPath]) {
    await caches.default.delete(assetCacheKey(path));
  }
  await env.BUCKET.put(
    `${prefix}/READY`,
    `release_id=${release}\nmanifest_sha256=${manifestHash}\n`,
    { httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "no-store" } },
  );
  await env.BUCKET.put(`${prefix}/${descriptorPath}`, "<Image TileSize=\"256\" />", {
    httpMetadata: { contentType: "application/xml; charset=utf-8" },
  });
  await env.BUCKET.put(`${prefix}/${metadataPath}`, JSON.stringify({ version: 1 }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.BUCKET.put(`${prefix}/${tilePath}`, "tile bytes", {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await env.BUCKET.put(`${prefix}/missing-viewer-module.js`, "must not be served", {
    httpMetadata: { contentType: "text/javascript; charset=utf-8" },
  });
  await env.BUCKET.delete(`${prefix}/${missingMetadataPath}`);
}

beforeEach(seedReadyRelease);

describe("FanMap42 compatibility Worker", () => {
  it("reports readiness from the active immutable release marker", async () => {
    const response = await exports.default.fetch(
      new Request("https://fanmap42.com/.well-known/fanmap42-health"),
    );
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
        if (property === "get") return async () => { throw new Error("synthetic R2 failure"); };
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
    await expect(response.json()).resolves.toMatchObject({ status: "not_ready", release });
    await waitOnExecutionContext(ctx);
  });

  it("gates compatibility map data but not unrelated Static Assets misses", async () => {
    await caches.default.delete(readyCacheKey);
    await env.BUCKET.delete(`${prefix}/READY`);

    const mapResponse = await exports.default.fetch(
      new Request(`https://fanmap42.com/${descriptorPath}`),
    );
    expect(mapResponse.status).toBe(503);
    expect(await mapResponse.text()).toBe("Release Not Ready");

    const staticMiss = await exports.default.fetch(
      new Request("https://fanmap42.com/missing-viewer-module.js"),
    );
    expect(staticMiss.status).toBe(404);
    expect(await staticMiss.text()).toBe("Not Found");
  });

  it("serves non-tile map metadata with conditional and HEAD support", async () => {
    const response = await exports.default.fetch(
      new Request(`https://fanmap42.com/${metadataPath}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control"))
      .toBe("public, max-age=3600, must-revalidate, s-maxage=31536000");
    expect(await response.json()).toEqual({ version: 1 });

    const head = await exports.default.fetch(new Request(`https://fanmap42.com/${metadataPath}`, {
      method: "HEAD",
    }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const conditional = await exports.default.fetch(new Request(`https://fanmap42.com/${metadataPath}`, {
      headers: { "If-None-Match": head.headers.get("etag") ?? "" },
    }));
    expect(conditional.status).toBe(304);
  });

  it("records a cold metadata miss followed by a warm cache hit", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://fanmap42.com/${descriptorPath}`),
        testEnv,
        ctx,
      );
      expect(response.status).toBe(200);
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    const cacheOutcomes = points
      .filter((point) => point.blobs?.[0] === "asset_cache_v1")
      .map((point) => point.blobs?.[1]);
    expect(cacheOutcomes).toEqual(["miss", "hit"]);
    const routeFamilies = points
      .filter((point) => point.blobs?.[0] === "site_route_v1")
      .map((point) => point.blobs?.[1]);
    expect(routeFamilies).toEqual(["map_compat", "map_compat"]);
  });

  it("negative-caches missing compatibility metadata without exposing its sentinel", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const testEnv = metricEnv(points);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`https://fanmap42.com/${missingMetadataPath}`),
        testEnv,
        ctx,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("x-fanmap42-negative-cache")).toBeNull();
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    expect(points
      .filter((point) => point.blobs?.[0] === "asset_cache_v1")
      .map((point) => point.blobs?.[1]))
      .toEqual(["miss_not_found", "negative_hit"]);
  });

  it("redirects legacy tile images to the direct CDN without reading R2", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://fanmap42.com/${tilePath}?legacy=1`),
      metricEnv([]),
      ctx,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://tiles.fanmap42.com/releases/${release}/${tilePath}?legacy=1`,
    );
    await waitOnExecutionContext(ctx);
  });

  it("answers robots locally and never resurrects missing viewer modules from R2", async () => {
    const robots = await exports.default.fetch(new Request("https://fanmap42.com/robots.txt"));
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow:\n");

    const staleViewer = await exports.default.fetch(
      new Request("https://fanmap42.com/missing-viewer-module.js"),
    );
    expect(staleViewer.status).toBe(404);
    expect(await staleViewer.text()).toBe("Not Found");
  });

  it("preserves canonical redirects and rejects writes and direct release paths", async () => {
    const redirect = await worker.fetch(
      new Request(`https://www.fanmap42.com/${metadataPath}?x=1`),
      metricEnv([]),
      createExecutionContext(),
    );
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`https://fanmap42.com/${metadataPath}?x=1`);

    const write = await exports.default.fetch(
      new Request("https://fanmap42.com/", { method: "POST" }),
    );
    expect(write.status).toBe(405);

    const hidden = await exports.default.fetch(
      new Request(`https://fanmap42.com/releases/${release}/${metadataPath}`),
    );
    expect(hidden.status).toBe(404);
  });
});

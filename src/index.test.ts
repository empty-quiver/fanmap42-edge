import { describe, expect, it } from "vitest";
import {
  cacheControlFor,
  fallbackContentType,
  isNegativeCacheableAsset,
  isNegativeCacheableMapAsset,
  isNegativeCacheableMapMetadata,
  isNegativeCacheableTile,
  isNegativeCacheableViewerAsset,
  mapFloorLayer,
  normalizeAssetPath,
  parseSingleByteRange,
  refreshPublicAssetHeaders,
  releaseSelectionForAsset,
  requestForAssetBackend,
  workersCacheKeyForAsset,
  workersCacheKeyFor,
  workersCacheOutcome,
} from "./index";

describe("normalizeAssetPath", () => {
  it("maps the site root to the viewer document", () => {
    expect(normalizeAssetPath("/")).toBe("pzmap.html");
    expect(normalizeAssetPath("/index.html")).toBe("pzmap.html");
  });

  it("keeps normal asset paths", () => {
    expect(normalizeAssetPath("/map_data/base/layer0.dzi")).toBe("map_data/base/layer0.dzi");
  });

  it("rejects traversal and direct release access", () => {
    expect(normalizeAssetPath("/%2e%2e/secret")).toBeNull();
    expect(normalizeAssetPath("/releases/other/pzmap.html")).toBeNull();
    expect(normalizeAssetPath("/%ZZ")).toBeNull();
  });
});

describe("releaseSelectionForAsset", () => {
  it("isolates staging viewer assets while keeping map data on the validated release", () => {
    const env = {
      ACTIVE_RELEASE: "full-r1",
      EXPECTED_MANIFEST_SHA256: "a".repeat(64),
      CLIENT_ASSET_RELEASE: "client-r1",
      CLIENT_ASSET_MANIFEST_SHA256: "b".repeat(64),
    } as unknown as Env;

    expect(releaseSelectionForAsset(env, "pzmap.html")).toEqual({
      release: "client-r1",
      manifestHash: "b".repeat(64),
    });
    expect(releaseSelectionForAsset(env, "map_data/base/layer0.dzi")).toEqual({
      release: "full-r1",
      manifestHash: "a".repeat(64),
    });
    expect(releaseSelectionForAsset(env, "robots.txt")).toEqual({
      release: "full-r1",
      manifestHash: "a".repeat(64),
    });
    expect(workersCacheKeyForAsset(env, "pzmap.html")).toBe(
      `/__fanmap42_asset/v1/client-r1/${"b".repeat(64)}/pzmap.html`,
    );
    expect(workersCacheKeyForAsset(env, "map_data/base/layer0.dzi")).toBe(
      `/__fanmap42_asset/v1/full-r1/${"a".repeat(64)}/map_data%2Fbase%2Flayer0.dzi`,
    );
  });
});

describe("response metadata helpers", () => {
  it("infers map MIME types", () => {
    expect(fallbackContentType("map_data/base/layer0.dzi")).toBe("application/xml; charset=utf-8");
    expect(fallbackContentType("tile.webp")).toBe("image/webp");
    expect(fallbackContentType("pzmap.js")).toBe("text/javascript; charset=utf-8");
  });

  it("requires browser revalidation while keeping long shared-edge freshness", () => {
    expect(cacheControlFor("releases/r1/pzmap.html")).toBe("public, max-age=0, must-revalidate, s-maxage=31536000");
    expect(cacheControlFor("releases/r1/pzmap_config.json")).toBe("public, max-age=0, must-revalidate, s-maxage=31536000");
    expect(cacheControlFor("releases/r1/pzmap.js")).toBe("public, max-age=3600, must-revalidate, s-maxage=31536000");
    expect(cacheControlFor("releases/r1/map_data/base/layer0.dzi")).toBe("public, max-age=3600, must-revalidate, s-maxage=31536000");
    expect(cacheControlFor("releases/r1/map_data/base/layer0_files/1/0_0.webp")).toBe("public, max-age=86400, must-revalidate, s-maxage=31536000");
  });

  it("replaces cache policy retained by a legacy cached response", async () => {
    const legacy = new Response("cached", {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
    const refreshed = refreshPublicAssetHeaders(legacy, "pzmap_config.json");

    expect(refreshed.headers.get("cache-control"))
      .toBe("public, max-age=0, must-revalidate, s-maxage=31536000");
    expect(refreshed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await refreshed.text()).toBe("cached");
  });

  it("does not make an error response cacheable", () => {
    const failure = new Response("no", { status: 503, headers: { "Cache-Control": "no-store" } });
    expect(refreshPublicAssetHeaders(failure, "pzmap_config.json")).toBe(failure);
  });
});

describe("map layer helpers", () => {
  it("parses both underground and above-ground Project Zomboid floors", () => {
    expect(mapFloorLayer("map_data/base/layer-15_files/22/579_430.webp")).toBe(-15);
    expect(mapFloorLayer("map_data/base/layer29.dzi")).toBe(29);
    expect(mapFloorLayer("map_data/base/map_info.json")).toBeNull();
  });

  it("limits negative caching to well-formed immutable map data", () => {
    expect(isNegativeCacheableTile("map_data/base/layer-15_files/22/579_430.webp")).toBe(true);
    expect(isNegativeCacheableTile("map_data/base/layer29.dzi")).toBe(false);
    expect(isNegativeCacheableMapMetadata("map_data/base/layer29.dzi")).toBe(true);
    expect(isNegativeCacheableMapMetadata("map_data/base/layer29_files/2/0_0.webp")).toBe(false);
    expect(isNegativeCacheableMapAsset("map_data/base/layer-15_files/22/579_430.webp")).toBe(true);
    expect(isNegativeCacheableMapAsset("map_data/base/layer29.dzi")).toBe(true);
    expect(isNegativeCacheableMapAsset("map_data/base/map_info.json")).toBe(true);
    expect(isNegativeCacheableMapAsset("map_data/base/marks.json")).toBe(true);
    expect(isNegativeCacheableMapAsset("pzmap.html")).toBe(false);
    expect(isNegativeCacheableMapAsset("map_data/base/not-a-tile.webp")).toBe(false);
    expect(isNegativeCacheableViewerAsset("missing-viewer.js")).toBe(true);
    expect(isNegativeCacheableViewerAsset("favicon.ico")).toBe(true);
    expect(isNegativeCacheableViewerAsset("robots.txt")).toBe(false);
    expect(isNegativeCacheableViewerAsset("map_data/base/missing.json")).toBe(false);
    expect(isNegativeCacheableAsset("missing-viewer.js")).toBe(true);
    expect(isNegativeCacheableAsset("map_data/base/layer29.dzi")).toBe(true);
    expect(isNegativeCacheableAsset("map_data/base/not-a-tile.webp")).toBe(false);
  });
});

describe("parseSingleByteRange", () => {
  it("normalizes bounded, open-ended, and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=2-5", 10)).toEqual({ offset: 2, length: 4 });
    expect(parseSingleByteRange("bytes=7-", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseSingleByteRange("bytes=-4", 10)).toEqual({ suffix: 4 });
  });

  it("rejects invalid and unsatisfiable ranges", () => {
    expect(parseSingleByteRange("bytes=10-11", 10)).toBeNull();
    expect(parseSingleByteRange("bytes=4-2", 10)).toBeNull();
    expect(parseSingleByteRange("bytes=0-1,4-5", 10)).toBeNull();
  });
});

describe("Workers Cache gateway helpers", () => {
  it("partitions the custom key by release and manifest while ignoring the request query", () => {
    expect(workersCacheKeyFor("release-r1", "a".repeat(64), "map_data/base/layer0.dzi")).toBe(
      `/__fanmap42_asset/v1/release-r1/${"a".repeat(64)}/map_data%2Fbase%2Flayer0.dzi`,
    );
    expect(workersCacheKeyFor("release-r2", "a".repeat(64), "map_data/base/layer0.dzi"))
      .not.toBe(workersCacheKeyFor("release-r1", "a".repeat(64), "map_data/base/layer0.dzi"));
    expect(workersCacheKeyFor("release-r1", "b".repeat(64), "map_data/base/layer0.dzi"))
      .not.toBe(workersCacheKeyFor("release-r1", "a".repeat(64), "map_data/base/layer0.dzi"));
  });

  it("normalizes Cloudflare cache statuses for telemetry", () => {
    expect(workersCacheOutcome("HIT")).toBe("hit");
    expect(workersCacheOutcome("revalidated")).toBe("revalidated");
    expect(workersCacheOutcome("ERROR_FALLBACK")).toBe("fallback");
    expect(workersCacheOutcome(null)).toBe("unknown");
    expect(workersCacheOutcome("DYNAMIC")).toBe("unknown");
  });

  it("strips fragmenting headers while preserving Cloudflare version routing", () => {
    const original = new Request("https://fanmap42.com/probe.txt", {
      headers: {
        Origin: "https://fragment.invalid",
        Range: "bytes=0-8",
        "If-None-Match": '"etag"',
        "X-HTTP-Method-Override": "PATCH",
        "X-Forwarded-Host": "fragment.invalid",
        "X-Original-URL": "/other",
        "Cloudflare-Workers-Version-Key": "attacker-controlled",
        "Cloudflare-Workers-Version-Overrides": 'fanmap42-site="00000000-0000-0000-0000-000000000000"',
      },
    });
    const sanitized = requestForAssetBackend(original);

    expect(sanitized.headers.get("origin")).toBeNull();
    expect(sanitized.headers.get("x-http-method-override")).toBeNull();
    expect(sanitized.headers.get("x-forwarded-host")).toBeNull();
    expect(sanitized.headers.get("x-original-url")).toBeNull();
    expect(sanitized.headers.get("cloudflare-workers-version-key")).toBe("attacker-controlled");
    expect(sanitized.headers.get("cloudflare-workers-version-overrides")).toBe(
      'fanmap42-site="00000000-0000-0000-0000-000000000000"',
    );
    expect(sanitized.headers.get("range")).toBe("bytes=0-8");
    expect(sanitized.headers.get("if-none-match")).toBe('"etag"');
  });
});

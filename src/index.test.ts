import { describe, expect, it } from "vitest";
import {
  cacheControlFor,
  directTileUrl,
  fallbackContentType,
  isCompatibilityMapAsset,
  isLegacyTileAsset,
  normalizeAssetPath,
  refreshPublicAssetHeaders,
} from "./index";

describe("normalizeAssetPath", () => {
  it("normalizes public paths", () => {
    expect(normalizeAssetPath("/")).toBe("pzmap.html");
    expect(normalizeAssetPath("/index.html")).toBe("pzmap.html");
    expect(normalizeAssetPath("/map_data/base/layer0.dzi")).toBe("map_data/base/layer0.dzi");
  });

  it("rejects traversal, invalid encoding, and direct release access", () => {
    expect(normalizeAssetPath("/%2e%2e/secret")).toBeNull();
    expect(normalizeAssetPath("/releases/other/pzmap.html")).toBeNull();
    expect(normalizeAssetPath("/%ZZ")).toBeNull();
  });
});

describe("compatibility routing", () => {
  it("routes tile images directly to the immutable tile CDN", () => {
    const tile = "map_data/base/layer-15_files/22/579_430.webp";
    expect(isLegacyTileAsset(tile)).toBe(true);
    expect(isCompatibilityMapAsset(tile)).toBe(false);
    expect(directTileUrl(
      `https://fanmap42.com/${tile}?legacy=1`,
      {
        ACTIVE_RELEASE: "local-map-r1",
        DIRECT_TILE_ORIGIN: "https://tiles.fanmap42.com",
      },
      tile,
    )).toBe(
      `https://tiles.fanmap42.com/releases/local-map-r1/${tile}?legacy=1`,
    );
  });

  it("keeps non-tile map data on the compatibility gateway", () => {
    expect(isCompatibilityMapAsset("map_data/base/layer0.dzi")).toBe(true);
    expect(isCompatibilityMapAsset("map_data/base/map_info.json")).toBe(true);
    expect(isCompatibilityMapAsset("map_data/rooms/marks.json")).toBe(true);
    expect(isCompatibilityMapAsset("pzmap.js")).toBe(false);
  });

  it("rejects a malformed direct tile origin", () => {
    expect(() => directTileUrl(
      "https://fanmap42.com/map_data/base/layer0_files/0/0_0.jpg",
      { ACTIVE_RELEASE: "local-map-r1", DIRECT_TILE_ORIGIN: "http://tiles.invalid/path" },
      "map_data/base/layer0_files/0/0_0.jpg",
    )).toThrow("DIRECT_TILE_ORIGIN");
  });
});

describe("response metadata", () => {
  it("infers map MIME types", () => {
    expect(fallbackContentType("map_data/base/layer0.dzi")).toBe("application/xml; charset=utf-8");
    expect(fallbackContentType("map_data/base/map_info.json")).toBe("application/json; charset=utf-8");
    expect(fallbackContentType("unknown.bin")).toBeUndefined();
  });

  it("keeps compatibility assets bounded in browsers and immutable at shared edge", () => {
    expect(cacheControlFor("releases/r1/map_data/base/layer0.dzi"))
      .toBe("public, max-age=3600, must-revalidate, s-maxage=31536000");
  });

  it("reasserts current cache and security policy on cached responses", async () => {
    const refreshed = refreshPublicAssetHeaders(new Response("cached", {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }), "map_data/base/map_info.json");
    expect(refreshed.headers.get("cache-control"))
      .toBe("public, max-age=3600, must-revalidate, s-maxage=31536000");
    expect(refreshed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await refreshed.text()).toBe("cached");
  });
});

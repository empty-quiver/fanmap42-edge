import { describe, expect, it } from "vitest";
import {
  CACHE_METRIC_SCHEMA,
  MAX_METRIC_ASSET_PATH_LENGTH,
  SITE_ROUTE_METRIC_SCHEMA,
  assetMetricDimensions,
  buildAssetCacheMetricDataPoint,
  buildSiteRouteMetricDataPoint,
} from "./cache-metrics";

const workerVersion = {
  workerVersionId: "11111111-1111-4111-8111-111111111111",
  workerVersionTag: "cache-candidate",
};

describe("assetMetricDimensions", () => {
  it("classifies map tiles and descriptors", () => {
    expect(assetMetricDimensions("map_data/base/layer16_files/19/97_62.webp")).toEqual({
      assetType: "tile",
      mapLayer: "base",
      floorLayer: "16",
      pyramidLevel: "19",
    });
    expect(assetMetricDimensions("map_data/base/layer-15_files/22/579_430.webp")).toEqual({
      assetType: "tile",
      mapLayer: "base",
      floorLayer: "-15",
      pyramidLevel: "22",
    });
    expect(assetMetricDimensions("map_data/zombie_top/layer0.dzi")).toEqual({
      assetType: "descriptor",
      mapLayer: "zombie_top",
      floorLayer: "0",
      pyramidLevel: "",
    });
  });

  it("classifies viewer and miscellaneous assets", () => {
    expect(assetMetricDimensions("pzmap.html")).toEqual({
      assetType: "viewer_html",
      mapLayer: "",
      floorLayer: "",
      pyramidLevel: "",
    });
    expect(assetMetricDimensions("pzmap.js")).toEqual({
      assetType: "viewer_asset",
      mapLayer: "",
      floorLayer: "",
      pyramidLevel: "",
    });
    expect(assetMetricDimensions("other.bin")).toEqual({
      assetType: "other",
      mapLayer: "",
      floorLayer: "",
      pyramidLevel: "",
    });
  });
});

describe("buildAssetCacheMetricDataPoint", () => {
  it("records cache-hit bytes without R2 bytes", () => {
    const point = buildAssetCacheMetricDataPoint({
      ...workerVersion,
      outcome: "hit",
      method: "GET",
      hostname: "fanmap42.com",
      assetPath: "map_data/base/layer16_files/19/97_62.webp",
      colo: "BOS",
      release: "release-r1",
      status: 200,
      responseBytes: 512,
      r2Bytes: 0,
      lookupMilliseconds: 1.25,
    });

    expect(point.indexes).toEqual(["fanmap42.com|release-r1"]);
    expect(point.blobs).toEqual([
      CACHE_METRIC_SCHEMA,
      "hit",
      "GET",
      "fanmap42.com",
      "tile",
      "base",
      "16",
      "map_data/base/layer16_files/19/97_62.webp",
      "BOS",
      "release-r1",
      "200",
      "19",
      workerVersion.workerVersionId,
      workerVersion.workerVersionTag,
    ]);
    expect(point.doubles).toEqual([1, 512, 512, 0, 1.25]);
  });

  it("records R2 bytes for misses and sanitizes invalid numbers", () => {
    const point = buildAssetCacheMetricDataPoint({
      ...workerVersion,
      outcome: "miss",
      method: "GET",
      hostname: "staging.example.workers.dev",
      assetPath: "pzmap.html",
      colo: "unknown",
      release: "release-r1",
      status: 200,
      responseBytes: Number.NaN,
      r2Bytes: 1024,
      lookupMilliseconds: -1,
    });

    expect(point.doubles).toEqual([1, 0, 0, 1024, 0]);
  });

  it("records a generated client 404 body without counting it as cached bytes", () => {
    const point = buildAssetCacheMetricDataPoint({
      ...workerVersion,
      outcome: "negative_hit",
      method: "GET",
      hostname: "staging.fanmap42.com",
      assetPath: "map_data/base/layer-15_files/17/26_13.webp",
      colo: "BOS",
      release: "release-r1",
      status: 404,
      responseBytes: 9,
      r2Bytes: 0,
      lookupMilliseconds: 0.5,
    });

    expect(point.doubles).toEqual([1, 9, 0, 0, 0.5]);
  });

  it("bounds user-controlled paths to the Analytics Engine event budget", () => {
    const point = buildAssetCacheMetricDataPoint({
      ...workerVersion,
      outcome: "miss_not_found",
      method: "GET",
      hostname: "staging.fanmap42.com",
      assetPath: `missing/${"x".repeat(MAX_METRIC_ASSET_PATH_LENGTH * 2)}`,
      colo: "BOS",
      release: "release-r1",
      status: 404,
      responseBytes: 0,
      r2Bytes: 0,
      lookupMilliseconds: 1,
    });

    expect(point.blobs?.[7]).toHaveLength(MAX_METRIC_ASSET_PATH_LENGTH);
  });
});

describe("buildSiteRouteMetricDataPoint", () => {
  it("records the compatibility route family independently from R2 cache outcomes", () => {
    const point = buildSiteRouteMetricDataPoint({
      ...workerVersion,
      routeFamily: "legacy_tile_redirect",
      method: "GET",
      hostname: "staging.fanmap42.com",
      assetPath: "map_data/base/layer16_files/19/97_62.webp",
      colo: "BOS",
      release: "release-r1",
      status: 308,
    });

    expect(point.blobs).toEqual([
      SITE_ROUTE_METRIC_SCHEMA,
      "legacy_tile_redirect",
      "GET",
      "staging.fanmap42.com",
      "map_data/base/layer16_files/19/97_62.webp",
      "BOS",
      "release-r1",
      "308",
      workerVersion.workerVersionId,
      workerVersion.workerVersionTag,
    ]);
    expect(point.doubles).toEqual([1]);
  });
});

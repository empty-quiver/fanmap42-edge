export const CACHE_METRIC_SCHEMA = "asset_cache_v1";
export const SITE_ROUTE_METRIC_SCHEMA = "site_route_v1";
export const MAX_METRIC_ASSET_PATH_LENGTH = 1024;

export type AssetCacheOutcome =
  | "hit"
  | "negative_hit"
  | "miss"
  | "miss_not_found"
  | "miss_r2_error"
  | "lookup_error";

export interface AssetCacheMetricInput {
  outcome: AssetCacheOutcome;
  method: string;
  hostname: string;
  assetPath: string;
  colo: string;
  release: string;
  workerVersionId: string;
  workerVersionTag: string;
  status: number;
  responseBytes: number;
  r2Bytes: number;
  lookupMilliseconds: number;
}

export type SiteRouteFamily =
  | "canonical_redirect"
  | "health"
  | "invalid_path"
  | "legacy_tile_redirect"
  | "map_compat"
  | "method_rejected"
  | "robots"
  | "static_miss"
  | "unhandled_error";

export interface SiteRouteMetricInput {
  routeFamily: SiteRouteFamily;
  method: string;
  hostname: string;
  assetPath: string;
  colo: string;
  release: string;
  workerVersionId: string;
  workerVersionTag: string;
  status: number;
}

export interface AssetMetricDimensions {
  assetType: string;
  mapLayer: string;
  floorLayer: string;
  pyramidLevel: string;
}

export function assetMetricDimensions(assetPath: string): AssetMetricDimensions {
  const tileMatch = /^map_data\/([^/]+)\/layer(-?\d+)_files\/(\d+)\//.exec(assetPath);
  if (tileMatch !== null) {
    return {
      assetType: "tile",
      mapLayer: tileMatch[1] ?? "",
      floorLayer: tileMatch[2] ?? "",
      pyramidLevel: tileMatch[3] ?? "",
    };
  }

  const mapMatch = /^map_data\/([^/]+)\//.exec(assetPath);
  const descriptorMatch = /^map_data\/([^/]+)\/layer(-?\d+)\.dzi$/.exec(assetPath);
  const mapLayer = mapMatch?.[1] ?? "";

  if (mapLayer !== "") {
    if (descriptorMatch !== null) {
      return {
        assetType: "descriptor",
        mapLayer,
        floorLayer: descriptorMatch[2] ?? "",
        pyramidLevel: "",
      };
    }
    return { assetType: "map_metadata", mapLayer, floorLayer: "", pyramidLevel: "" };
  }

  if (assetPath === "pzmap.html") {
    return { assetType: "viewer_html", mapLayer: "", floorLayer: "", pyramidLevel: "" };
  }
  if (assetPath.startsWith("pzmap") || assetPath === "favicon.ico") {
    return { assetType: "viewer_asset", mapLayer: "", floorLayer: "", pyramidLevel: "" };
  }
  if (assetPath === "robots.txt") {
    return { assetType: "robots", mapLayer: "", floorLayer: "", pyramidLevel: "" };
  }
  return { assetType: "other", mapLayer: "", floorLayer: "", pyramidLevel: "" };
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Analytics Engine fields for asset_cache_v1:
 * index1: hostname|release
 * blob1..14: schema, outcome, method, hostname, asset type, map dataset,
 *             Project Zomboid floor layer, asset path, Cloudflare colo,
 *             release, response status, Deep Zoom pyramid level,
 *             Worker version ID, Worker version tag
 * double1..5: requests, response bytes, cache-hit bytes,
 *             R2 bytes for cache-eligible full-GET misses, lookup ms
 */
export function buildAssetCacheMetricDataPoint(input: AssetCacheMetricInput): AnalyticsEngineDataPoint {
  const dimensions = assetMetricDimensions(input.assetPath);
  const responseBytes = nonNegativeFinite(input.responseBytes);
  const r2Bytes = nonNegativeFinite(input.r2Bytes);
  const lookupMilliseconds = nonNegativeFinite(input.lookupMilliseconds);

  return {
    indexes: [`${input.hostname}|${input.release}`],
    blobs: [
      CACHE_METRIC_SCHEMA,
      input.outcome,
      input.method,
      input.hostname,
      dimensions.assetType,
      dimensions.mapLayer,
      dimensions.floorLayer,
      input.assetPath.slice(0, MAX_METRIC_ASSET_PATH_LENGTH),
      input.colo,
      input.release,
      String(input.status),
      dimensions.pyramidLevel,
      input.workerVersionId,
      input.workerVersionTag,
    ],
    doubles: [
      1,
      responseBytes,
      input.outcome === "hit" ? responseBytes : 0,
      r2Bytes,
      lookupMilliseconds,
    ],
  };
}

export function writeAssetCacheMetric(
  dataset: AnalyticsEngineDataset,
  input: AssetCacheMetricInput,
): void {
  try {
    dataset.writeDataPoint(buildAssetCacheMetricDataPoint(input));
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "cache metric write failed",
      outcome: input.outcome,
      path: input.assetPath.slice(0, MAX_METRIC_ASSET_PATH_LENGTH),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Analytics Engine fields for site_route_v1:
 * index1: hostname|release
 * blob1..10: schema, route family, method, hostname, asset path, Cloudflare
 *             colo, release, response status, Worker version ID, version tag
 * double1: requests
 */
export function buildSiteRouteMetricDataPoint(
  input: SiteRouteMetricInput,
): AnalyticsEngineDataPoint {
  return {
    indexes: [`${input.hostname}|${input.release}`],
    blobs: [
      SITE_ROUTE_METRIC_SCHEMA,
      input.routeFamily,
      input.method,
      input.hostname,
      input.assetPath.slice(0, MAX_METRIC_ASSET_PATH_LENGTH),
      input.colo,
      input.release,
      String(input.status),
      input.workerVersionId,
      input.workerVersionTag,
    ],
    doubles: [1],
  };
}

export function writeSiteRouteMetric(
  dataset: AnalyticsEngineDataset,
  input: SiteRouteMetricInput,
): void {
  try {
    dataset.writeDataPoint(buildSiteRouteMetricDataPoint(input));
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "site route metric write failed",
      route_family: input.routeFamily,
      path: input.assetPath.slice(0, MAX_METRIC_ASSET_PATH_LENGTH),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

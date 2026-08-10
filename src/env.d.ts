interface FanMap42Env {
  BUCKET: R2Bucket;
  CACHE_METRICS: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  ASSETS?: Fetcher;
  ACTIVE_RELEASE: string;
  EXPECTED_MANIFEST_SHA256: string;
  CLIENT_ASSET_RELEASE: string;
  CLIENT_ASSET_MANIFEST_SHA256: string;
  CANONICAL_HOST: string;
  USE_WORKERS_CACHE_GATEWAY: string;
  READINESS_CACHE_SECONDS: string;
  NEGATIVE_TILE_CACHE_SECONDS: string;
  NEGATIVE_METADATA_CACHE_SECONDS: string;
  NEGATIVE_VIEWER_ASSET_CACHE_SECONDS: string;
  ENFORCE_MAP_LAYER_BOUNDS: string;
  MAP_LAYER_MIN: string;
  MAP_LAYER_MAX_EXCLUSIVE: string;
}

declare namespace Cloudflare {
  interface Env extends FanMap42Env {}

  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}

interface Env extends FanMap42Env {}

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACTIVE_RELEASE: "pilot-b42.20-steam24574865-pzmap53b73b8-fma485d32-r1",
          EXPECTED_MANIFEST_SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          CLIENT_ASSET_RELEASE: "pilot-client-r1",
          CLIENT_ASSET_MANIFEST_SHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          CANONICAL_HOST: "fanmap42.com",
        },
      },
    }),
  ],
});

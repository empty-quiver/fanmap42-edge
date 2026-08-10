# FanMap42 edge

Cloudflare configuration and release tooling for
[fanmap42.com](https://fanmap42.com).

## What runs in production

- `fanmap42-site` is the map viewer. It is a Workers Static Assets site with no
  Worker runtime code.
- `tiles.fanmap42.com` is the R2 custom domain for versioned map releases.
- `fanmap42-hottiles` is a Workers Static Assets bundle containing a subset of
  popular tiles.
- `fanmap42-www-redirect` redirects `www.fanmap42.com` to the main hostname.

Map releases are immutable directories in R2. The viewer reads manifests that
tell it which tiles exist, which release contains a tile, and which tiles are
available from hottiles. Tiles not included in hottiles are fetched from R2.

## Repository contents

- `site/` describes the viewer bundle and retained client releases.
- `hottiles/` describes the hottiles bundle.
- `releases.json` lists the map releases served by the tile CDN.
- `scripts/` contains the builders for those bundles.
- `infra/terraform/` describes the persistent Cloudflare resources around the
  tile origin.
- `wrangler*.jsonc` contains the local and production Worker configuration.

The built bundles are written to `.generated/` and are not committed. Viewer
and renderer source belong in the PZMap fork, not this repository.

## Local development

Node.js 24 or newer is required.

```sh
npm ci
npm run check
```

Build and run the viewer from assembled viewer and map-release directories:

```sh
npm run build:site -- \
  --source /path/to/assembled/viewer \
  --map-source /path/to/map/release
npm run dev
```

Build hottiles from a rendered `map_data` directory:

```sh
npm run build:hottiles -- --source /path/to/render/html/map_data
```

Both builders validate their inputs and write a new bundle locally. They do not
upload or deploy it.

## Deployment configuration

Production builds use the committed files in `site/` and `hottiles/`. Wrangler
publishes the resulting Static Assets bundles and controls Worker versions and
traffic percentages. Terraform describes the R2 bucket and zone-level behavior;
see [infra/terraform/README.md](infra/terraform/README.md).

The `release:*:upload` commands upload a new Worker version without assigning
traffic. Traffic changes are deliberately separate.

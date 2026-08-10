# FanMap42 edge

Cloudflare delivery infrastructure for [FanMap42](https://fanmap42.com).

## Architecture

- `fanmap42-site` serves the viewer entirely from Workers Static Assets.
- `tiles.fanmap42.com` serves immutable map releases from R2.
- `fanmap42-hottiles` serves a curated set of frequently requested tiles from
  Workers Static Assets.
- `fanmap42-www-redirect` redirects the `www` hostname to the canonical site.

The site Worker has no runtime script or bindings. The viewer, its modules, and
the retained client releases are uploaded together as a versioned Static Assets
bundle. Map data is addressed by immutable release-qualified URLs and does not
pass through the site Worker.

Hottiles is a performance layer rather than a second map store. Its manifest
identifies the objects copied from the active map release, and the viewer sends
only those requests to `hottiles.fanmap42.com`. Everything else goes directly
to `tiles.fanmap42.com`. The R2 release remains the source of truth.

Before OpenSeadragon starts, the viewer loads:

1. a tile-existence manifest, which prevents requests for absent tiles;
2. a routing index, which maps patched content to its immutable release; and
3. a hot-tile manifest, which selects the hottiles origin.

## Repository layout

- `site/`: production viewer build configuration
- `hottiles/`: production hottiles manifest and build configuration
- `scripts/`: deterministic site and hottiles builders
- `infra/terraform/`: long-lived Cloudflare account and zone configuration
- `wrangler*.jsonc`: local and production Worker release configuration

Generated site and hottiles bundles live under `.generated/` and are not
committed. Renderer and viewer source live in the separate PZMap fork.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
```

### Build the viewer site

The committed [site build configuration](site/production.json) records the
active client and map releases. Build it from an assembled viewer release:

```sh
npm run build:site -- --source /path/to/assembled/viewer
npm run dev
```

The builder verifies release metadata and asset manifests, retains the client
releases needed by active sessions, and atomically creates
`.generated/site/production`. It refuses to overwrite an existing bundle.

### Build hottiles

The committed [hottiles configuration](hottiles/production.json) and manifest
define the bundle. The source must be a rendered `map_data` tree.

```sh
npm run build:hottiles -- --source /path/to/render/html/map_data
```

The builder validates the manifest, copies the selected assets in parallel,
and atomically creates `.generated/hottiles/production`. Building never uploads
or deploys anything.

## Releases

The default Wrangler configuration is local-only. Production commands use an
explicit production configuration so an unqualified command cannot affect the
live site.

Production releases are uploaded as 0%-traffic Worker versions, tested on the
production hostname with a version override, and then promoted through gradual
deployments. Viewer and hottiles releases are independent deployables, but both
are assembled from committed configuration and immutable inputs.

Small compatibility redirects remain for old same-origin map URLs. They are not
part of the normal viewer path; current clients use release-qualified tile URLs
directly.

## Infrastructure ownership

Wrangler owns versioned Worker artifacts and traffic percentages. Terraform
owns stable account and zone resources such as rulesets, tiered cache, and the
R2 bucket. See [infra/terraform/README.md](infra/terraform/README.md) for the
current ownership boundary and reconciliation workflow.

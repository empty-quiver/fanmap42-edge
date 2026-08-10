# FanMap42 edge

Cloudflare Workers and edge configuration for [FanMap42](https://fanmap42.com).

## Components

- `fanmap42-site`: viewer Static Assets plus a small legacy map-data gateway
- `fanmap42-hottiles`: selected immutable tiles served as Static Assets
- `fanmap42-www-redirect`: canonical-host redirect
- `infra/terraform`: import-first Cloudflare infrastructure baseline

Generated viewer releases and tile bundles live under `.generated/` and are not
committed. The renderer and viewer source live in the separate PZMap fork.

## Request flow

The current viewer does not send ordinary tile traffic through `fanmap42-site`.
It loads three client-side indexes before OpenSeadragon starts:

1. The full tile-existence manifest suppresses requests for absent tiles.
2. The routing index can move patched tiles to another immutable release.
3. The hot-tile manifest selects URLs to rewrite to `hottiles.fanmap42.com`.

`fanmap42-hottiles` has no Worker script. It is a Static Assets bundle containing
exactly the files named by its manifest. If a hottiles request fails, the viewer
retries the same release path at `tiles.fanmap42.com`; tiles not in the hot
manifest go there directly.

Matching viewer assets on `fanmap42.com` are also served before Worker code. The
site Worker is therefore limited to health checks, non-tile `/map_data/`
compatibility requests, locally generated `robots.txt`, and redirects for legacy
same-origin tile URLs. Other Static Assets misses return 404 without probing R2.

### Static-only target

The site can drop its Worker entirely once every supported viewer loads
`/map_data/` metadata from the release-qualified tile origin. Before that
cutover, verify the metadata redirects, CORS, conditional requests, and error
behavior on a 0%-traffic production candidate, then confirm route telemetry no
longer shows a required `map_compat` request. At that point `robots.txt` and the health
document become ordinary assets, the legacy tile redirect moves to an edge
redirect rule, and the site configuration can remove `main`, R2, Analytics
Engine, version metadata, and all Worker variables.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
npm run dev
```

### Building hottiles

The committed manifest and [build configuration](hottiles/production.json) are
the source of truth for the production bundle. The source directory must be a
rendered `map_data` tree containing paths such as
`base/layer0_files/0/0_0.jpg`.

```sh
npm run build:hottiles -- --source /path/to/render/html/map_data
```

The build validates the manifest hash and asset limits, copies in parallel, and
atomically creates `.generated/hottiles/production`. It refuses to overwrite an
existing bundle. Building does not upload or deploy anything.

Wrangler's default configuration is local-only. Production uses explicit
configuration files so an unqualified command cannot target it. Release
candidates are uploaded as 0%-traffic Worker versions and promoted through the
same production route only after validation.

## Infrastructure

Terraform adoption is intentionally import-first. Existing Cloudflare resources
must be represented, imported, and shown as a zero-change plan before Terraform
is allowed to manage them. Worker releases remain outside Terraform until the
deployment workflow is reconciled.

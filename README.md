# FanMap42 edge

Cloudflare Workers and edge configuration for [FanMap42](https://fanmap42.com).

## Components

- `fanmap42-site`: viewer served entirely by Workers Static Assets
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

`fanmap42-site` also has no Worker script or bindings. Root viewer files and the
retained immutable client releases are Static Assets. Every supported viewer
loads map metadata and tiles from a release-qualified path on
`tiles.fanmap42.com`. A generated Static Assets redirect sends legacy
same-origin `/map_data/*` requests to the current release-qualified tile origin,
without invoking code or probing R2 through the site. Other missing assets
return 404. `robots.txt` and `/.well-known/fanmap42-health` are generated static
files; other legacy URL behavior belongs in the zone redirect rules.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
```

### Building the site

The committed [site build configuration](site/production.json) records the
current client and map releases. Build from an assembled viewer release:

```sh
npm run build:site -- --source /path/to/assembled/viewer
npm run dev
```

The build verifies the root manifest, release metadata, retained r6/r7/r8
clients, and each release-qualified map route. It also generates the temporary
legacy map-data redirect, health document, and robots file. It atomically creates
`.generated/site/production` and refuses to overwrite an existing bundle. The
production Wrangler configuration contains only Static Assets and the custom
domain: it has no script, R2 binding, Analytics Engine binding, variables, or
version-metadata binding.

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

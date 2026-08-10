# FanMap42 edge

Cloudflare configuration and release tooling for
[fanmap42.com](https://fanmap42.com).

## Architecture

FanMap42 separates the small viewer application from the much larger rendered
map:

```text
                                  +-> hottiles.fanmap42.com -> Static Assets hot set
browser -> fanmap42.com ----------+
          Static Assets viewer    +-> tiles.fanmap42.com ----> CDN cache -> R2
                                                               complete map
```

- `fanmap42-site` serves the viewer from Workers Static Assets. Successful
  viewer requests do not execute Worker code.
- `fanmap42-hottiles` serves a selected working set of map tiles from a second
  Static Assets bundle.
- `tiles.fanmap42.com` is the R2 custom domain. R2 holds every tile in every
  retained map release and is the authoritative fallback.
- `fanmap42-www-redirect` is the only request-handling Worker. It preserves the
  path and query while redirecting `www.fanmap42.com` to the main hostname.

Map releases are immutable directories in R2. The viewer reads manifests that
tell it which tiles exist, which release contains each tile, and which tiles
are duplicated in hottiles. This lets the browser choose the correct URL before
making a request:

1. The tile-existence manifest suppresses requests for known gaps in the sparse
   map.
2. The routing index selects a different immutable release when a tile was
   replaced by a patch release.
3. The hottiles manifest sends included tiles to `hottiles.fanmap42.com`.
4. Every other existing tile is requested from `tiles.fanmap42.com`.

If a tile selected for hottiles is unavailable there, the viewer retries it
against the complete R2 release. Hottiles can therefore be replaced or rolled
out independently without becoming the only copy of any map data.

### Why hottiles exists

Hottiles is primarily a cost optimization. Cloudflare documents
[Static Asset requests as free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
with no additional charge for storing the assets. A request served by our
hottiles bundle therefore incurs neither a billed Worker invocation nor an R2
read operation.

The complete map cannot use that delivery path. It contains millions of files,
while a Workers Paid deployment is limited to
[100,000 Static Asset files per Worker version](https://developers.cloudflare.com/workers/platform/limits/#static-assets).
R2 is consequently still the right home for the full map, but R2 charges for
read operations after its included usage. The CDN cache prevents many origin
reads, although cold misses still occur across locations and after a new map
release.

Traffic is not spread evenly across the map. Overview levels and a relatively
small collection of popular deep tiles receive a large share of requests.
Hottiles uses the 100,000-file allowance for that working set instead of trying
to fit the whole map. Those requests stay on the free Static Assets path, while
the long tail continues through the CDN-backed R2 origin.

The bundle is generated from an explicit manifest. The viewer routes a request
to hottiles only when that manifest says the exact release-qualified tile is in
the bundle, so an intentionally partial hot set does not create holes. During a
release transition the bundle can also retain tiles for older clients until
their traffic has drained.

Hottiles is intentionally:

- **static**: it contains tile bytes, not proxy code;
- **partial**: absence means “use R2,” not “the tile does not exist”;
- **versioned**: its paths match immutable R2 release paths;
- **replaceable**: its contents can change independently of the full map.

The committed hot-set selection for the active release is defined by
[`hottiles/production.json`](hottiles/production.json) and
[`hottiles/hot-tile-existence-v1.json`](hottiles/hot-tile-existence-v1.json).

### Cache behavior

Release-qualified viewer assets and map tiles are immutable and receive long
browser and edge cache lifetimes. Stable viewer entry points remain
revalidatable so a new client release can take effect without cache-busting
URLs.

For direct R2 traffic, Cloudflare strips query strings from immutable tile URLs
before cache lookup, uses Smart Tiered Cache, and caches known `404`/`410`
responses. The client-side existence manifest prevents most missing-tile
requests; negative edge caching handles older clients and any gaps the client
cannot classify. Server errors are not cached.

Together, these layers keep the common path on Static Assets or in Cloudflare's
cache, avoid Worker runtime execution for the viewer and tiles, and reserve R2
reads for tiles that are both valid and not already warm.

## Repository contents

- `site/` describes the viewer bundle and retained client releases.
- `hottiles/` describes the hottiles bundle.
- `releases.json` lists the immutable map releases covered by the tile CDN
  rules and identifies the active release.
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

Build the site from the assembled release, the matching PZMap viewer source,
and the map-release metadata:

```sh
npm run build:site -- \
  --source /path/to/assembled/viewer \
  --map-source /path/to/map/release \
  --viewer-source /path/to/pzmap2dzi/html
npm run dev
```

The site builder renders the active release prefix into the canonical
`pzmap.html`, verifies every source-controlled viewer asset against both the
root and immutable `_client/<release>/` copies, and then writes those assets
into the bundle. Retained older clients remain immutable inputs.

`site/production.json` records the canonical renderer and viewer commits. If
an immutable release was assembled before its source history was reconciled,
`release_provenance` separately records the commit IDs frozen into that
release's `RELEASE.json`.

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

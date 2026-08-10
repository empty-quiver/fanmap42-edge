# FanMap42 edge

Cloudflare Workers and edge configuration for [FanMap42](https://fanmap42.com).

## Components

- `fanmap42-site`: release-aware viewer and R2 asset gateway
- `fanmap42-hottiles`: static hot-tile bundles for staging and production
- `fanmap42-www-redirect`: canonical-host redirect
- `infra/terraform`: import-first Cloudflare infrastructure baseline

Generated viewer releases and tile bundles live under `.generated/` and are not
committed. The renderer and viewer source live in the separate PZMap fork.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
npm run dev
```

Wrangler's default configuration is local-only. Production and staging use
explicit configuration files so an unqualified command cannot target them.

## Infrastructure

Terraform adoption is intentionally import-first. Existing Cloudflare resources
must be represented, imported, and shown as a zero-change plan before Terraform
is allowed to manage them. Worker releases remain outside Terraform until the
deployment workflow is reconciled.

# Terraform

This directory describes the Cloudflare resources that sit between clients and
FanMap42's R2 tile bucket. Its purpose is to make map delivery cheap and
predictable while leaving Worker releases to Wrangler.

## Intended behavior

Map releases use immutable paths. Cloudflare can therefore cache successful
tile responses without checking R2 again. Smart Tiered Cache reduces duplicate
origin reads across edge locations, and query strings are removed from tile
cache keys so equivalent requests share the same cached object.

Missing tiles are expected in a sparse map. The cache rules retain `404` and
`410` responses for 30 days, which prevents repeated R2 lookups for known gaps.
Server errors are not cached.

Gradual Worker deployments use a version-affinity header derived from the
client IP. That keeps a client on one version during a rollout instead of
moving it between candidates on successive requests.

A redirect ruleset keeps old same-origin tile URLs working by sending them to
the corresponding immutable R2 release. Current viewers already request
release-qualified URLs, so this rule is only for older links and clients.

The R2 bucket has deletion protection because it contains the canonical map
releases. The import blocks associate the declarations here with resources
that already existed in Cloudflare; they are not instructions to recreate
those resources.

## Scope

Terraform covers the `fanmap42` R2 bucket, tiered cache, cache settings, tile
URL normalization, Worker version affinity, and the remaining tile redirect.

The releases receiving tile cache rules come from the repository-level
`releases.json`.

It does not build or publish `fanmap42-site`, `fanmap42-hottiles`, or
`fanmap42-www-redirect`. Those are versioned Static Assets/Worker releases
managed with Wrangler.

Provider 5.22 cannot import an existing R2 CORS policy or custom domain. CORS is
therefore kept in `r2-cors.json` and applied with Wrangler, while the existing
`tiles.fanmap42.com` attachment remains outside Terraform state.

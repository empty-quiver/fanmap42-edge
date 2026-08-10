# Terraform

This directory owns importable, stable account and zone configuration:

- zone rulesets
- Smart Tiered Cache
- R2 bucket definitions

Wrangler owns Worker code, bindings, custom domains, routes, deployments, and
traffic percentages. R2 CORS and custom domains also remain outside Terraform
because provider v5.22 cannot import them safely.

Before adding any existing resource:

1. Declare it with the current Cloudflare provider schema.
2. Import the existing resource into remote state.
3. Require a reviewed, zero-change plan.
4. Add `prevent_destroy` where replacement would interrupt production.

Use `CLOUDFLARE_API_TOKEN` for authentication and keep all state, credentials,
and real `.tfvars` files outside Git. The committed import blocks adopt the
existing resources; they do not create new Cloudflare objects.

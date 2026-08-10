# Terraform

This directory will own stable account and zone configuration. Worker versions
and traffic percentages are not managed here yet.

Before adding any existing resource:

1. Declare it with the current Cloudflare provider schema.
2. Import the existing resource into remote state.
3. Require a reviewed, zero-change plan.
4. Add `prevent_destroy` where replacement would interrupt production.

Use `CLOUDFLARE_API_TOKEN` for authentication and keep all state, credentials,
and real `.tfvars` files outside Git.

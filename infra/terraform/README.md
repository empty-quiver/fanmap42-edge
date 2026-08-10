# Terraform

Terraform describes FanMap42's long-lived Cloudflare account and zone
configuration. Worker artifacts remain versioned release outputs managed by
Wrangler.

## Current ownership

Terraform currently declares:

- the `fanmap42` R2 bucket;
- Smart Tiered Cache;
- cache settings for immutable map releases;
- tile URL normalization rules;
- Worker version-affinity headers used during gradual deployments; and
- the small set of zone redirects that remain outside the viewer bundle.

Wrangler owns:

- `fanmap42-site`, `fanmap42-hottiles`, and `fanmap42-www-redirect` artifacts;
- Workers Static Assets uploads;
- Worker custom domains and routes; and
- version deployments and traffic percentages.

R2 CORS and custom-domain settings are still configured outside this Terraform
state. The pinned Cloudflare provider supports `cloudflare_r2_bucket_cors` and
`cloudflare_r2_custom_domain`, so these can be adopted later with the same
import-and-no-op-plan process; they are no longer excluded as provider gaps.

## Reconciliation workflow

Most resources existed before this repository. Import blocks associate those
objects with their declarations without creating replacements.

```sh
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -var-file=/path/to/fanmap42.tfvars
```

Before Terraform is allowed to apply changes to an existing resource:

1. update its declaration to match production;
2. import it into state;
3. review a zero-change plan; and
4. protect resources whose replacement would interrupt production.

The current reconciliation state is local and ignored by Git. Move it to a
remote encrypted backend before enabling automated plans or applies. Use
`CLOUDFLARE_API_TOKEN` for authentication and keep credentials and real
`.tfvars` files out of the repository.

Terraform changes do not publish viewer or hottiles releases. Those continue
through the tested Wrangler version and gradual-deployment workflow.

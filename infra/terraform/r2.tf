resource "cloudflare_r2_bucket" "production" {
  account_id    = var.cloudflare_account_id
  name          = "fanmap42"
  jurisdiction  = "default"
  location      = "enam"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "staging_fixture" {
  account_id    = var.cloudflare_account_id
  name          = "fanmap42-staging-fixture"
  jurisdiction  = "default"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

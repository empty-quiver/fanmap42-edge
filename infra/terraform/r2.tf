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

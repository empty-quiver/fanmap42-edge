locals {
  worker_names = {
    site        = "fanmap42-site"
    staging     = "fanmap42-site-staging"
    hottiles    = "fanmap42-hottiles"
    redirect    = "fanmap42-www-redirect"
  }

  managed_domains = [
    "fanmap42.com",
    "www.fanmap42.com",
    "staging.fanmap42.com",
    "hottiles.fanmap42.com",
    "hottiles-staging.fanmap42.com",
    "tiles.fanmap42.com",
    "tiles-staging.fanmap42.com",
  ]
}

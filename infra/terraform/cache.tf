resource "cloudflare_tiered_cache" "fanmap42" {
  zone_id = var.cloudflare_zone_id
  value   = "on"
}

resource "cloudflare_ruleset" "cache_settings" {
  zone_id = var.cloudflare_zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [
    {
      action      = "set_cache_settings"
      description = "Cache immutable R2 tile origin"
      enabled     = true
      expression  = "(http.host eq \"tiles.fanmap42.com\" and (${local.immutable_tile_path_expression}))"
      ref         = "35a215b7ccd14ba1acb5c2f1f991b000"
      action_parameters = {
        cache = true
        edge_ttl = {
          # Successful tile TTL comes from Cache-Control stored on each R2 object.
          mode = "respect_origin"
          status_code_ttl = [
            { status_code = 404, value = 2592000 },
            { status_code = 410, value = 2592000 },
            { status_code_range = { from = 500, to = 599 }, value = -1 },
          ]
        }
      }
    },
  ]
}

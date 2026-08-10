resource "cloudflare_ruleset" "legacy_tile_redirects" {
  zone_id     = var.cloudflare_zone_id
  name        = "FanMap42 legacy tile redirects"
  description = "Route legacy same-origin map tiles directly to immutable R2 custom domains"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      action      = "redirect"
      description = "FanMap42 staging legacy map_data to direct tile CDN"
      enabled     = true
      expression  = "(http.host eq \"staging.fanmap42.com\" and http.request.method in {\"GET\" \"HEAD\"} and starts_with(http.request.uri.path, \"/map_data/\") and http.request.uri.path contains \"_files/\" and (ends_with(http.request.uri.path, \".webp\") or ends_with(http.request.uri.path, \".png\") or ends_with(http.request.uri.path, \".jpg\") or ends_with(http.request.uri.path, \".jpeg\")))"
      ref         = "197f27780e784e72bfe3c0a8820e701f"
      action_parameters = {
        from_value = {
          preserve_query_string = false
          status_code           = 308
          target_url = {
            expression = "concat(\"https://tiles-staging.fanmap42.com/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1\", http.request.uri.path)"
          }
        }
      }
    },
    {
      action      = "redirect"
      description = "FanMap42 legacy map_data to direct tile CDN"
      enabled     = true
      expression  = "(http.host eq \"fanmap42.com\" and http.request.method in {\"GET\" \"HEAD\"} and starts_with(http.request.uri.path, \"/map_data/\") and http.request.uri.path contains \"_files/\" and (ends_with(http.request.uri.path, \".webp\") or ends_with(http.request.uri.path, \".png\") or ends_with(http.request.uri.path, \".jpg\") or ends_with(http.request.uri.path, \".jpeg\")))"
      ref         = "71f2a19961b7434db4452dfde19b3af3"
      action_parameters = {
        from_value = {
          preserve_query_string = false
          status_code           = 308
          target_url = {
            expression = "concat(\"https://tiles.fanmap42.com/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

resource "cloudflare_ruleset" "worker_version_affinity" {
  zone_id = var.cloudflare_zone_id
  name    = "default"
  kind    = "zone"
  phase   = "http_request_late_transform"

  rules = [
    {
      action      = "rewrite"
      description = "FanMap42 Worker version affinity by IP"
      enabled     = true
      expression  = "(http.host eq \"fanmap42.com\")"
      ref         = "fe1150d24aaf4228be28d2ce7e1ffeb4"
      action_parameters = {
        headers = {
          Cloudflare-Workers-Version-Key = {
            expression = "ip.src"
            operation  = "set"
          }
        }
      }
    },
  ]
}

resource "cloudflare_ruleset" "tile_uri_normalization" {
  zone_id     = var.cloudflare_zone_id
  name        = "FanMap42 immutable tile URI normalization"
  description = "Canonicalize immutable tile URLs before cache lookup"
  kind        = "zone"
  phase       = "http_request_transform"

  rules = [
    {
      action      = "rewrite"
      description = "Staging immutable R2 tiles: strip query string"
      enabled     = true
      expression  = "(http.host eq \"tiles-staging.fanmap42.com\" and (starts_with(http.request.uri.path, \"/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1/map_data/\") or starts_with(http.request.uri.path, \"/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1-treeclip1/map_data/\")) and http.request.uri.query ne \"\")"
      ref         = "06ef773935dc49dabcc171cb7521fe34"
      action_parameters = {
        uri = {
          query = { value = "" }
        }
      }
    },
    {
      action      = "rewrite"
      description = "Immutable R2 tiles: strip query string"
      enabled     = true
      expression  = "(http.host eq \"tiles.fanmap42.com\" and (starts_with(http.request.uri.path, \"/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1/map_data/\") or starts_with(http.request.uri.path, \"/releases/b42.20-steam24574865-pzmap53b73b8-fma485d32-r1-treeclip1/map_data/\")) and http.request.uri.query ne \"\")"
      ref         = "447b45a3552140ed82983b15ebbea2ea"
      action_parameters = {
        uri = {
          query = { value = "" }
        }
      }
    },
  ]
}

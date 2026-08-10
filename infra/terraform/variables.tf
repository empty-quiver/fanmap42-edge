variable "cloudflare_account_id" {
  description = "Cloudflare account containing the FanMap42 Workers and R2 bucket."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for fanmap42.com."
  type        = string
  sensitive   = true
}

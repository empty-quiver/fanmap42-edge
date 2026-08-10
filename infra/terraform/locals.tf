locals {
  release_config          = jsondecode(file("${path.module}/../../releases.json"))
  immutable_tile_releases = local.release_config.tile_releases

  immutable_tile_path_expression = join(" or ", [
    for release in local.immutable_tile_releases :
    "starts_with(http.request.uri.path, \"/releases/${release}/map_data/\")"
  ])
}

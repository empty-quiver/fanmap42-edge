import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expandTileManifest } from "./build-hottiles.mjs";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const releasePattern = /^[A-Za-z0-9._-]+$/;
const hashPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateProvenance(value, label) {
  invariant(hashPattern.test(value?.source_appmanifest_sha256),
    `Invalid ${label} source appmanifest hash`);
  invariant(commitPattern.test(value?.renderer_upstream_commit),
    `Invalid ${label} renderer upstream commit`);
  invariant(commitPattern.test(value?.render_commit), `Invalid ${label} render commit`);
  invariant(commitPattern.test(value?.viewer_commit), `Invalid ${label} viewer commit`);
  invariant(hashPattern.test(value?.tree_render_manifest_sha256),
    `Invalid ${label} tree render manifest hash`);
}

const releases = await readJson("releases.json");
const site = await readJson("site/production.json");
const hottiles = await readJson("hottiles/production.json");
const hotManifestBytes = await readFile(new URL(`hottiles/${hottiles.manifest}`, root));
const hotManifest = JSON.parse(hotManifestBytes);

invariant(releases.schema === "fanmap42.edge-releases.v1", "Unsupported release configuration");
invariant(releasePattern.test(releases.active_map_release), "Invalid active map release");
invariant(Array.isArray(releases.tile_releases) && releases.tile_releases.length > 0,
  "tile_releases must not be empty");
invariant(new Set(releases.tile_releases).size === releases.tile_releases.length,
  "tile_releases contains duplicates");
invariant(releases.tile_releases.every((release) => releasePattern.test(release)),
  "tile_releases contains an invalid release ID");
invariant(releases.tile_releases.includes(releases.active_map_release),
  "The active map release is not cache-enabled");

invariant(site.map_release === releases.active_map_release,
  "The site and edge release configuration disagree");
invariant(hottiles.release === releases.active_map_release,
  "The hottiles and edge release configuration disagree");
invariant(hotManifest.release === releases.active_map_release,
  "The hottiles manifest targets the wrong release");
invariant(sha256(hotManifestBytes) === hottiles.manifest_sha256,
  "The hottiles manifest hash does not match production.json");
invariant(Number.isSafeInteger(hotManifest.tile_count) && hotManifest.tile_count > 0,
  "The hottiles manifest has no tiles");
invariant(hotManifest.source_count === Object.keys(hotManifest.sources ?? {}).length,
  "The hottiles manifest source count is wrong");
const hotTilePaths = expandTileManifest(hotManifest, hottiles.extensions);
invariant(hotTilePaths.length === hotManifest.tile_count,
  "The hottiles manifest tile count is wrong");

invariant(site.supported_clients?.[site.client_release] === site.map_release,
  "The active client is not mapped to the active map release");
for (const [client, release] of Object.entries(site.supported_clients ?? {})) {
  invariant(releasePattern.test(client), `Invalid supported client: ${client}`);
  invariant(releases.tile_releases.includes(release),
    `Supported client ${client} uses an undeclared map release`);
}
invariant(hashPattern.test(site.client_manifest_sha256), "Invalid client manifest hash");
invariant(hashPattern.test(site.map_manifest_sha256), "Invalid map manifest hash");
validateProvenance(site.provenance, "canonical");
if (site.release_provenance !== undefined) {
  validateProvenance(site.release_provenance, "recorded release");
}

console.log(JSON.stringify({
  status: "ok",
  active_map_release: releases.active_map_release,
  retained_map_releases: releases.tile_releases.length,
  supported_clients: Object.keys(site.supported_clients).length,
  hot_tiles: hotManifest.tile_count,
}, null, 2));

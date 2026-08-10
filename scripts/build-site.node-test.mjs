import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildSite, validateMapRoute } from "./build-site.mjs";

const clients = {
  "client-r4": "map-r1",
  "client-r6": "map-r1",
  "client-r7": "map-r1",
  "client-r8": "map-r2",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const route = (release) => `https://tiles.example/releases/${release}/map_data/`;
const provenance = {
  source_appmanifest_sha256: "b".repeat(64),
  renderer_upstream_commit: "c".repeat(40),
  render_commit: "d".repeat(40),
  viewer_commit: "e".repeat(40),
  tree_render_manifest_sha256: "f".repeat(64),
};
const canonicalViewer = new Map([
  ["LICENSE-pzmap2dzi.txt", "MIT\n"],
  ["map.png", "png\n"],
  ["openseadragon/LICENSE.txt", "OSD license\n"],
  ["openseadragon/modify_notice.md", "notice\n"],
  ["openseadragon/openseadragon.zip", "zip\n"],
  ["pzmap.css", "body {}\n"],
  ["pzmap.html", '<link rel="icon" href="map.png">\n' +
    '<script>window.FANMAP42_CLIENT_ASSET_BASE = "";</script>\n' +
    '<script src="openseadragon/openseadragon.js"></script>\n' +
    '<link rel="stylesheet" href="pzmap.css">\n' +
    '<script src="pzmap.js"></script>\n'],
  ["pzmap.js", "import './pzmap/globals.js';\n"],
  ["pzmap/globals.js", "export const viewer = true;\n"],
]);

async function write(root, path, bytes) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function assembledViewer() {
  const base = "/_client/client-r8/";
  return new Map([...canonicalViewer].map(([path, bytes]) => [
    path,
    path === "pzmap.html"
      ? bytes
        .replace('href="map.png"', `href="${base}map.png"`)
        .replace('window.FANMAP42_CLIENT_ASSET_BASE = "";',
          `window.FANMAP42_CLIENT_ASSET_BASE = "${base}";`)
        .replace('src="openseadragon/openseadragon.js"',
          `src="${base}openseadragon/openseadragon.js"`)
        .replace('href="pzmap.css"', `href="${base}pzmap.css"`)
        .replace('src="pzmap.js"', `src="${base}pzmap.js"`)
      : bytes,
  ]));
}

async function createViewerSource(root) {
  const source = join(root, "viewer-source");
  for (const [path, bytes] of canonicalViewer) await write(source, path, bytes);
  return source;
}

async function createSource(root) {
  const source = join(root, "source");
  const assets = new Map([
    ["RELEASE.json", `${JSON.stringify({ release_id: "client-r8", map_release: "map-r2", ...provenance })}\n`],
    ["_headers", "/*\n  X-Content-Type-Options: nosniff\n"],
    ["_redirects", "/keep /other 302\n/map_data/* https://old.example/:splat 307\n"],
    ["pzmap.html", "<!doctype html><title>FanMap42</title>\n"],
    ["pzmap_config.json", `${JSON.stringify({ route: { default: route("map-r2") } })}\n`],
  ]);
  for (const [path, bytes] of assembledViewer()) {
    assets.set(path, bytes);
    assets.set(`_client/client-r8/${path}`, bytes);
  }
  for (const [client, mapRelease] of Object.entries(clients)) {
    assets.set(`_client/${client}/pzmap_config.json`,
      `${JSON.stringify({ route: { default: route(mapRelease) } })}\n`);
  }
  for (const [path, bytes] of assets) await write(source, path, bytes);

  const manifest = [...assets.entries()]
    .filter(([path]) => path !== "_headers")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bytes]) => `${sha256(bytes)}  ./${path}`)
    .join("\n") + "\n";
  await write(source, "MANIFEST.sha256", manifest);
  const manifestHash = sha256(manifest);
  await write(source, "READY", `release_id=client-r8\nmanifest_sha256=${manifestHash}\n`);
  return { source, manifestHash };
}

async function createMapSource(root) {
  const source = join(root, "map-source");
  const releaseBytes = `${JSON.stringify({ release_id: "map-r2" })}\n`;
  await write(source, "RELEASE.json", releaseBytes);
  const manifest = `${sha256(releaseBytes)}  ./RELEASE.json\n`;
  await write(source, "MANIFEST.sha256", manifest);
  const manifestHash = sha256(manifest);
  await write(source, "READY", `release_id=map-r2\nmanifest_sha256=${manifestHash}\n`);
  return { source, manifestHash };
}

async function writeConfig(root, manifestHash, mapManifestHash) {
  const configPath = join(root, "production.json");
  await writeFile(configPath, `${JSON.stringify({
    schema: "fanmap42.site-build.v1",
    client_release: "client-r8",
    client_manifest_sha256: manifestHash,
    map_release: "map-r2",
    map_manifest_sha256: mapManifestHash,
    tile_origin: "https://tiles.example",
    provenance,
    supported_clients: clients,
    output: "output",
    max_assets: 100,
    max_asset_bytes: 1024 * 1024,
  }, null, 2)}\n`);
  return configPath;
}

test("rejects a viewer route that would re-enter the site Worker", () => {
  const config = { tile_origin: "https://tiles.example" };
  assert.throws(
    () => validateMapRoute(config, "map_data/", "map-r2", "pzmap_config.json"),
    /must load all map data/,
  );
});

test("builds a static-only site with operational assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "fanmap42-site-test-"));
  try {
    const { source, manifestHash } = await createSource(root);
    const viewerSource = await createViewerSource(root);
    const mapSource = await createMapSource(root);
    const configPath = await writeConfig(root, manifestHash, mapSource.manifestHash);
    const result = await buildSite({
      configPath,
      sourceRoot: source,
      mapSourceRoot: mapSource.source,
      viewerSourceRoot: viewerSource,
    });
    const output = join(root, "output");

    assert.equal(result.client_release, "client-r8");
    assert.deepEqual(result.supported_clients, ["client-r4", "client-r6", "client-r7", "client-r8"]);
    assert.match(await readFile(join(output, "robots.txt"), "utf8"), /User-agent: \*/);
    const health = JSON.parse(await readFile(join(output, ".well-known/fanmap42-health"), "utf8"));
    assert.deepEqual({ status: health.status, delivery: health.delivery },
      { status: "ok", delivery: "static-assets" });
    assert.equal(health.client_manifest_sha256, manifestHash);
    assert.deepEqual(health.provenance, provenance);
    const headers = await readFile(join(output, "_headers"), "utf8");
    assert.match(headers, /\/\.well-known\/fanmap42-health\n  Content-Type: application\/json/);
    assert.match(headers, /\/robots\.txt\n  Content-Type: text\/plain/);
    assert.equal(await readFile(join(output, "_redirects"), "utf8"), "/keep /other 302\n");
    assert.equal(await readFile(join(output, "pzmap.html"), "utf8"),
      assembledViewer().get("pzmap.html"));
    assert.equal(await readFile(join(output, "_client/client-r8/pzmap.html"), "utf8"),
      assembledViewer().get("pzmap.html"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

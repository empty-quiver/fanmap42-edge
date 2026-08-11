import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD_SCHEMA = "fanmap42.site-build.v1";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9._-]+$/;
const VIEWER_ROOT_FILES = [
  "LICENSE-pzmap2dzi.txt",
  "map.png",
  "pzmap.css",
  "pzmap.html",
  "pzmap.js",
];
const VIEWER_VENDOR_FILES = [
  "openseadragon/LICENSE.txt",
  "openseadragon/modify_notice.md",
  "openseadragon/openseadragon.zip",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function safeRelativePath(value, name) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") ||
      value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${name} is not a safe relative path: ${value}`);
  }
  return value;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function walkFiles(root, current = root) {
  const paths = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Site source cannot contain symbolic links: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      paths.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      paths.push(relative(root, absolute).split(sep).join("/"));
    } else {
      throw new Error(`Unsupported site source entry: ${relative(root, absolute)}`);
    }
  }
  return paths.sort();
}

async function copyFiles(paths, source, destination, maxAssetBytes) {
  let bytes = 0;
  for (const path of paths) {
    const sourcePath = join(source, path);
    const details = await lstat(sourcePath);
    if (!details.isFile() || details.size > maxAssetBytes) {
      throw new Error(`Invalid site asset (${details.size} bytes): ${path}`);
    }
    const destinationPath = join(destination, path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    bytes += details.size;
  }
  return bytes;
}

export function renderViewerHtml(source, clientRelease) {
  const base = `/_client/${clientRelease}/`;
  const replacements = [
    ['href="map.png"', `href="${base}map.png"`],
    ['window.FANMAP42_CLIENT_ASSET_BASE = "";',
      `window.FANMAP42_CLIENT_ASSET_BASE = "${base}";`],
    ['src="openseadragon/openseadragon.js"',
      `src="${base}openseadragon/openseadragon.js"`],
    ['href="pzmap.css"', `href="${base}pzmap.css"`],
    ['src="pzmap.js"', `src="${base}pzmap.js"`],
  ];
  let output = source;
  for (const [marker, replacement] of replacements) {
    if (output.includes(marker)) {
      output = output.replace(marker, replacement);
    } else if (!output.includes(replacement)) {
      throw new Error(`Canonical pzmap.html is missing release marker: ${marker}`);
    }
  }
  return output;
}

async function loadViewerSource(viewerSourceRoot, clientRelease, maxAssetBytes) {
  const source = resolve(viewerSourceRoot);
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`Viewer source is not a directory: ${source}`);
  }
  const pzmapPaths = (await walkFiles(join(source, "pzmap")))
    .map((path) => `pzmap/${path}`);
  const paths = [...VIEWER_ROOT_FILES, ...VIEWER_VENDOR_FILES, ...pzmapPaths].sort();
  const assets = new Map();
  for (const path of paths) {
    const sourcePath = join(source, path);
    const details = await lstat(sourcePath);
    if (!details.isFile() || details.size > maxAssetBytes) {
      throw new Error(`Invalid canonical viewer asset (${details.size} bytes): ${path}`);
    }
    const bytes = await readFile(sourcePath);
    assets.set(path, path === "pzmap.html"
      ? Buffer.from(renderViewerHtml(bytes.toString("utf8"), clientRelease))
      : bytes);
  }
  return assets;
}

async function verifyAssembledViewer(source, assets, clientRelease) {
  for (const [path, expected] of assets) {
    for (const assembledPath of [path, `_client/${clientRelease}/${path}`]) {
      const actual = await readFile(join(source, assembledPath));
      if (!actual.equals(expected)) {
        throw new Error(`Canonical viewer does not match assembled asset: ${assembledPath}`);
      }
    }
  }
}

async function writeViewerAssets(destination, assets, clientRelease) {
  for (const [path, bytes] of assets) {
    for (const outputPath of [path, `_client/${clientRelease}/${path}`]) {
      const target = join(destination, outputPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  const viewerHtml = assets.get("pzmap.html");
  if (viewerHtml === undefined) throw new Error("Canonical viewer is missing pzmap.html");
  await writeFile(join(destination, "index.html"), viewerHtml);
}

function parseReady(text) {
  const values = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("READY contains an invalid line");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function directMapRoot(tileOrigin, mapRelease) {
  return `${tileOrigin}/releases/${mapRelease}/map_data/`;
}

export function validateMapRoute(config, route, mapRelease, label) {
  if (route !== directMapRoot(config.tile_origin, mapRelease)) {
    throw new Error(
      `${label} must load all map data from ${directMapRoot(config.tile_origin, mapRelease)}; got ${route}`,
    );
  }
  const url = new URL(route);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "") {
    throw new Error(`${label} has an unsafe map-data route`);
  }
}

async function validateClientConfig(source, config, clientRelease, mapRelease, root = false) {
  const path = root ? "pzmap_config.json" : `_client/${clientRelease}/pzmap_config.json`;
  const candidate = JSON.parse(await readFile(join(source, path), "utf8"));
  validateMapRoute(config, candidate?.route?.default, mapRelease, path);
}

async function validateManifest(source, expectedHash, label) {
  const manifestBytes = await readFile(join(source, "MANIFEST.sha256"));
  const actualHash = sha256(manifestBytes);
  if (actualHash !== expectedHash) {
    throw new Error(`${label} manifest hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  for (const line of manifestBytes.toString("utf8").trim().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  \.\/(.+)$/);
    if (match === null) throw new Error(`Invalid MANIFEST.sha256 line: ${line}`);
    const path = safeRelativePath(match[2], "manifest path");
    const actual = sha256(await readFile(join(source, path)));
    if (actual !== match[1]) throw new Error(`${label} asset hash mismatch: ${path}`);
  }
}

function validateProvenance(actual, expected) {
  for (const [name, value] of Object.entries(expected)) {
    if (actual?.[name] !== value) {
      throw new Error(`RELEASE.json provenance mismatch for ${name}`);
    }
  }
}

function hasValidProvenance(provenance, patterns) {
  return provenance !== null && typeof provenance === "object" &&
    Object.entries(patterns).every(([name, pattern]) =>
      typeof provenance[name] === "string" && pattern.test(provenance[name]));
}

async function validateMapReleaseSource(sourceRoot, config) {
  const source = resolve(sourceRoot);
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`Map release source is not a directory: ${source}`);
  }
  const ready = parseReady(await readFile(join(source, "READY"), "utf8"));
  if (ready.get("release_id") !== config.map_release ||
      ready.get("manifest_sha256") !== config.map_manifest_sha256) {
    throw new Error("Map release READY does not match the configured release and manifest");
  }
  await validateManifest(source, config.map_manifest_sha256, "Map release");
}

export async function readSiteBuildConfig(configPath) {
  const absoluteConfig = resolve(configPath);
  const config = JSON.parse(await readFile(absoluteConfig, "utf8"));
  if (config.schema !== BUILD_SCHEMA || typeof config.client_release !== "string" ||
      typeof config.map_release !== "string" || typeof config.tile_origin !== "string") {
    throw new Error("Site build config has an unsupported schema or release");
  }
  if (!HASH_PATTERN.test(config.client_manifest_sha256) || !HASH_PATTERN.test(config.map_manifest_sha256) ||
      config.supported_clients === null || typeof config.supported_clients !== "object" ||
      Array.isArray(config.supported_clients) ||
      typeof config.output !== "string" || config.provenance === null ||
      typeof config.provenance !== "object") {
    throw new Error("Site build config is incomplete");
  }
  const provenancePatterns = {
    source_appmanifest_sha256: HASH_PATTERN,
    renderer_upstream_commit: /^[0-9a-f]{40}$/,
    render_commit: /^[0-9a-f]{40}$/,
    viewer_commit: /^[0-9a-f]{40}$/,
    tree_render_manifest_sha256: HASH_PATTERN,
  };
  if (!hasValidProvenance(config.provenance, provenancePatterns) ||
      (config.release_provenance !== undefined &&
       !hasValidProvenance(config.release_provenance, provenancePatterns))) {
    throw new Error("Site build provenance is incomplete");
  }
  if (!RELEASE_PATTERN.test(config.client_release) || !RELEASE_PATTERN.test(config.map_release)) {
    throw new Error("Configured release IDs contain unsupported characters");
  }
  const supportedClients = Object.entries(config.supported_clients);
  if (supportedClients.length === 0 || supportedClients.some(([clientRelease, mapRelease]) =>
    !RELEASE_PATTERN.test(clientRelease) || typeof mapRelease !== "string" ||
    !RELEASE_PATTERN.test(mapRelease))) {
    throw new Error("supported_clients contains an invalid release mapping");
  }
  const origin = new URL(config.tile_origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      origin.username !== "" || origin.password !== "") {
    throw new Error("tile_origin must be an HTTPS origin without credentials or a path");
  }
  positiveInteger(config.max_assets, "max_assets");
  positiveInteger(config.max_asset_bytes, "max_asset_bytes");
  return { ...config, configPath: absoluteConfig, outputPath: resolve(dirname(absoluteConfig), config.output) };
}

export async function buildSite({ configPath, sourceRoot, mapSourceRoot, viewerSourceRoot, outputPath }) {
  const config = await readSiteBuildConfig(configPath);
  const source = resolve(sourceRoot);
  const output = outputPath === undefined ? config.outputPath : resolve(outputPath);
  if (!(await stat(source)).isDirectory()) throw new Error(`Site source is not a directory: ${source}`);
  if (typeof mapSourceRoot !== "string" || mapSourceRoot === "") {
    throw new Error("Map release source is required");
  }
  if (typeof viewerSourceRoot !== "string" || viewerSourceRoot === "") {
    throw new Error("Canonical viewer source is required");
  }
  if (await pathExists(output)) throw new Error(`Refusing to overwrite existing output: ${output}`);

  const ready = parseReady(await readFile(join(source, "READY"), "utf8"));
  if (ready.get("release_id") !== config.client_release ||
      ready.get("manifest_sha256") !== config.client_manifest_sha256) {
    throw new Error("READY does not match the configured client release and manifest");
  }
  const release = JSON.parse(await readFile(join(source, "RELEASE.json"), "utf8"));
  if (release.release_id !== config.client_release || release.map_release !== config.map_release) {
    throw new Error("RELEASE.json does not match the configured client and map releases");
  }
  validateProvenance(release, config.release_provenance ?? config.provenance);
  await validateManifest(source, config.client_manifest_sha256, "Client");
  await validateMapReleaseSource(mapSourceRoot, config);
  await validateClientConfig(source, config, config.client_release, config.map_release, true);
  const viewerAssets = await loadViewerSource(
    viewerSourceRoot,
    config.client_release,
    config.max_asset_bytes,
  );
  await verifyAssembledViewer(source, viewerAssets, config.client_release);

  const clientRoot = join(source, "_client");
  const actualClients = (await readdir(clientRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedClients = Object.keys(config.supported_clients).sort();
  if (JSON.stringify(actualClients) !== JSON.stringify(expectedClients)) {
    throw new Error(`Retained client set mismatch: expected ${expectedClients.join(", ")}, got ${actualClients.join(", ")}`);
  }
  for (const [clientRelease, mapRelease] of Object.entries(config.supported_clients)) {
    await validateClientConfig(source, config, clientRelease, mapRelease);
  }

  const paths = await walkFiles(source);
  const deployableAssets = new Set([
    ...paths.filter((path) => path !== "_headers" && path !== "_redirects"),
    "index.html",
    ".well-known/fanmap42-health",
    "robots.txt",
  ]).size;
  if (deployableAssets > config.max_assets) {
    throw new Error(`Site bundle would contain ${deployableAssets} assets; limit is ${config.max_assets}`);
  }

  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(join(dirname(output), `.${basename(output)}-build-`));
  try {
    const sourceBytes = await copyFiles(paths, source, scratch, config.max_asset_bytes);
    await writeViewerAssets(scratch, viewerAssets, config.client_release);
    const health = {
      status: "ok",
      delivery: "static-assets",
      client_release: config.client_release,
      client_manifest_sha256: config.client_manifest_sha256,
      map_release: config.map_release,
      map_manifest_sha256: config.map_manifest_sha256,
      provenance: config.provenance,
      ...(config.release_provenance === undefined
        ? {}
        : { release_provenance: config.release_provenance }),
    };
    await mkdir(join(scratch, ".well-known"), { recursive: true });
    await writeFile(join(scratch, ".well-known", "fanmap42-health"), `${JSON.stringify(health)}\n`);
    await writeFile(join(scratch, "robots.txt"), "User-agent: *\nDisallow:\n");

    const headersPath = join(scratch, "_headers");
    const headers = await readFile(headersPath, "utf8");
    const hasHealthHeaders = headers.includes("/.well-known/fanmap42-health");
    const hasRobotsHeaders = headers.includes("/robots.txt");
    if (hasHealthHeaders !== hasRobotsHeaders) {
      throw new Error("Source _headers contains an incomplete operational asset policy");
    }
    if (!hasHealthHeaders) {
      await writeFile(headersPath, `${headers.trimEnd()}\n\n/.well-known/fanmap42-health\n` +
        "  Content-Type: application/json; charset=utf-8\n" +
        "  Cache-Control: no-store\n\n" +
        "/robots.txt\n" +
        "  Content-Type: text/plain; charset=utf-8\n" +
        "  Cache-Control: public, max-age=3600\n");
    }

    const redirectsPath = join(scratch, "_redirects");
    if (await pathExists(redirectsPath)) {
      const redirects = (await readFile(redirectsPath, "utf8")).split(/\r?\n/);
      const retained = redirects.filter((line) => !/^\/map_data(?:\/|\s)/.test(line));
      if (retained.some((line) => line.trim() !== "")) {
        await writeFile(redirectsPath, `${retained.join("\n").trimEnd()}\n`);
      } else {
        await rm(redirectsPath);
      }
    }

    await rename(scratch, output);
    return { output, client_release: config.client_release, map_release: config.map_release,
      supported_clients: expectedClients, deployable_assets: deployableAssets,
      source_bytes: sourceBytes };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = {
    configPath: new URL("../site/production.json", import.meta.url).pathname,
    sourceRoot: process.env.FANMAP42_SITE_SOURCE,
    mapSourceRoot: process.env.FANMAP42_MAP_RELEASE_SOURCE,
    viewerSourceRoot: process.env.FANMAP42_VIEWER_SOURCE,
    outputPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--config", "--source", "--map-source", "--viewer-source", "--output"].includes(argument) && value !== undefined) {
      if (argument === "--config") options.configPath = value;
      if (argument === "--source") options.sourceRoot = value;
      if (argument === "--map-source") options.mapSourceRoot = value;
      if (argument === "--viewer-source") options.viewerSourceRoot = value;
      if (argument === "--output") options.outputPath = value;
      index += 1;
    } else {
      throw new Error("Usage: npm run build:site -- --source SITE_DIR --map-source MAP_RELEASE_DIR --viewer-source PZMAP_HTML_DIR [--config FILE] [--output DIR]");
    }
  }
  if (typeof options.sourceRoot !== "string" || options.sourceRoot === "") {
    throw new Error("Set FANMAP42_SITE_SOURCE or pass --source SITE_DIR");
  }
  if (typeof options.mapSourceRoot !== "string" || options.mapSourceRoot === "") {
    throw new Error("Set FANMAP42_MAP_RELEASE_SOURCE or pass --map-source MAP_RELEASE_DIR");
  }
  if (typeof options.viewerSourceRoot !== "string" || options.viewerSourceRoot === "") {
    throw new Error("Set FANMAP42_VIEWER_SOURCE or pass --viewer-source PZMAP_HTML_DIR");
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSite(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

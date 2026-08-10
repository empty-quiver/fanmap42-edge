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

async function validateManifest(source, expectedHash) {
  const manifestBytes = await readFile(join(source, "MANIFEST.sha256"));
  const actualHash = sha256(manifestBytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Client manifest hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  for (const line of manifestBytes.toString("utf8").trim().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  \.\/(.+)$/);
    if (match === null) throw new Error(`Invalid MANIFEST.sha256 line: ${line}`);
    const path = safeRelativePath(match[2], "manifest path");
    const actual = sha256(await readFile(join(source, path)));
    if (actual !== match[1]) throw new Error(`Client asset hash mismatch: ${path}`);
  }
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
      typeof config.output !== "string") {
    throw new Error("Site build config is incomplete");
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

export async function buildSite({ configPath, sourceRoot, outputPath }) {
  const config = await readSiteBuildConfig(configPath);
  const source = resolve(sourceRoot);
  const output = outputPath === undefined ? config.outputPath : resolve(outputPath);
  if (!(await stat(source)).isDirectory()) throw new Error(`Site source is not a directory: ${source}`);
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
  await validateManifest(source, config.client_manifest_sha256);
  await validateClientConfig(source, config, config.client_release, config.map_release, true);

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
  const deployableAssets = paths.filter((path) => path !== "_headers" && path !== "_redirects").length + 2;
  if (deployableAssets > config.max_assets) {
    throw new Error(`Site bundle would contain ${deployableAssets} assets; limit is ${config.max_assets}`);
  }

  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(join(dirname(output), `.${basename(output)}-build-`));
  try {
    const sourceBytes = await copyFiles(paths, source, scratch, config.max_asset_bytes);
    const health = {
      status: "ok",
      delivery: "static-assets",
      client_release: config.client_release,
      client_manifest_sha256: config.client_manifest_sha256,
      map_release: config.map_release,
      map_manifest_sha256: config.map_manifest_sha256,
    };
    await mkdir(join(scratch, ".well-known"), { recursive: true });
    await writeFile(join(scratch, ".well-known", "fanmap42-health"), `${JSON.stringify(health)}\n`);
    await writeFile(join(scratch, "robots.txt"), "User-agent: *\nDisallow:\n");

    const headersPath = join(scratch, "_headers");
    const headers = await readFile(headersPath, "utf8");
    if (headers.includes("/.well-known/fanmap42-health") || headers.includes("/robots.txt")) {
      throw new Error("Source _headers already defines static operational assets");
    }
    await writeFile(headersPath, `${headers.trimEnd()}\n\n/.well-known/fanmap42-health\n` +
      "  Content-Type: application/json; charset=utf-8\n" +
      "  Cache-Control: no-store\n\n" +
      "/robots.txt\n" +
      "  Content-Type: text/plain; charset=utf-8\n" +
      "  Cache-Control: public, max-age=3600\n");

    const redirectsPath = join(scratch, "_redirects");
    const redirects = await pathExists(redirectsPath) ? await readFile(redirectsPath, "utf8") : "";
    if (/^\/map_data(?:\/|\s)/m.test(redirects)) {
      throw new Error("Source _redirects already defines legacy map-data routing");
    }
    const legacyMapDestination = `${directMapRoot(config.tile_origin, config.map_release)}:splat`;
    await writeFile(
      redirectsPath,
      `${redirects.trimEnd()}${redirects.trim() === "" ? "" : "\n"}` +
        `/map_data/* ${legacyMapDestination} 307\n`,
    );

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
    outputPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--config", "--source", "--output"].includes(argument) && value !== undefined) {
      if (argument === "--config") options.configPath = value;
      if (argument === "--source") options.sourceRoot = value;
      if (argument === "--output") options.outputPath = value;
      index += 1;
    } else {
      throw new Error("Usage: npm run build:site -- --source SITE_DIR [--config FILE] [--output DIR]");
    }
  }
  if (typeof options.sourceRoot !== "string" || options.sourceRoot === "") {
    throw new Error("Set FANMAP42_SITE_SOURCE or pass --source SITE_DIR");
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

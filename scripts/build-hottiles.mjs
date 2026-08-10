import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BUILD_SCHEMA = "fanmap42.hottiles-build.v1";
const TILE_MANIFEST_SCHEMA = "fanmap42.tile-existence.v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function safeSegmentPath(value, name) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") ||
      value.includes("\\") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${name} is not a safe relative path: ${value}`);
  }
  return value;
}

export function expandTileManifest(manifest, extensions) {
  if (manifest?.schema !== TILE_MANIFEST_SCHEMA || typeof manifest.release !== "string" ||
      manifest.release === "" || manifest.sources === null || typeof manifest.sources !== "object") {
    throw new Error("Hot-tile manifest has an unsupported schema or release");
  }

  const paths = [];
  for (const source of Object.keys(manifest.sources).sort()) {
    safeSegmentPath(source, "tile source");
    const extension = extensions.sources[source] ?? extensions.default;
    if (typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension)) {
      throw new Error(`No safe extension configured for ${source}`);
    }
    const levels = manifest.sources[source];
    if (levels === null || typeof levels !== "object") {
      throw new Error(`Invalid level map for ${source}`);
    }
    for (const levelText of Object.keys(levels).sort((a, b) => Number(a) - Number(b))) {
      if (!/^\d+$/.test(levelText)) {
        throw new Error(`Invalid pyramid level for ${source}: ${levelText}`);
      }
      const rows = levels[levelText];
      if (!Array.isArray(rows)) {
        throw new Error(`Invalid rows for ${source} level ${levelText}`);
      }
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 3 || row.length % 2 !== 1 ||
            row.some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error(`Invalid compact tile row for ${source} level ${levelText}`);
        }
        const y = row[0];
        for (let index = 1; index < row.length; index += 2) {
          const start = row[index];
          const end = row[index + 1];
          if (start > end) {
            throw new Error(`Reversed tile range for ${source} level ${levelText}`);
          }
          for (let x = start; x <= end; x += 1) {
            paths.push(`${source}_files/${levelText}/${x}_${y}.${extension}`);
          }
        }
      }
    }
  }

  if (paths.length !== positiveInteger(manifest.tile_count, "manifest tile_count")) {
    throw new Error(`Expanded ${paths.length} tiles but manifest declares ${manifest.tile_count}`);
  }
  return paths;
}

export async function readBuildConfig(configPath) {
  const absoluteConfig = resolve(configPath);
  const config = JSON.parse(await readFile(absoluteConfig, "utf8"));
  if (config.schema !== BUILD_SCHEMA || typeof config.release !== "string" || config.release === "") {
    throw new Error("Hottiles build config has an unsupported schema or release");
  }
  if (typeof config.manifest !== "string" || typeof config.output !== "string" ||
      typeof config.manifest_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(config.manifest_sha256)) {
    throw new Error("Hottiles build config is missing its manifest, output, or manifest hash");
  }
  if (typeof config.extensions?.default !== "string" || config.extensions.sources === null ||
      typeof config.extensions.sources !== "object") {
    throw new Error("Hottiles build config has invalid extension rules");
  }
  positiveInteger(config.copy_concurrency, "copy_concurrency");
  positiveInteger(config.max_assets, "max_assets");
  positiveInteger(config.max_asset_bytes, "max_asset_bytes");

  const base = dirname(absoluteConfig);
  return {
    ...config,
    configPath: absoluteConfig,
    manifestPath: resolve(base, config.manifest),
    outputPath: resolve(base, config.output),
  };
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

async function copyTiles(paths, sourceRoot, destinationRoot, concurrency, maxAssetBytes) {
  let cursor = 0;
  let bytes = 0;
  let largest = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      const source = join(sourceRoot, path);
      const details = await stat(source);
      if (!details.isFile() || details.size <= 0 || details.size > maxAssetBytes) {
        throw new Error(`Invalid source tile (${details.size} bytes): ${path}`);
      }
      const destination = join(destinationRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      bytes += details.size;
      largest = Math.max(largest, details.size);
    }
  });
  await Promise.all(workers);
  return { bytes, largest };
}

export async function buildHottiles({ configPath, sourceRoot, outputPath }) {
  const config = await readBuildConfig(configPath);
  const source = resolve(sourceRoot);
  const output = outputPath === undefined ? config.outputPath : resolve(outputPath);
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`Tile source is not a directory: ${source}`);
  }
  if (await pathExists(output)) {
    throw new Error(`Refusing to overwrite existing output: ${output}`);
  }

  const manifestBytes = await readFile(config.manifestPath);
  const manifestHash = sha256(manifestBytes);
  if (manifestHash !== config.manifest_sha256) {
    throw new Error(`Hot-tile manifest hash mismatch: expected ${config.manifest_sha256}, got ${manifestHash}`);
  }
  const manifest = JSON.parse(manifestBytes);
  if (manifest.release !== config.release) {
    throw new Error(`Manifest release ${manifest.release} does not match config release ${config.release}`);
  }
  const paths = expandTileManifest(manifest, config.extensions);
  const deployableFiles = paths.length + 3;
  if (deployableFiles > config.max_assets) {
    throw new Error(`Bundle would contain ${deployableFiles} assets; limit is ${config.max_assets}`);
  }

  await mkdir(dirname(output), { recursive: true });
  const scratch = await mkdtemp(join(dirname(output), `.${basename(output)}-build-`));
  try {
    const releaseRoot = join(scratch, "releases", config.release, "map_data");
    const totals = await copyTiles(
      paths,
      source,
      releaseRoot,
      config.copy_concurrency,
      config.max_asset_bytes,
    );
    await copyFile(config.manifestPath, join(scratch, "hot-tile-existence-v1.json"));
    await writeFile(join(scratch, "_headers"), [
      "/*",
      "  Cache-Control: public, max-age=31536000, immutable",
      "  Access-Control-Allow-Origin: *",
      "  Cross-Origin-Resource-Policy: cross-origin",
      "  X-Content-Type-Options: nosniff",
      "",
    ].join("\n"));
    const metadata = {
      schema: "fanmap42.hottiles-bundle.v1",
      release: config.release,
      created_at: new Date().toISOString(),
      tile_count: paths.length,
      tile_bytes: totals.bytes,
      largest_tile_bytes: totals.largest,
      manifest_sha256: manifestHash,
      deployable_files: deployableFiles,
    };
    await writeFile(join(scratch, "HOTSET.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await rename(scratch, output);
    return { output, ...metadata };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = {
    configPath: new URL("../hottiles/production.json", import.meta.url).pathname,
    sourceRoot: process.env.FANMAP42_TILE_SOURCE,
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
      throw new Error("Usage: npm run build:hottiles -- --source MAP_DATA_DIR [--config FILE] [--output DIR]");
    }
  }
  if (typeof options.sourceRoot !== "string" || options.sourceRoot === "") {
    throw new Error("Set FANMAP42_TILE_SOURCE or pass --source MAP_DATA_DIR");
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHottiles(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

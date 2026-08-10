import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { buildHottiles, expandTileManifest } from "./build-hottiles.mjs";

const manifest = {
  schema: "fanmap42.tile-existence.v1",
  release: "test-release",
  source_count: 1,
  tile_count: 2,
  sources: { "base/layer0": { "0": [[0, 0, 1]] } },
};

test("expands compact manifest ranges deterministically", () => {
  assert.deepEqual(expandTileManifest(manifest, {
    default: "webp",
    sources: { "base/layer0": "jpg" },
  }), [
    "base/layer0_files/0/0_0.jpg",
    "base/layer0_files/0/1_0.jpg",
  ]);
});

test("materializes an immutable release-shaped Static Assets bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "fanmap42-hottiles-test-"));
  try {
    const source = join(root, "source");
    const manifestPath = join(root, "hot-tile-existence-v1.json");
    const configPath = join(root, "production.json");
    const output = join(root, "output");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(manifestPath, manifestBytes);
    for (const path of ["base/layer0_files/0/0_0.jpg", "base/layer0_files/0/1_0.jpg"]) {
      const target = join(source, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, path);
    }
    await writeFile(configPath, `${JSON.stringify({
      schema: "fanmap42.hottiles-build.v1",
      release: "test-release",
      manifest: "hot-tile-existence-v1.json",
      manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      output: "output",
      extensions: { default: "webp", sources: { "base/layer0": "jpg" } },
      copy_concurrency: 2,
      max_assets: 10,
      max_asset_bytes: 1024,
    }, null, 2)}\n`);

    const result = await buildHottiles({ configPath, sourceRoot: source });
    assert.equal(result.tile_count, 2);
    assert.equal(await readFile(
      join(output, "releases/test-release/map_data/base/layer0_files/0/1_0.jpg"),
      "utf8",
    ), "base/layer0_files/0/1_0.jpg");
    const metadata = JSON.parse(await readFile(join(output, "HOTSET.json"), "utf8"));
    assert.equal(metadata.deployable_files, 5);
    assert.equal(metadata.manifest_sha256, result.manifest_sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

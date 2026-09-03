"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildSite, parseCliArguments } = require("../build");

const repoRoot = path.resolve(__dirname, "..", "..");

test("builds every public route and immutable asset from the live project model", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tech-persistence-site-"),
  );
  const outputDir = path.join(temporaryRoot, "dist");

  try {
    const result = buildSite({
      repoRoot,
      outputDir,
      basePath: "/tech-persistence/",
      now: "2026-07-29T00:00:00.000Z",
      allowOutsideRepo: true,
    });

    const expectedFiles = [
      "index.html",
      "catalog/index.html",
      "platforms/index.html",
      "architecture/index.html",
      "updates/index.html",
      "install/index.html",
      "status/index.html",
      "tasks/index.html",
      "404.html",
      "assets/styles.css",
      "assets/app.js",
      "assets/tasks.js",
      "assets/mark.svg",
      "build-manifest.json",
    ];

    for (const relativePath of expectedFiles) {
      assert.equal(
        fs.existsSync(path.join(outputDir, relativePath)),
        true,
        `missing ${relativePath}`,
      );
    }

    const home = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
    const catalog = fs.readFileSync(
      path.join(outputDir, "catalog/index.html"),
      "utf8",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, "build-manifest.json"), "utf8"),
    );

    assert.match(home, /\/tech-persistence\/assets\/styles\.css/);
    assert.match(home, /\/tech-persistence\/catalog\//);
    assert.match(catalog, /data-catalog-json=/);
    assert.equal(manifest.basePath, "/tech-persistence/");
    assert.equal(manifest.buildId, result.model.meta.buildId);
    assert.equal(manifest.sourceHash, result.model.meta.sourceHash);
    assert.deepEqual(manifest.routes, Object.keys(result.pages).sort());
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses to write outside the repository site directory by default", () => {
  assert.throws(
    () =>
      buildSite({
        repoRoot,
        outputDir: path.resolve(repoRoot, "..", "escaped-site"),
      }),
    /must stay inside/i,
  );
});

test("parses a production build command without accepting unknown flags", () => {
  assert.deepEqual(
    parseCliArguments([
      "--base",
      "/tech-persistence/",
      "--output",
      "site/dist",
      "--now",
      "2026-07-29T00:00:00.000Z",
    ]),
    {
      basePath: "/tech-persistence/",
      outputDir: "site/dist",
      now: "2026-07-29T00:00:00.000Z",
    },
  );
  assert.throws(() => parseCliArguments(["--surprise"]), /Unknown site build/);
});

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { collectProjectModel } = require("./lib/project-model");
const { normalizeBasePath, renderSitePages } = require("./templates/render-site");

const REQUIRED_ASSETS = ["styles.css", "app.js", "mark.svg"];

function isInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function ensureSafeOutput({ repoRoot, outputDir, allowOutsideRepo }) {
  const siteRoot = path.join(repoRoot, "site");
  if (!allowOutsideRepo && !isInside(siteRoot, outputDir)) {
    throw new Error(
      `Site build output must stay inside ${siteRoot}: ${outputDir}`,
    );
  }
  if (path.parse(outputDir).root === outputDir) {
    throw new Error(`Refusing to use a filesystem root as build output: ${outputDir}`);
  }
}

function writeTextFile(root, relativePath, contents) {
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
  return targetPath;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function buildSite(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || path.resolve(__dirname, ".."),
  );
  const outputDir = path.resolve(
    repoRoot,
    options.outputDir || path.join("site", "dist"),
  );
  const basePath = normalizeBasePath(
    options.basePath || "/tech-persistence/",
  );

  ensureSafeOutput({
    repoRoot,
    outputDir,
    allowOutsideRepo: options.allowOutsideRepo === true,
  });

  const model = collectProjectModel({
    repoRoot,
    now: options.now,
  });
  const pages = renderSitePages(model, { basePath });
  const assetRoot = path.join(repoRoot, "site", "assets");
  const stagingDir = path.join(
    path.dirname(outputDir),
    `.${path.basename(outputDir)}-staging-${process.pid}-${Date.now()}`,
  );

  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const [relativePath, html] of Object.entries(pages)) {
      writeTextFile(stagingDir, relativePath, `${html.trim()}\n`);
    }

    for (const assetName of REQUIRED_ASSETS) {
      const sourcePath = path.join(assetRoot, assetName);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Required site asset is missing: ${sourcePath}`);
      }
      const targetPath = path.join(stagingDir, "assets", assetName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }

    const builtFiles = [
      ...Object.keys(pages),
      ...REQUIRED_ASSETS.map((assetName) => `assets/${assetName}`),
    ].sort();
    const manifest = {
      schemaVersion: 1,
      buildId: model.meta.buildId,
      sourceHash: model.meta.sourceHash,
      generatedAt: model.meta.generatedAt,
      basePath,
      routes: Object.keys(pages).sort(),
      files: Object.fromEntries(
        builtFiles.map((relativePath) => [
          relativePath,
          sha256File(path.join(stagingDir, relativePath)),
        ]),
      ),
    };
    writeTextFile(
      stagingDir,
      "build-manifest.json",
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, outputDir);

    return {
      outputDir,
      basePath,
      model,
      pages,
      manifest,
    };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function requireOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      options.repoRoot = requireOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--output") {
      options.outputDir = requireOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--base") {
      options.basePath = requireOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--now") {
      options.now = requireOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown site build argument: ${argument}`);
    }
  }
  return options;
}

function cli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      [
        "Usage: node site/build.js [options]",
        "",
        "Options:",
        "  --repo-root <path>  Repository root (defaults to this repository)",
        "  --output <path>     Output directory (defaults to site/dist)",
        "  --base <path>       Public base path (defaults to /tech-persistence/)",
        "  --now <iso-date>    Override generatedAt for reproducible builds",
        "",
      ].join("\n"),
    );
    return null;
  }

  const result = buildSite(options);
  process.stdout.write(
    `${JSON.stringify({
      outputDir: result.outputDir,
      buildId: result.model.meta.buildId,
      sourceHash: result.model.meta.sourceHash,
      routeCount: Object.keys(result.pages).length,
    })}\n`,
  );
  return result;
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`Site build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildSite,
  parseCliArguments,
};

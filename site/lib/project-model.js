const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_MODEL_SCHEMA_VERSION = 1;
const DEFAULT_BRANCH = "main";
const DEFAULT_UPDATES_LIMIT = 8;
const CODEX_MANIFEST_PATH =
  "plugins/tech-persistence/.codex-plugin/plugin.json";
const CLAUDE_MANIFEST_PATH =
  "plugins/tech-persistence/.claude-plugin/plugin.json";
const MCP_MANIFEST_PATH =
  "plugins/tech-persistence/.codex-plugin/.mcp.json";
const CODEX_SKILLS_DIR = "plugins/tech-persistence/codex-skills";
const CLAUDE_COMMANDS_DIR = "plugins/tech-persistence/commands";
const CLAUDE_HOOKS_PATH = "plugins/tech-persistence/hooks/hooks.json";
const CODEX_HOOKS_PATH = "plugins/tech-persistence/codex-hooks/hooks.json";
const ARCHITECTURE_DOCS_DIR = "docs/architecture";
const SOLUTIONS_DIR = "docs/solutions";

const FEATURED_CAPABILITIES = new Set([
  "agent-loop",
  "compound",
  "memory",
  "review",
  "sprint",
  "work",
]);

const CATEGORY_BY_ID = new Map([
  ["agent-loop", "workflow"],
  ["compound", "workflow"],
  ["plan", "workflow"],
  ["prototype", "workflow"],
  ["prototype-workflow", "workflow"],
  ["review", "workflow"],
  ["sprint", "workflow"],
  ["test", "workflow"],
  ["test-strategy", "workflow"],
  ["think", "workflow"],
  ["work", "workflow"],
  ["checkpoint", "continuity"],
  ["context-handoff", "continuity"],
  ["memory", "memory"],
  ["continuous-learning", "memory"],
  ["learn", "memory"],
  ["review-learnings", "memory"],
  ["session-summary", "memory"],
  ["evolve", "evolution"],
  ["instinct-export", "evolution"],
  ["instinct-import", "evolution"],
  ["instinct-status", "evolution"],
  ["skill", "evolution"],
  ["skill-diagnose", "evolution"],
  ["skill-eval", "evolution"],
  ["skill-improve", "evolution"],
  ["skill-publish", "evolution"],
  ["caveman", "communication"],
  ["caveman-commit", "communication"],
  ["caveman-compress", "communication"],
  ["caveman-help", "communication"],
  ["caveman-review", "communication"],
]);

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

function titleFromSlug(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseInlineList(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (
      (character === '"' || character === "'") &&
      (index === 0 || inner[index - 1] !== "\\")
    ) {
      if (quote === character) {
        quote = null;
      } else if (!quote) {
        quote = character;
      }
      current += character;
      continue;
    }
    if (character === "," && !quote) {
      items.push(parseScalar(current.trim()));
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) items.push(parseScalar(current.trim()));
  return items;
}

function parseScalar(rawValue) {
  const value = String(rawValue).trim();
  if (!value) return "";
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineList(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseFrontmatterLines(lines) {
  const meta = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;

    const [, key, rawValue = ""] = keyMatch;
    if (/^[>|][+-]?$/.test(rawValue.trim())) {
      const style = rawValue.trim().charAt(0);
      const blockLines = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        if (/^[A-Za-z0-9_-]+:/.test(nextLine)) break;
        if (nextLine.trim() && !/^\s+/.test(nextLine)) break;
        index += 1;
        blockLines.push(nextLine.replace(/^\s{1,2}/, ""));
      }
      meta[key] =
        style === ">"
          ? blockLines.join(" ").replace(/\s+/g, " ").trim()
          : blockLines.join("\n").trim();
      continue;
    }

    if (!rawValue.trim()) {
      const list = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        const itemMatch = nextLine.match(/^\s+-\s+(.*)$/);
        if (!itemMatch) break;
        index += 1;
        list.push(parseScalar(itemMatch[1]));
      }
      meta[key] = list.length > 0 ? list : "";
      continue;
    }

    meta[key] = parseScalar(rawValue);
  }

  return meta;
}

function cleanMarkdownText(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSummary(markdown, maxLength = 240) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = [];
  let paragraph = [];
  let insideCodeFence = false;

  const flush = () => {
    if (paragraph.length === 0) return;
    const cleaned = cleanMarkdownText(paragraph.join(" "));
    if (cleaned) paragraphs.push(cleaned);
    paragraph = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      flush();
      insideCodeFence = !insideCodeFence;
      continue;
    }
    if (insideCodeFence) continue;
    if (!trimmed) {
      flush();
      continue;
    }
    if (
      /^(#{1,6}\s|>|[-*_]{3,}$|\|)/.test(trimmed) ||
      /^[-*+]\s/.test(trimmed)
    ) {
      flush();
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();

  const summary = paragraphs[0] || "";
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function parseMarkdownDocument(content, fallbackId = "document") {
  const normalized = String(content)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let meta = {};
  let body = normalized;

  if (lines[0] && lines[0].trim() === "---") {
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---",
    );
    if (closingIndex > 0) {
      meta = parseFrontmatterLines(lines.slice(1, closingIndex));
      body = lines.slice(closingIndex + 1).join("\n").replace(/^\n+/, "");
    }
  }

  const headingMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = cleanMarkdownText(
    meta.title || (headingMatch && headingMatch[1]) || titleFromSlug(fallbackId),
  );

  return {
    meta,
    body,
    title,
    summary: extractSummary(body),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createSourceReader(repoRoot) {
  const files = new Map();

  function read(relativePath, options = {}) {
    const normalizedPath = toPosixPath(relativePath);
    const absolutePath = path.join(repoRoot, ...normalizedPath.split("/"));
    if (!fs.existsSync(absolutePath)) {
      if (options.optional) return null;
      throw new Error(`Project model source missing: ${normalizedPath}`);
    }
    const content = fs.readFileSync(absolutePath);
    files.set(normalizedPath, {
      path: normalizedPath,
      sha256: sha256(content),
      bytes: content.byteLength,
    });
    return options.encoding === null ? content : content.toString("utf8");
  }

  function readJson(relativePath, options = {}) {
    const content = read(relativePath, options);
    if (content === null) return null;
    try {
      return JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Invalid JSON in project model source ${toPosixPath(relativePath)}: ${error.message}`,
        { cause: error },
      );
    }
  }

  function result() {
    const sortedFiles = [...files.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    );
    const hasher = crypto.createHash("sha256");
    hasher.update(`tech-persistence-site-model/v${PROJECT_MODEL_SCHEMA_VERSION}\0`);
    for (const file of sortedFiles) {
      hasher.update(file.path);
      hasher.update("\0");
      hasher.update(file.sha256);
      hasher.update("\n");
    }
    return {
      algorithm: "sha256",
      hash: hasher.digest("hex"),
      files: sortedFiles,
    };
  }

  return { read, readJson, result };
}

function listFiles(repoRoot, relativeDirectory, options = {}) {
  const absoluteDirectory = path.join(
    repoRoot,
    ...toPosixPath(relativeDirectory).split("/"),
  );
  if (!fs.existsSync(absoluteDirectory)) {
    if (options.optional) return [];
    throw new Error(
      `Project model source directory missing: ${toPosixPath(relativeDirectory)}`,
    );
  }

  const files = [];
  const visit = (directory, relativeBase) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryRelativePath = toPosixPath(
        path.join(relativeBase, entry.name),
      );
      if (entry.isDirectory()) {
        if (options.recursive) visit(entryPath, entryRelativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.extension && !entry.name.endsWith(options.extension)) continue;
      files.push(entryRelativePath);
    }
  };

  visit(absoluteDirectory, toPosixPath(relativeDirectory));
  return files;
}

function normalizeRepositoryUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

function repositoryUrl(manifest) {
  if (typeof manifest.repository === "string") return manifest.repository;
  if (
    manifest.repository &&
    typeof manifest.repository === "object" &&
    manifest.repository.url
  ) {
    return manifest.repository.url;
  }
  if (manifest.author && typeof manifest.author === "object") {
    return manifest.author.url || "";
  }
  return manifest.homepage || "";
}

function sourceTreeUrl(repository, relativePath) {
  const directory = toPosixPath(relativePath).replace(/\/SKILL\.md$/, "");
  return `${repository}/tree/${DEFAULT_BRANCH}/${directory}`;
}

function sourceBlobUrl(repository, relativePath) {
  return `${repository}/blob/${DEFAULT_BRANCH}/${toPosixPath(relativePath)}`;
}

function categoryForCapability(id) {
  if (CATEGORY_BY_ID.has(id)) return CATEGORY_BY_ID.get(id);
  if (id.startsWith("skill-") || id.startsWith("instinct-")) {
    return "evolution";
  }
  if (id.startsWith("caveman")) return "communication";
  return "tooling";
}

function collectCatalog({ repoRoot, repository, sourceReader }) {
  const skillFiles = listFiles(repoRoot, CODEX_SKILLS_DIR, {
    recursive: true,
    extension: "SKILL.md",
  }).filter((relativePath) => {
    const relative = relativePath.slice(`${CODEX_SKILLS_DIR}/`.length);
    return relative.split("/").length === 2;
  });
  const commandFiles = listFiles(repoRoot, CLAUDE_COMMANDS_DIR, {
    extension: ".md",
  });
  const commands = new Map();

  for (const commandPath of commandFiles) {
    const id = path.posix.basename(commandPath, ".md");
    const document = parseMarkdownDocument(sourceReader.read(commandPath), id);
    commands.set(id, { id, path: commandPath, document });
  }

  const catalog = [];
  const seenIds = new Set();

  for (const skillPath of skillFiles) {
    const directoryId = skillPath
      .slice(`${CODEX_SKILLS_DIR}/`.length)
      .split("/")[0];
    const document = parseMarkdownDocument(
      sourceReader.read(skillPath),
      directoryId,
    );
    const id = String(document.meta.name || directoryId).trim();
    if (!id) {
      throw new Error(`Skill has no stable id: ${skillPath}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate catalog capability id: ${id}`);
    }
    seenIds.add(id);

    const matchingCommand = commands.get(id);
    const runtimes = matchingCommand
      ? ["Codex", "Claude Code"]
      : ["Codex"];
    const invocations = matchingCommand ? [`$${id}`, `/${id}`] : [`$${id}`];

    catalog.push({
      id,
      name: titleFromSlug(id),
      description:
        String(document.meta.description || document.summary || "").trim() ||
        `${titleFromSlug(id)} capability for Tech Persistence.`,
      type: "skill",
      category: categoryForCapability(id),
      path: skillPath,
      sourceUrl: sourceTreeUrl(repository, skillPath),
      featured: FEATURED_CAPABILITIES.has(id),
      profile: FEATURED_CAPABILITIES.has(id) ? "core" : "extended",
      runtimes,
      invocations,
    });
  }

  for (const command of commands.values()) {
    if (seenIds.has(command.id)) continue;
    seenIds.add(command.id);
    catalog.push({
      id: command.id,
      name: titleFromSlug(command.id),
      description:
        String(
          command.document.meta.description ||
            command.document.summary ||
            "",
        ).trim() ||
        `${titleFromSlug(command.id)} command for Tech Persistence.`,
      type: "command",
      category: categoryForCapability(command.id),
      path: command.path,
      sourceUrl: sourceBlobUrl(repository, command.path),
      featured: FEATURED_CAPABILITIES.has(command.id),
      profile: FEATURED_CAPABILITIES.has(command.id) ? "core" : "extended",
      runtimes: ["Claude Code"],
      invocations: [`/${command.id}`],
    });
  }

  catalog.sort(
    (left, right) =>
      Number(right.featured) - Number(left.featured) ||
      left.name.localeCompare(right.name, "en") ||
      left.type.localeCompare(right.type, "en"),
  );

  return {
    catalog,
    skillCount: skillFiles.length,
    commandCount: commandFiles.length,
  };
}

function collectHookSurfaces(sourceReader) {
  const manifests = [
    { path: CLAUDE_HOOKS_PATH, runtime: "Claude Code" },
    { path: CODEX_HOOKS_PATH, runtime: "Codex" },
  ];
  const surfaces = [];

  for (const manifest of manifests) {
    const data = sourceReader.readJson(manifest.path);
    const hookGroups = data && data.hooks;
    if (!hookGroups || typeof hookGroups !== "object") {
      throw new Error(`Hook manifest has no hooks object: ${manifest.path}`);
    }

    for (const [event, configurations] of Object.entries(hookGroups)) {
      const groups = Array.isArray(configurations) ? configurations : [];
      const handlers = groups.flatMap((configuration) =>
        Array.isArray(configuration && configuration.hooks)
          ? configuration.hooks
          : [],
      );
      surfaces.push({
        runtime: manifest.runtime,
        event,
        handlers: handlers.length,
        commands: handlers
          .map((handler) => String(handler.command || "").trim())
          .filter(Boolean),
      });
    }
  }

  return surfaces.sort(
    (left, right) =>
      left.runtime.localeCompare(right.runtime, "en") ||
      left.event.localeCompare(right.event, "en"),
  );
}

function collectMcpProjection({ repoRoot, mcpManifest, sourceReader }) {
  const mcpSourceFiles = listFiles(
    repoRoot,
    "plugins/tech-persistence/mcp",
    {
      recursive: true,
      extension: ".js",
    },
  );
  const toolNames = new Set();
  const toolPattern = /\bname\s*:\s*["'](tp_[a-z0-9_-]+)["']/g;

  for (const sourcePath of mcpSourceFiles) {
    const content = sourceReader.read(sourcePath);
    let match;
    while ((match = toolPattern.exec(content)) !== null) {
      toolNames.add(match[1]);
    }
  }

  const tools = [...toolNames].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const servers = Object.entries(mcpManifest.mcpServers || {})
    .map(([id, configuration]) => ({
      id,
      description: String(
        (configuration && configuration.description) || "",
      ).trim(),
      tools,
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));

  return { servers, tools };
}

function dateFromDocument(document, relativePath) {
  const explicitDate = document.meta.date || document.meta.updated;
  if (explicitDate) return String(explicitDate).slice(0, 10);
  const filename = path.posix.basename(toPosixPath(relativePath));
  const filenameDate = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return filenameDate ? filenameDate[1] : "undated";
}

function collectUpdates({
  repoRoot,
  repository,
  sourceReader,
  updatesLimit,
}) {
  const solutionFiles = listFiles(repoRoot, SOLUTIONS_DIR, {
    extension: ".md",
  });
  const updates = solutionFiles.map((solutionPath) => {
    const document = parseMarkdownDocument(
      sourceReader.read(solutionPath),
      path.posix.basename(solutionPath, ".md"),
    );
    return {
      date: dateFromDocument(document, solutionPath),
      title: document.title,
      summary: document.summary,
      href: sourceBlobUrl(repository, solutionPath),
      path: solutionPath,
      status: String(document.meta.status || "documented"),
      tags: Array.isArray(document.meta.tags) ? document.meta.tags : [],
    };
  });

  updates.sort(
    (left, right) =>
      right.date.localeCompare(left.date, "en") ||
      left.title.localeCompare(right.title, "en"),
  );

  return {
    updates: updates.slice(0, updatesLimit),
    solutionCount: solutionFiles.length,
  };
}

function collectArchitectureSources({ repoRoot, repository, sourceReader }) {
  const architectureFiles = listFiles(repoRoot, ARCHITECTURE_DOCS_DIR, {
    extension: ".md",
  });
  const architectureSources = architectureFiles.map((architecturePath) => {
    const document = parseMarkdownDocument(
      sourceReader.read(architecturePath),
      path.posix.basename(architecturePath, ".md"),
    );
    return {
      title: document.title,
      path: architecturePath,
      href: sourceBlobUrl(repository, architecturePath),
      description: document.summary,
      status: String(document.meta.status || "documented"),
      updated:
        document.meta.updated ||
        document.meta.created ||
        dateFromDocument(document, architecturePath),
    };
  });

  architectureSources.sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en") ||
      left.path.localeCompare(right.path, "en"),
  );
  return architectureSources;
}

function trackRuntimeSourceFiles(repoRoot, sourceReader) {
  const runtimeDirectories = [
    "plugins/tech-persistence/hooks",
    "plugins/tech-persistence/codex-hooks",
  ];
  for (const runtimeDirectory of runtimeDirectories) {
    for (const runtimePath of listFiles(repoRoot, runtimeDirectory, {
      recursive: true,
    })) {
      sourceReader.read(runtimePath);
    }
  }
}

function normalizeGeneratedAt(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid project model generation time: ${now}`);
  }
  return value.toISOString();
}

function collectProjectModel(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || path.resolve(__dirname, "..", ".."),
  );
  const updatesLimit =
    options.updatesLimit === undefined
      ? DEFAULT_UPDATES_LIMIT
      : Number(options.updatesLimit);
  if (!Number.isInteger(updatesLimit) || updatesLimit < 0) {
    throw new Error(`updatesLimit must be a non-negative integer: ${updatesLimit}`);
  }

  const sourceReader = createSourceReader(repoRoot);
  const codexManifest = sourceReader.readJson(CODEX_MANIFEST_PATH);
  const claudeManifest = sourceReader.readJson(CLAUDE_MANIFEST_PATH);
  const mcpManifest = sourceReader.readJson(MCP_MANIFEST_PATH);
  sourceReader.read("README.md");
  sourceReader.read("plugins/tech-persistence/README.md");

  const repository = normalizeRepositoryUrl(repositoryUrl(codexManifest));
  if (!repository) {
    throw new Error(
      `Codex plugin manifest has no repository URL: ${CODEX_MANIFEST_PATH}`,
    );
  }

  const { catalog, skillCount, commandCount } = collectCatalog({
    repoRoot,
    repository,
    sourceReader,
  });
  const hookSurfaces = collectHookSurfaces(sourceReader);
  const mcpProjection = collectMcpProjection({
    repoRoot,
    mcpManifest,
    sourceReader,
  });
  const { updates, solutionCount } = collectUpdates({
    repoRoot,
    repository,
    sourceReader,
    updatesLimit,
  });
  const architectureSources = collectArchitectureSources({
    repoRoot,
    repository,
    sourceReader,
  });
  trackRuntimeSourceFiles(repoRoot, sourceReader);

  const source = sourceReader.result();
  const version = String(codexManifest.version || "0.0.0");
  const generatedAt = normalizeGeneratedAt(options.now);

  return {
    schemaVersion: PROJECT_MODEL_SCHEMA_VERSION,
    meta: {
      name:
        (codexManifest.interface && codexManifest.interface.displayName) ||
        titleFromSlug(codexManifest.name || "tech-persistence"),
      packageName: String(codexManifest.name || "tech-persistence"),
      version,
      description:
        (codexManifest.interface &&
          codexManifest.interface.shortDescription) ||
        String(codexManifest.description || ""),
      longDescription:
        (codexManifest.interface &&
          codexManifest.interface.longDescription) ||
        String(codexManifest.description || ""),
      repository,
      homepage: String(codexManifest.homepage || repository),
      license: String(codexManifest.license || ""),
      runtimeVersions: {
        codex: version,
        claudeCode: String(claudeManifest.version || "unknown"),
      },
      buildId: `tp-${version}-${source.hash.slice(0, 12)}`,
      generatedAt,
      sourceHash: source.hash,
    },
    metrics: {
      codexSkills: skillCount,
      claudeCommands: commandCount,
      hooks: hookSurfaces.length,
      mcpTools: mcpProjection.tools.length,
      architectureDocs: architectureSources.length,
      solutions: solutionCount,
    },
    catalog,
    updates,
    architectureSources,
    hookSurfaces,
    mcpServers: mcpProjection.servers,
    source,
  };
}

function writeGeneratedData(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || path.resolve(__dirname, "..", ".."),
  );
  const outputDir = path.resolve(
    options.outputDir || path.join(repoRoot, "site", "data"),
  );
  const fileName = options.fileName || "project-model.json";
  if (path.basename(fileName) !== fileName) {
    throw new Error(`Generated data fileName must be a basename: ${fileName}`);
  }

  const model = collectProjectModel({ ...options, repoRoot });
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, fileName);
  fs.writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  return { model, outputPath };
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      options.repoRoot = argv[++index];
    } else if (argument === "--output") {
      options.outputDir = argv[++index];
    } else if (argument === "--now") {
      options.now = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown project model argument: ${argument}`);
    }
  }
  return options;
}

function cli(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(
      [
        "Usage: node site/lib/project-model.js [options]",
        "",
        "Options:",
        "  --repo-root <path>  Repository root (defaults to this repository)",
        "  --output <path>     Generated data directory (defaults to site/data)",
        "  --now <iso-date>    Override generatedAt for reproducible builds",
        "",
      ].join("\n"),
    );
    return null;
  }

  const result = writeGeneratedData(options);
  process.stdout.write(
    `${JSON.stringify({
      outputPath: result.outputPath,
      buildId: result.model.meta.buildId,
      sourceHash: result.model.meta.sourceHash,
    })}\n`,
  );
  return result;
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`Project model build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  collectProjectModel,
  parseMarkdownDocument,
  writeGeneratedData,
};

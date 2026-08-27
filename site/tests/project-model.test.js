const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  collectProjectModel,
  parseMarkdownDocument,
  writeGeneratedData,
} = require("../lib/project-model");

function writeFixtureFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function createRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-site-model-"));

  writeFixtureFile(
    root,
    "plugins/tech-persistence/.codex-plugin/plugin.json",
    JSON.stringify({
      name: "tech-persistence",
      version: "9.8.7",
      description: "Repository-backed fixture.",
      repository: "https://github.com/songuu/tech-persistence.git",
      homepage: "https://songuu.top/tech-persistence/",
      license: "MIT",
      interface: {
        displayName: "Tech Persistence",
        shortDescription: "Persistent engineering memory.",
      },
    }),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/.claude-plugin/plugin.json",
    JSON.stringify({
      name: "tech-persistence",
      version: "9.8.7",
    }),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/.codex-plugin/.mcp.json",
    JSON.stringify({
      mcpServers: {
        "tech-persistence-memory": {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/mcp/memory-mcp-server.js"],
          description: "Memory tools.",
        },
      },
    }),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/codex-skills/sprint/SKILL.md",
    [
      "---",
      "name: sprint",
      "description: Run the full engineering loop.",
      "---",
      "",
      "# Sprint",
      "",
      "Coordinate the workflow.",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/codex-skills/memory/SKILL.md",
    [
      "---",
      "name: memory",
      "description: >",
      "  Retrieve durable project knowledge",
      "  only when the current task needs it.",
      "---",
      "",
      "# Memory for Codex",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/codex-skills/context-handoff/SKILL.md",
    [
      "---",
      'description: "Preserve execution context across sessions."',
      "---",
      "",
      "# Context Handoff",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/skills/sprint/SKILL.md",
    [
      "---",
      'description: "Claude skill for the full workflow."',
      "---",
      "",
      "# /sprint",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/skills/think/SKILL.md",
    [
      "---",
      'description: "Frame product scope before implementation."',
      "---",
      "",
      "# /think",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: "node start.js" }] }],
        Stop: [{ hooks: [{ command: "node stop.js" }] }],
      },
    }),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/codex-hooks/hooks.json",
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: "node codex-start.js" }] }],
        PreToolUse: [{ hooks: [{ command: "node guard.js" }] }],
      },
    }),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/mcp/lib/memory-tools.js",
    [
      "const TOOL_DEFINITIONS = [",
      "  { name: 'tp_memory_search', description: 'Search.' },",
      '  { name: "tp_memory_recent", description: "Recent." },',
      "];",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "plugins/tech-persistence/README.md",
    "# Tech Persistence for Codex\n\nRepository-backed plugin projection.\n",
  );
  writeFixtureFile(
    root,
    "README.md",
    "# Tech Persistence\n\nPersistent engineering memory for Claude Code and Codex.\n",
  );
  writeFixtureFile(
    root,
    "docs/architecture/2026-02-03-runtime-layers.md",
    [
      "---",
      'title: "Runtime layers"',
      "status: completed",
      'updated: "2026-02-04"',
      "---",
      "",
      "# Runtime layers",
      "",
      "Codex and Claude Code share durable knowledge.",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "docs/architecture/ISSUES.md",
    "# Architecture issues\n\nTracked architecture tensions.\n",
  );
  writeFixtureFile(
    root,
    "docs/solutions/2026-02-01-first-fix.md",
    [
      "---",
      'title: "First fix"',
      'date: "2026-02-01"',
      "tags: [solution, testing]",
      "status: completed",
      "---",
      "",
      "# First fix",
      "",
      "The first repository-derived update.",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "docs/solutions/2026-02-05-second-fix.md",
    [
      "# Second fix",
      "",
      "The **second** update links to [evidence](https://example.test).",
    ].join("\n"),
  );

  return root;
}

test("parses the Markdown frontmatter shapes used by real skills and docs", () => {
  const parsed = parseMarkdownDocument(
    [
      "---",
      "name: memory",
      "description: >",
      "  Retrieve durable project knowledge",
      "  only when the task needs it.",
      'tags: ["memory", codex]',
      "---",
      "",
      "# Memory for Codex",
      "",
      "Body text.",
    ].join("\n"),
    "fallback",
  );

  assert.equal(parsed.meta.name, "memory");
  assert.equal(
    parsed.meta.description,
    "Retrieve durable project knowledge only when the task needs it.",
  );
  assert.deepEqual(parsed.meta.tags, ["memory", "codex"]);
  assert.equal(parsed.title, "Memory for Codex");
  assert.equal(parsed.body.trim(), "# Memory for Codex\n\nBody text.");
});

test("collects a deterministic catalog, metrics, updates, and source manifest", () => {
  const repoRoot = createRepositoryFixture();
  const now = new Date("2026-07-29T01:02:03.000Z");

  const model = collectProjectModel({ repoRoot, now });

  assert.deepEqual(model.metrics, {
    codexSkills: 3,
    claudeSkills: 2,
    hooks: 4,
    mcpTools: 2,
    architectureDocs: 2,
    solutions: 2,
  });
  assert.equal(model.meta.name, "Tech Persistence");
  assert.equal(model.meta.version, "9.8.7");
  assert.equal(model.meta.repository, "https://github.com/songuu/tech-persistence");
  assert.equal(model.meta.generatedAt, now.toISOString());
  assert.match(model.meta.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(model.source.hash, model.meta.sourceHash);
  assert.match(model.meta.buildId, /^tp-9\.8\.7-[a-f0-9]{12}$/);

  const sprint = model.catalog.find((entry) => entry.id === "sprint");
  assert.deepEqual(sprint.runtimes, ["Codex", "Claude Code"]);
  assert.deepEqual(sprint.invocations, ["$sprint", "/tech-persistence:sprint"]);
  assert.equal(sprint.type, "skill");
  assert.equal(sprint.category, "workflow");
  assert.equal(sprint.featured, true);
  assert.equal(
    sprint.sourceUrl,
    "https://github.com/songuu/tech-persistence/tree/main/plugins/tech-persistence/codex-skills/sprint",
  );

  const memory = model.catalog.find((entry) => entry.id === "memory");
  assert.deepEqual(memory.runtimes, ["Codex"]);
  assert.equal(
    memory.description,
    "Retrieve durable project knowledge only when the current task needs it.",
  );

  const contextHandoff = model.catalog.find(
    (entry) => entry.id === "context-handoff",
  );
  assert.equal(contextHandoff.name, "Context Handoff");

  const think = model.catalog.find((entry) => entry.id === "think");
  assert.equal(think.type, "skill");
  assert.deepEqual(think.runtimes, ["Claude Code"]);
  assert.deepEqual(think.invocations, ["/tech-persistence:think"]);

  assert.deepEqual(
    model.updates.map((update) => update.date),
    ["2026-02-05", "2026-02-01"],
  );
  assert.equal(model.updates[0].title, "Second fix");
  assert.equal(
    model.updates[0].summary,
    "The second update links to evidence.",
  );
  assert.equal(model.architectureSources[0].path, "docs/architecture/ISSUES.md");
  assert.ok(
    model.source.files.some(
      (entry) =>
        entry.path ===
        "plugins/tech-persistence/codex-skills/sprint/SKILL.md",
    ),
  );
  assert.ok(
    model.source.files.every(
      (entry) =>
        !path.isAbsolute(entry.path) &&
        entry.path === entry.path.replaceAll("\\", "/"),
    ),
  );
});

test("changes the source hash only when repository-backed inputs change", () => {
  const repoRoot = createRepositoryFixture();
  const first = collectProjectModel({
    repoRoot,
    now: new Date("2026-07-29T00:00:00.000Z"),
  });
  const laterBuild = collectProjectModel({
    repoRoot,
    now: new Date("2026-07-30T00:00:00.000Z"),
  });

  assert.equal(first.meta.sourceHash, laterBuild.meta.sourceHash);
  assert.equal(first.meta.buildId, laterBuild.meta.buildId);
  assert.notEqual(first.meta.generatedAt, laterBuild.meta.generatedAt);

  writeFixtureFile(
    repoRoot,
    "plugins/tech-persistence/codex-skills/memory/SKILL.md",
    [
      "---",
      "name: memory",
      "description: Updated memory behavior.",
      "---",
      "",
      "# Memory",
    ].join("\n"),
  );
  const changed = collectProjectModel({ repoRoot });

  assert.notEqual(changed.meta.sourceHash, first.meta.sourceHash);
  assert.equal(
    changed.catalog.find((entry) => entry.id === "memory").description,
    "Updated memory behavior.",
  );
});

test("writes the generated projection as JSON for a template-independent build", () => {
  const repoRoot = createRepositoryFixture();
  const outputDir = path.join(repoRoot, "site", "data");
  const result = writeGeneratedData({
    repoRoot,
    outputDir,
    now: new Date("2026-07-29T00:00:00.000Z"),
  });

  assert.equal(result.outputPath, path.join(outputDir, "project-model.json"));
  assert.equal(result.model.meta.version, "9.8.7");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.outputPath, "utf8")),
    result.model,
  );
  assert.equal(fs.readFileSync(result.outputPath, "utf8").endsWith("\n"), true);
});

test("the real repository remains the source of truth for current counts", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const model = collectProjectModel({
    repoRoot,
    now: new Date("2026-07-29T00:00:00.000Z"),
  });

  const skillCount = fs
    .readdirSync(
      path.join(repoRoot, "plugins", "tech-persistence", "codex-skills"),
      { withFileTypes: true },
    )
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(
          path.join(
            repoRoot,
            "plugins",
            "tech-persistence",
            "codex-skills",
            entry.name,
            "SKILL.md",
          ),
        ),
    ).length;
  const claudeSkillCount = fs
    .readdirSync(
      path.join(repoRoot, "plugins", "tech-persistence", "skills"),
      { withFileTypes: true },
    )
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(
          path.join(
            repoRoot,
            "plugins",
            "tech-persistence",
            "skills",
            entry.name,
            "SKILL.md",
          ),
        ),
    ).length;

  assert.equal(model.metrics.codexSkills, skillCount);
  assert.equal(model.metrics.claudeSkills, claudeSkillCount);
  assert.equal(model.catalog.filter((entry) => entry.type === "skill").length, skillCount);
  assert.equal(model.meta.version, "1.0.8");
  assert.equal(model.metrics.mcpTools, 10);
  assert.ok(model.updates.length > 0);
  assert.ok(model.architectureSources.length > 0);
});

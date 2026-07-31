const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeBasePath,
  renderSitePages,
} = require("../templates/render-site");

const fixture = {
  meta: {
    name: "Tech Persistence",
    version: "1.0.7",
    description: "Persistent engineering memory for Claude Code and Codex.",
    repository: "https://github.com/songuu/tech-persistence",
    license: "MIT",
    buildId: "fixture-build",
    generatedAt: "2026-07-29T00:00:00.000Z",
  },
  metrics: {
    codexSkills: 4,
    claudeCommands: 3,
    hooks: 2,
    mcpTools: 5,
    architectureDocs: 7,
    solutions: 12,
  },
  catalog: [
    {
      id: "sprint",
      name: "Sprint",
      description: "Run the complete engineering loop with explicit gates.",
      type: "skill",
      category: "workflow",
      path: "plugins/tech-persistence/codex-skills/sprint/SKILL.md",
      sourceUrl:
        "https://github.com/songuu/tech-persistence/tree/main/plugins/tech-persistence/codex-skills/sprint",
      featured: true,
      runtimes: ["Codex", "Claude Code"],
    },
    {
      id: "memory",
      name: "Memory",
      description: "Retrieve durable knowledge on demand.",
      type: "skill",
      category: "memory",
      path: "plugins/tech-persistence/codex-skills/memory/SKILL.md",
      sourceUrl:
        "https://github.com/songuu/tech-persistence/tree/main/plugins/tech-persistence/codex-skills/memory",
      featured: true,
      runtimes: ["Codex"],
    },
  ],
  updates: [
    {
      date: "2026-07",
      title: "Codex plugin 1.0.7",
      summary: "Native skills, hooks, and MCP projection remain aligned.",
      href: "https://github.com/songuu/tech-persistence",
    },
  ],
  architectureSources: [
    {
      title: "Evolution overview",
      path: "docs/architecture/2026-05-28-evolution-overview.md",
      href:
        "https://github.com/songuu/tech-persistence/blob/main/docs/architecture/2026-05-28-evolution-overview.md",
    },
  ],
};

test("normalizes a production base path exactly once", () => {
  assert.equal(normalizeBasePath("tech-persistence"), "/tech-persistence/");
  assert.equal(normalizeBasePath("/tech-persistence"), "/tech-persistence/");
  assert.equal(normalizeBasePath("/"), "/");
});

test("renders the complete ECC-shaped, Tech Persistence-owned route map", () => {
  const pages = renderSitePages(fixture, {
    basePath: "/tech-persistence/",
  });

  assert.deepEqual(
    Object.keys(pages).sort(),
    [
      "404.html",
      "architecture/index.html",
      "catalog/index.html",
      "index.html",
      "install/index.html",
      "platforms/index.html",
      "status/index.html",
      "updates/index.html",
    ],
  );

  for (const [outputPath, html] of Object.entries(pages)) {
    assert.match(html, /<!doctype html>/i, outputPath);
    assert.match(html, /href="#main-content"/, outputPath);
    assert.match(
      html,
      /href="\/tech-persistence\/assets\/styles\.css"/,
      outputPath,
    );
    assert.match(
      html,
      /src="\/tech-persistence\/assets\/app\.js"/,
      outputPath,
    );
    assert.match(html, /Tech Persistence/, outputPath);
    assert.match(html, /data-build-id="fixture-build"/, outputPath);
    assert.doesNotMatch(html, /AgentShield|Install GitHub App/, outputPath);
  }
});

test("home page keeps the reference information rhythm with original product semantics", () => {
  const { "index.html": html } = renderSitePages(fixture, {
    basePath: "/tech-persistence/",
  });

  assert.match(html, /让每一次编码会话都产生复利/);
  assert.match(html, /data-section="three-layers"/);
  assert.match(html, /执行层/);
  assert.match(html, /知识层/);
  assert.match(html, /存储层/);
  assert.match(html, /data-section="learning-loop"/);
  assert.match(html, /data-section="quick-start"/);
  assert.match(html, /data-section="faq"/);
  assert.match(html, /href="\/tech-persistence\/catalog\/"/);
  assert.match(html, /href="\/tech-persistence\/architecture\/"/);
});

test("catalog page exposes accessible search, filtering, selection, and copy controls", () => {
  const { "catalog/index.html": html } = renderSitePages(fixture, {
    basePath: "/tech-persistence/",
  });

  assert.match(html, /type="search"/);
  assert.match(html, /aria-label="搜索能力目录"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /data-catalog-card/);
  assert.match(html, /data-profile="core"/);
  assert.match(html, /data-selection-tray/);
  assert.match(html, /data-copy-target/);
  assert.match(html, /id="catalog-data"/);
  assert.match(html, /&quot;Sprint&quot;/);
});

test("escapes repository-derived content before rendering", () => {
  const hostile = structuredClone(fixture);
  hostile.catalog[0].name = '<img src=x onerror="alert(1)">';
  hostile.catalog[0].description = "<script>alert(1)</script>";

  const { "catalog/index.html": html } = renderSitePages(hostile, {
    basePath: "/tech-persistence/",
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("mobile command rows remain inside the viewport with usable copy targets", () => {
  const styles = fs.readFileSync(
    path.resolve(__dirname, "..", "assets", "styles.css"),
    "utf8",
  );

  assert.match(styles, /html\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(
    styles,
    /\.command-row > div\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    styles,
    /\.command-row code\s*\{[^}]*display:\s*block[^}]*max-width:\s*100%/s,
  );
  assert.match(
    styles,
    /\.icon-button\s*\{[^}]*min-height:\s*44px/s,
  );
  assert.match(
    styles,
    /\.hero-badges a\s*\{[^}]*min-height:\s*44px/s,
  );
  assert.match(
    styles,
    /\.layer-card a\s*\{[^}]*min-height:\s*44px/s,
  );
  assert.match(
    styles,
    /\.footer-grid > div:not\(\.footer-brand\) a\s*\{[^}]*min-height:\s*44px/s,
  );
});

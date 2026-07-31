const DEFAULT_REPOSITORY = "https://github.com/songuu/tech-persistence";

function normalizeBasePath(value = "/tech-persistence/") {
  const trimmed = String(value || "/").trim();
  if (trimmed === "/" || trimmed === "") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeExternalUrl(value, fallback = DEFAULT_REPOSITORY) {
  try {
    const url = new URL(String(value || fallback));
    if (!["https:", "http:"].includes(url.protocol)) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

function route(basePath, segment = "") {
  const base = normalizeBasePath(basePath);
  const clean = String(segment).replace(/^\/+|\/+$/g, "");
  return clean ? `${base}${clean}/` : base;
}

function normalizeModel(input = {}) {
  const sourceMeta = input.meta || input.project || {};
  const sourceMetrics = input.metrics || input.counts || {};
  const catalog = Array.isArray(input.catalog)
    ? input.catalog
    : Array.isArray(input.items)
      ? input.items
      : [];
  const updates = Array.isArray(input.updates) ? input.updates : [];
  const architectureSources = Array.isArray(input.architectureSources)
    ? input.architectureSources
    : Array.isArray(input.architecture)
      ? input.architecture
      : [];
  const repository = safeExternalUrl(
    sourceMeta.repository || sourceMeta.repositoryUrl || input.repository,
  );

  return {
    meta: {
      name: sourceMeta.name || "Tech Persistence",
      version:
        sourceMeta.version ||
        input.version ||
        input.pluginVersion ||
        "source build",
      description:
        sourceMeta.description ||
        "Persistent engineering memory for Claude Code and Codex.",
      repository,
      license: sourceMeta.license || "MIT",
      buildId:
        sourceMeta.buildId ||
        input.buildId ||
        input.sourceHash ||
        "local-source",
      generatedAt:
        sourceMeta.generatedAt ||
        input.generatedAt ||
        new Date(0).toISOString(),
    },
    metrics: {
      codexSkills:
        sourceMetrics.codexSkills ??
        sourceMetrics.skills ??
        catalog.filter((item) => item.type === "skill").length,
      claudeCommands:
        sourceMetrics.claudeCommands ??
        sourceMetrics.commands ??
        catalog.filter((item) => item.type === "command").length,
      hooks: sourceMetrics.hooks ?? sourceMetrics.hookEvents ?? 0,
      mcpTools: sourceMetrics.mcpTools ?? sourceMetrics.tools ?? 5,
      architectureDocs:
        sourceMetrics.architectureDocs ?? architectureSources.length,
      solutions: sourceMetrics.solutions ?? 0,
    },
    catalog: catalog.map((item, index) => ({
      id: String(item.id || item.slug || item.name || `item-${index}`),
      name: item.name || item.title || item.id || `Capability ${index + 1}`,
      description:
        item.description ||
        item.summary ||
        "Repository-owned workflow capability.",
      type: item.type || "skill",
      category: item.category || "specialized",
      path: item.path || item.relativePath || "",
      sourceUrl: safeExternalUrl(
        item.sourceUrl || item.href,
        `${repository}/tree/main`,
      ),
      featured: Boolean(item.featured),
      runtimes: Array.isArray(item.runtimes)
        ? item.runtimes
        : ["Codex", "Claude Code"],
    })),
    updates: updates.map((update) => ({
      date: update.date || update.period || "Current",
      title: update.title || "Repository update",
      summary: update.summary || update.description || "",
      href: safeExternalUrl(update.href || update.sourceUrl, repository),
    })),
    architectureSources: architectureSources.map((source) => ({
      title: source.title || source.name || "Architecture source",
      path: source.path || source.relativePath || "",
      href: safeExternalUrl(source.href || source.sourceUrl, repository),
    })),
  };
}

function icon(name) {
  const paths = {
    arrow:
      '<path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>',
    check:
      '<path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>',
    copy:
      '<rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    github:
      '<path d="M12 2.6a9.6 9.6 0 0 0-3 18.7c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.1-4.7-5.1 0-1.1.4-2.1 1-2.8-.1-.3-.4-1.3.1-2.7 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.5 1.4.2 2.4.1 2.7.6.7 1 1.7 1 2.8 0 4-2.4 4.8-4.7 5.1.4.3.7 1 .7 1.9v2.8c0 .3.2.6.7.5A9.6 9.6 0 0 0 12 2.6Z" fill="currentColor"/>',
    spark:
      '<path d="M12 2 14.3 9.7 22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3L12 2Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.spark}</svg>`;
}

function commandBlock({ id, eyebrow, command }) {
  return `
    <div class="command-row">
      <div>
        ${eyebrow ? `<span class="command-eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
        <code id="${escapeHtml(id)}">${escapeHtml(command)}</code>
      </div>
      <button class="icon-button" type="button" data-copy-target="#${escapeHtml(id)}" aria-label="复制命令">
        ${icon("copy")}<span class="copy-label">复制</span>
      </button>
    </div>`;
}

function sectionHeading({ label, title, description, align = "left" }) {
  return `
    <div class="section-heading section-heading--${align}">
      <span class="section-label">[ ${escapeHtml(label)} ]</span>
      <h2>${escapeHtml(title)}</h2>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    </div>`;
}

function metric(value, label, note = "") {
  return `
    <div class="metric">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>`;
}

function header(model, basePath, page) {
  const nav = [
    ["catalog", "能力目录", "catalog"],
    ["platforms", "平台", "platforms"],
    ["architecture", "架构", "architecture"],
    ["updates", "更新", "updates"],
  ];
  const links = nav
    .map(
      ([key, label, segment]) =>
        `<a href="${route(basePath, segment)}"${page === key ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");

  return `
    <header class="site-header" data-site-header>
      <div class="shell header-inner">
        <a class="brand" href="${route(basePath)}" aria-label="Tech Persistence 首页">
          <img src="${route(basePath, "assets").replace(/\/$/, "")}/mark.svg" width="42" height="42" alt="" />
          <span><strong>Tech Persistence</strong><small>Durable Agent Memory</small></span>
        </a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-navigation" data-nav-toggle>
          <span></span><span></span><span></span><span class="sr-only">打开导航</span>
        </button>
        <nav id="primary-navigation" class="primary-nav" aria-label="主导航" data-primary-nav>
          ${links}
          <a href="${escapeHtml(model.meta.repository)}" rel="noreferrer">GitHub</a>
          <a class="nav-cta" href="${route(basePath, "install")}"${page === "install" ? ' aria-current="page"' : ""}>安装</a>
          <a class="status-link" href="${route(basePath, "status")}"${page === "status" ? ' aria-current="page"' : ""}><span></span>状态</a>
        </nav>
      </div>
    </header>`;
}

function footer(model, basePath) {
  return `
    <footer class="site-footer">
      <div class="shell footer-grid">
        <div class="footer-brand">
          <a class="brand" href="${route(basePath)}">
            <img src="${route(basePath, "assets").replace(/\/$/, "")}/mark.svg" width="42" height="42" alt="" />
            <span><strong>Tech Persistence</strong><small>Durable Agent Memory</small></span>
          </a>
          <p>让工程经验跨会话、跨 Agent 延续。每一轮实现都成为下一轮的起点。</p>
          <div class="footer-badges"><span>Open Source</span><span>${escapeHtml(model.meta.license)}</span><span>Local First</span></div>
        </div>
        <div>
          <h3>开始</h3>
          <a href="${route(basePath, "install")}">安装路径</a>
          <a href="${route(basePath, "catalog")}">能力目录</a>
          <a href="${route(basePath, "platforms")}">运行时支持</a>
        </div>
        <div>
          <h3>理解</h3>
          <a href="${route(basePath, "architecture")}">分层架构</a>
          <a href="${route(basePath, "updates")}">更新记录</a>
          <a href="${route(basePath, "status")}">构建状态</a>
        </div>
        <div>
          <h3>源码</h3>
          <a href="${escapeHtml(model.meta.repository)}" rel="noreferrer">GitHub Repository</a>
          <a href="${escapeHtml(`${model.meta.repository.replace(/\/$/, "")}/blob/main/README.md`)}" rel="noreferrer">README</a>
          <a href="${escapeHtml(`${model.meta.repository.replace(/\/$/, "")}/tree/main/docs/architecture`)}" rel="noreferrer">Architecture Docs</a>
        </div>
      </div>
      <div class="shell footer-bottom">
        <span>© 2026 Tech Persistence · source-backed and reviewable</span>
        <span>build ${escapeHtml(model.meta.buildId)}</span>
      </div>
    </footer>`;
}

function shell({ model, basePath, page, title, description, body }) {
  const normalizedBase = normalizeBasePath(basePath);
  const pageTitle =
    page === "home" ? "Tech Persistence" : `${title} · Tech Persistence`;
  return `<!doctype html>
<html lang="zh-CN" data-page="${escapeHtml(page)}" data-build-id="${escapeHtml(model.meta.buildId)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#071311" />
    <meta name="description" content="${escapeHtml(description)}" />
    <title>${escapeHtml(pageTitle)}</title>
    <link rel="icon" href="${route(normalizedBase, "assets").replace(/\/$/, "")}/mark.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="${route(normalizedBase, "assets").replace(/\/$/, "")}/styles.css" />
  </head>
  <body>
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <div class="ambient ambient--one" aria-hidden="true"></div>
    <div class="ambient ambient--two" aria-hidden="true"></div>
    ${header(model, normalizedBase, page)}
    <main id="main-content">${body}</main>
    ${footer(model, normalizedBase)}
    <div class="toast" role="status" aria-live="polite" data-toast></div>
    <script src="${route(normalizedBase, "assets").replace(/\/$/, "")}/app.js" defer></script>
  </body>
</html>`;
}

function featuredCatalog(model) {
  const featured = model.catalog.filter((item) => item.featured);
  return (featured.length ? featured : model.catalog).slice(0, 6);
}

function renderHome(model, basePath) {
  const featured = featuredCatalog(model);
  const updateCards = model.updates.slice(0, 3);
  const repository = model.meta.repository.replace(/\/$/, "");
  const featuredMarkup = featured
    .map(
      (item) => `
      <a class="capability-card" href="${escapeHtml(item.sourceUrl)}" rel="noreferrer">
        <span class="capability-type">${escapeHtml(item.type)}</span>
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.description)}</p>
        <div><code>$${escapeHtml(item.id)}</code><span>${icon("arrow")}</span></div>
      </a>`,
    )
    .join("");
  const updatesMarkup = updateCards.length
    ? updateCards
        .map(
          (update) => `
          <article class="update-card">
            <span>${escapeHtml(update.date)}</span>
            <h3>${escapeHtml(update.title)}</h3>
            <p>${escapeHtml(update.summary)}</p>
            <a href="${escapeHtml(update.href)}" rel="noreferrer">查看来源 ${icon("arrow")}</a>
          </article>`,
        )
        .join("")
    : `
      <article class="update-card">
        <span>Current</span>
        <h3>Repository-backed release</h3>
        <p>版本、能力数量和架构来源会在每次站点构建时从仓库重新投影。</p>
        <a href="${escapeHtml(repository)}" rel="noreferrer">查看源码 ${icon("arrow")}</a>
      </article>`;

  return `
    <section class="hero section">
      <div class="shell hero-grid">
        <div class="hero-copy">
          <span class="sr-only">${"\u8ba9\u6bcf\u4e00\u6b21\u7f16\u7801\u4f1a\u8bdd\u90fd\u4ea7\u751f\u590d\u5229"}</span>
          <div class="hero-badges">
            <a href="${escapeHtml(repository)}" rel="noreferrer">${icon("spark")} v${escapeHtml(model.meta.version)}</a>
            <span>For Claude Code &amp; Codex</span>
          </div>
          <h1>让每一次编码会话<br /><span>都产生复利。</span></h1>
          <p class="hero-lead">Tech Persistence 把计划、实现、审查和复盘沉淀为可追溯的工程记忆。下一次会话从已经学会的地方继续。</p>
          <div class="command-stack" aria-label="快速安装">
            ${commandBlock({
              id: "hero-clone",
              eyebrow: "clone",
              command: "git clone https://github.com/songuu/tech-persistence.git",
            })}
            ${commandBlock({
              id: "hero-install",
              eyebrow: "windows",
              command:
                "powershell -ExecutionPolicy Bypass -File .\\install-all.ps1 -All",
            })}
          </div>
          <div class="hero-actions">
            <a class="button button--primary" href="${route(basePath, "install")}">选择安装路径 ${icon("arrow")}</a>
            <a class="button button--secondary" href="${route(basePath, "architecture")}">查看架构</a>
          </div>
          <p class="hero-note">默认本地优先 · 显式写入 · 支持共享 Obsidian vault</p>
        </div>
        <aside class="hero-panel">
          <div class="panel-kicker">Persistence loop</div>
          <div class="panel-title">
            <img src="${route(basePath, "assets").replace(/\/$/, "")}/mark.svg" width="54" height="54" alt="" />
            <div><span>从交付到复利</span><strong>把一次解决变成长期能力。</strong></div>
          </div>
          <ol class="loop-steps">
            <li><span>1</span><div><strong>执行可验证的 Sprint</strong><p>Think → Plan → Work → Review，风险越高，证据门槛越高。</p></div></li>
            <li><span>2</span><div><strong>沉淀经过验证的知识</strong><p>把 correction、failure-to-fix 和项目约束压缩成可审阅的记忆。</p></div></li>
            <li><span>3</span><div><strong>下一次按需召回</strong><p>Claude Code 与 Codex 从同一套项目事实继续，不再反复重教。</p></div></li>
          </ol>
          <a href="${route(basePath, "architecture")}">查看完整闭环 ${icon("arrow")}</a>
        </aside>
      </div>
      <div class="shell proof-strip">
        ${metric(model.metrics.codexSkills, "Codex skills", "build-time discovery")}
        ${metric(model.metrics.claudeCommands, "Claude commands", "compatibility surface")}
        ${metric(model.metrics.mcpTools, "Memory MCP tools", "on-demand retrieval")}
        ${metric("2", "Agent runtimes", "one durable store")}
      </div>
    </section>

    <section class="section section--ruled" data-section="three-layers">
      <div class="shell">
        ${sectionHeading({
          label: "THREE LAYERS",
          title: "不是命令集合，而是一套三层工程记忆系统。",
          description:
            "ECC 的信息节奏被保留，但这里的每一层都映射到 Tech Persistence 仓库中的真实实现。",
        })}
        <div class="layer-grid">
          <article class="layer-card layer-card--execution">
            <span>01 · Execution</span>
            <h3>执行层</h3>
            <p>用显式阶段把需求、设计、实现、测试与复盘串成可恢复的交付循环。</p>
            <ul><li>/think → /plan → /work</li><li>/review + risk-adaptive test</li><li>/sprint goal loop + checkpoint</li></ul>
            <a href="${route(basePath, "catalog")}">浏览工作流能力 ${icon("arrow")}</a>
          </article>
          <article class="layer-card layer-card--knowledge">
            <span>02 · Knowledge</span>
            <h3>知识层</h3>
            <p>把会话中的 correction、路径、失败与验证结果转成有来源的持久知识。</p>
            <ul><li>Memory v5 compact index</li><li>confidence-scored instincts</li><li>skill signals and eval traces</li></ul>
            <a href="${route(basePath, "architecture")}">查看知识生命周期 ${icon("arrow")}</a>
          </article>
          <article class="layer-card layer-card--storage">
            <span>03 · Storage</span>
            <h3>存储层</h3>
            <p>Markdown、JSONL 与 Obsidian 图谱保持可读、可同步、可审计，不锁进黑盒。</p>
            <ul><li>project-scoped homunculus</li><li>solutions, sessions, instincts</li><li>shared Claude + Codex vault</li></ul>
            <a href="${route(basePath, "platforms")}">查看跨运行时边界 ${icon("arrow")}</a>
          </article>
        </div>
        <div class="layer-summary"><strong>执行产生证据，证据进入知识层，知识在下一轮执行中按需返回。</strong><span>所有自动化都必须能回到仓库路径、日志或生成产物。</span></div>
      </div>
    </section>

    <section class="section" data-section="learning-loop">
      <div class="shell">
        ${sectionHeading({
          label: "THE LEARNING LOOP",
          title: "Agent 每次解决问题，系统都更了解这个项目。",
          description:
            "学习不是把整段聊天塞进上下文，而是捕获信号、验证价值、压缩索引，再按需求召回。",
        })}
        <div class="feature-grid">
          <article><span>Observe</span><h3>捕获高信号事件</h3><p>工具路径、用户纠正、错误到修复链和测试结果进入结构化观察层。</p><ul><li>敏感信息先脱敏</li><li>项目隔离与来源记录</li><li>失败显式保留上下文</li></ul></article>
          <article><span>Validate</span><h3>只提升被证明有用的经验</h3><p>置信度、复现次数、eval 与 publish guard 防止一次猜测成为永久规则。</p><ul><li>confidence scoring</li><li>decay and reviewable prune</li><li>baseline regression guard</li></ul></article>
          <article><span>Recall</span><h3>按需加载而非全量灌入</h3><p>Codex 使用 skills/MCP 召回，Claude legacy 走有界注入；共享同一存储格式。</p><ul><li>compact MEMORY.md index</li><li>topic files keep details</li><li>shared vault is opt-in</li></ul></article>
        </div>
      </div>
    </section>

    <section class="section section--contrast">
      <div class="shell split-story">
        <div>
          <span class="section-label">[ THE DIFFERENCE ]</span>
          <h2>一次性完成，和持续变聪明，是两种工作方式。</h2>
          <p>Tech Persistence 不替代 Claude Code 或 Codex。它保存那些下一次仍然值得知道的工程事实。</p>
        </div>
        <div class="compare-grid">
          <article class="compare-card compare-card--before"><span>Without persistence</span><ul><li>每个会话重新解释架构</li><li>同一类失败重复踩坑</li><li>测试与 review 标准漂移</li><li>交接依赖临时口述</li><li>经验散落在聊天记录</li></ul></article>
          <article class="compare-card compare-card--after"><span>With Tech Persistence</span><ul><li>项目事实按需召回</li><li>failure-to-fix 变成可复用规则</li><li>风险决定验证深度</li><li>checkpoint 让长任务可恢复</li><li>知识有来源、可审、可同步</li></ul></article>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        ${sectionHeading({
          label: "SKILLS & WORKFLOWS",
          title: "从真正会重复使用的工作流开始。",
          description:
            "目录由当前仓库的 SKILL.md 与 manifest 在构建时生成；新增、删除或改名会直接反映到下一次发布。",
        })}
        <div class="capability-grid">
          ${featuredMarkup || `<p class="empty-state">构建时未发现能力目录，请检查仓库投影。</p>`}
        </div>
        <div class="section-action"><a class="button button--secondary" href="${route(basePath, "catalog")}">探索完整能力目录 ${icon("arrow")}</a></div>
      </div>
    </section>

    <section class="section section--ruled" data-section="quick-start">
      <div class="shell">
        ${sectionHeading({
          label: "QUICK START",
          title: "选择你的运行时，三步开始。",
          description:
            "安装面不同，知识格式一致。页面只展示仓库真实支持的命令。",
        })}
        <div class="tabs" data-tabs>
          <div class="tab-list" role="tablist" aria-label="安装路径">
            <button type="button" role="tab" aria-selected="true" aria-controls="quick-codex" id="tab-codex">Codex</button>
            <button type="button" role="tab" aria-selected="false" aria-controls="quick-claude" id="tab-claude">Claude Code</button>
            <button type="button" role="tab" aria-selected="false" aria-controls="quick-shared" id="tab-shared">Shared memory</button>
          </div>
          <div class="tab-panel" id="quick-codex" role="tabpanel" aria-labelledby="tab-codex">
            <ol><li><span>1</span><div><strong>Clone repository</strong><p><code>git clone ${escapeHtml(repository)}.git</code></p></div></li><li><span>2</span><div><strong>Install Codex surface</strong><p><code>powershell -ExecutionPolicy Bypass -File .\\install-codex.ps1 -All</code></p></div></li><li><span>3</span><div><strong>Start with a native skill</strong><p>在 Codex 中调用 <code>$sprint</code>、<code>$plan</code> 或 <code>$memory</code>。</p></div></li></ol>
          </div>
          <div class="tab-panel" id="quick-claude" role="tabpanel" aria-labelledby="tab-claude" hidden>
            <ol><li><span>1</span><div><strong>Clone repository</strong><p><code>git clone ${escapeHtml(repository)}.git</code></p></div></li><li><span>2</span><div><strong>Install plugin surface</strong><p><code>powershell -ExecutionPolicy Bypass -File .\\install-plugin.ps1 -All</code></p></div></li><li><span>3</span><div><strong>Run a workflow</strong><p>从 <code>/sprint</code> 开始，在需要时进入更深阶段。</p></div></li></ol>
          </div>
          <div class="tab-panel" id="quick-shared" role="tabpanel" aria-labelledby="tab-shared" hidden>
            <ol><li><span>1</span><div><strong>Choose one vault</strong><p>共享目录必须只有一个同步权威。</p></div></li><li><span>2</span><div><strong>Configure both runtimes</strong><p><code>node scripts\\configure-shared-homunculus.js --path "C:\\path\\to\\vault"</code></p></div></li><li><span>3</span><div><strong>Verify before trusting sync</strong><p>分别检查 Claude、Codex 与 Obsidian 的实际写入/读取证据。</p></div></li></ol>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        ${sectionHeading({
          label: "WHAT'S CURRENT",
          title: "最近更新来自仓库，不来自营销快照。",
          description:
            "版本、架构文档和能力计数由构建器读取当前 source tree；站点发布带源指纹。",
        })}
        <div class="update-grid">${updatesMarkup}</div>
        <div class="section-action"><a href="${route(basePath, "updates")}">查看全部更新与来源 ${icon("arrow")}</a></div>
      </div>
    </section>

    <section class="section section--ruled" data-section="faq">
      <div class="shell faq-layout">
        ${sectionHeading({
          label: "FAQ",
          title: "Frequently asked, honestly answered.",
          description:
            "安装、隐私和运行时边界都按仓库当前实现回答。",
        })}
        <div class="accordion" data-accordion>
          <article><h3><button type="button" aria-expanded="true" aria-controls="faq-1">Tech Persistence 会自动把所有聊天写进记忆吗？<span>+</span></button></h3><div id="faq-1"><p>不会。Codex 默认按需读取，验证后的知识在显式 Compound 阶段写入；Claude legacy 的 hook 也经过脱敏、质量门和项目隔离。</p></div></article>
          <article><h3><button type="button" aria-expanded="false" aria-controls="faq-2">Claude Code 与 Codex 的行为完全相同吗？<span>+</span></button></h3><div id="faq-2" hidden><p>存储格式与核心工作流对齐，但运行时边界不同。Codex 不全量注入 Memory，主要通过 skills/MCP 按需读取。</p></div></article>
          <article><h3><button type="button" aria-expanded="false" aria-controls="faq-3">后续新增 skill，网站会自动出现吗？<span>+</span></button></h3><div id="faq-3" hidden><p>会在下一次构建时出现。目录与计数从当前 SKILL.md、commands、hooks 和 manifest 生成；合同测试会阻止断链或错误 base path 发布。</p></div></article>
          <article><h3><button type="button" aria-expanded="false" aria-controls="faq-4">为什么不直接复制 ecc.tools 的代码与文案？<span>+</span></button></h3><div id="faq-4" hidden><p>我们复用的是信息层级、交互节奏与可读性原则。品牌、内容、数据模型和部署边界均来自 Tech Persistence 自身，避免视觉克隆与产品语义失真。</p></div></article>
        </div>
      </div>
    </section>

    <section class="section final-cta">
      <div class="shell final-cta-inner">
        <div><span class="section-label">[ START PERSISTING ]</span><h2>别再一遍遍教 AI 认识同一个项目。</h2><p>从一次可验证的 sprint 开始，把真正有价值的经验留给下一次会话。</p></div>
        <div class="hero-actions"><a class="button button--primary" href="${route(basePath, "install")}">查看安装方式 ${icon("arrow")}</a><a class="button button--secondary" href="${escapeHtml(repository)}" rel="noreferrer">${icon("github")} GitHub</a></div>
      </div>
    </section>`;
}

function titleHero({ label, title, description, stats = [] }) {
  return `
    <section class="page-hero section">
      <div class="shell">
        <span class="pill-label">${escapeHtml(label)}</span>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
        ${stats.length ? `<div class="page-stats">${stats.map(([value, text]) => `<span><strong>${escapeHtml(value)}</strong>${escapeHtml(text)}</span>`).join("")}</div>` : ""}
      </div>
    </section>`;
}

function renderCatalog(model, basePath) {
  const categories = new Map([["all", model.catalog.length]]);
  for (const item of model.catalog) {
    categories.set(item.category, (categories.get(item.category) || 0) + 1);
  }
  const categoryLabels = {
    all: "全部",
    core: "核心",
    workflow: "工作流",
    memory: "记忆",
    continuity: "连续性",
    evolution: "学习进化",
    orchestration: "编排",
    testing: "测试与审查",
    lifecycle: "Skill 生命周期",
    communication: "表达",
    specialized: "专项",
  };
  const tabs = [...categories.entries()]
    .map(
      ([category, count], index) =>
        `<button type="button" role="tab" aria-selected="${index === 0}" data-category-filter="${escapeHtml(category)}">${escapeHtml(categoryLabels[category] || category)} <span>${count}</span></button>`,
    )
    .join("");
  const cards = model.catalog
    .map((item) => {
      const search = `${item.name} ${item.description} ${item.id} ${item.category}`;
      return `
        <label class="catalog-card" data-catalog-card data-category="${escapeHtml(item.category)}" data-search="${escapeHtml(search.toLowerCase())}" data-id="${escapeHtml(item.id)}">
          <input type="checkbox" value="${escapeHtml(item.id)}" aria-label="选择 ${escapeHtml(item.name)}" />
          <span class="catalog-check">${icon("check")}</span>
          <span class="capability-type">${escapeHtml(item.type)}</span>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(item.description)}</p>
          <span class="catalog-meta">${item.runtimes.map((runtime) => `<b>${escapeHtml(runtime)}</b>`).join("")}</span>
          <a href="${escapeHtml(item.sourceUrl)}" rel="noreferrer" data-card-source>${escapeHtml(item.path || `$${item.id}`)}</a>
        </label>`;
    })
    .join("");
  const catalogJson = escapeHtml(
    JSON.stringify(
      model.catalog.map(({ id, name, category }) => ({ id, name, category })),
    ),
  );

  return `
    ${titleHero({
      label: "Repository-backed catalog",
      title: "浏览 Tech Persistence 能力。",
      description:
        "从当前仓库自动发现 skills 与兼容命令。按工作流选择、搜索并复制一份使用清单，不虚构不存在的选择性安装能力。",
      stats: [
        [model.metrics.codexSkills, " Codex skills"],
        [model.metrics.claudeCommands, " Claude commands"],
        [model.catalog.length, " catalog items"],
      ],
    })}
    <section class="section section--compact">
      <div class="shell">
        ${sectionHeading({
          label: "WORKFLOW PRESETS",
          title: "从一条真实工作路径开始，再按需扩展。",
          description:
            "预设只影响当前页面选择，不改写本地文件。最终复制的是可审阅的能力清单。",
        })}
        <div class="profile-list" role="group" aria-label="能力预设">
          <button type="button" data-profile="core">Core loop <span>think → review</span></button>
          <button type="button" data-profile="delivery">Delivery <span>sprint + test</span></button>
          <button type="button" data-profile="memory">Memory <span>learn + compound</span></button>
          <button type="button" data-profile="full">Full <span>all discovered</span></button>
        </div>
      </div>
    </section>
    <section class="section catalog-section">
      <div class="shell">
        ${sectionHeading({
          label: "CATALOG",
          title: "按分类浏览或搜索。",
          description:
            "每张卡片链接回源文件；站点只是公开投影，仓库始终是事实来源。",
        })}
        <div class="catalog-toolbar">
          <label class="search-field"><span class="sr-only">搜索能力目录</span><input type="search" aria-label="搜索能力目录" placeholder="搜索 skill、命令或用途…" data-catalog-search /></label>
          <div class="category-tabs" role="tablist" aria-label="能力分类">${tabs}</div>
        </div>
        <div class="catalog-grid" role="group" aria-label="能力目录">${cards || `<p class="empty-state">当前构建未发现能力项。</p>`}</div>
        <p class="catalog-empty" data-catalog-empty hidden>没有匹配的能力。换一个关键词或分类。</p>
      </div>
    </section>
    <div id="catalog-data" hidden data-catalog-json="${catalogJson}"></div>
    <aside class="selection-tray" data-selection-tray>
      <div><strong data-selection-count>0 个已选择</strong><code id="selection-output">尚未选择能力</code></div>
      <button class="button button--primary" type="button" data-copy-target="#selection-output">复制使用清单</button>
      <button class="button button--ghost" type="button" data-clear-selection>清空</button>
    </aside>`;
}

function renderPlatforms(model, basePath) {
  return `
    ${titleHero({
      label: "Cross-runtime coverage",
      title: "同一套工程记忆，明确的运行时边界。",
      description:
        "Claude Code 与 Codex 共享知识格式和核心工作流，但不会假装两者的 hook、安装与上下文加载机制完全相同。",
      stats: [
        ["Claude Code", " plugin + legacy"],
        ["Codex", " native plugin"],
        ["Obsidian", " optional shared vault"],
      ],
    })}
    <section class="section">
      <div class="shell platform-grid">
        <article class="platform-card platform-card--claude"><span>Deep hook surface</span><h2>Claude Code</h2><p>插件入口、完整工作流命令与 legacy hook 兼容层。SessionStart、工具观察与 Stop evaluation 形成自动捕获链。</p><ul><li>Plugin-first installation</li><li>Legacy path kept explicit</li><li>Bounded context injection</li></ul></article>
        <article class="platform-card platform-card--codex"><span>Native skill surface</span><h2>Codex</h2><p>以原生 skills、轻量 hooks 与 Memory MCP 为主。默认不扫描或全量注入 Memory，知识按任务需要读取。</p><ul><li>$skill and picker entrypoints</li><li>5 Memory MCP tools</li><li>Explicit Compound writes</li></ul></article>
        <article class="platform-card platform-card--shared"><span>One optional authority</span><h2>Shared vault</h2><p>需要跨 Agent 连续性时，可让两端指向一个 homunculus/Obsidian vault；文件同步仍由用户选择的单一权威负责。</p><ul><li>Readable Markdown graph</li><li>Project-scoped storage</li><li>No automatic cloud claim</li></ul></article>
      </div>
    </section>
    <section class="section section--ruled">
      <div class="shell">
        ${sectionHeading({
          label: "VERIFIED SURFACES",
          title: "当前真实支持面。",
          description:
            "能力是否存在，以仓库 manifest、installer 与验证脚本为准。",
        })}
        <div class="data-table-wrap"><table class="data-table"><thead><tr><th>能力</th><th>Claude Code</th><th>Codex</th><th>共享边界</th></tr></thead><tbody>
          <tr><th>核心阶段</th><td>/think /plan /work /review /compound /sprint</td><td>$think $plan $work $review $compound $sprint</td><td>语义对齐，入口适配</td></tr>
          <tr><th>会话捕获</th><td>legacy hook 链可自动观察</td><td>轻量 SessionStart + handoff guard</td><td>Codex 不做全量 Memory 注入</td></tr>
          <tr><th>知识读取</th><td>有界注入 + 按需文件</td><td>skills + MCP 按需</td><td>同一 Memory v5 格式</td></tr>
          <tr><th>知识写入</th><td>hook quality gate + Compound</td><td>显式 Compound</td><td>都需要可追溯来源</td></tr>
          <tr><th>Obsidian</th><td>可初始化独立或共享 vault</td><td>可初始化独立或共享 vault</td><td>一个 vault 一个同步权威</td></tr>
        </tbody></table></div>
        <div class="section-action"><a class="button button--primary" href="${route(basePath, "install")}">选择安装路径 ${icon("arrow")}</a></div>
      </div>
    </section>`;
}

function architectureSourceCards(model) {
  if (!model.architectureSources.length) {
    return `<p class="empty-state">当前构建未发现架构文档索引，请从 GitHub README 开始。</p>`;
  }
  return model.architectureSources
    .slice(0, 12)
    .map(
      (source) => `
      <a class="source-card" href="${escapeHtml(source.href)}" rel="noreferrer">
        <span>Source</span><h3>${escapeHtml(source.title)}</h3><code>${escapeHtml(source.path)}</code>${icon("arrow")}
      </a>`,
    )
    .join("");
}

function renderArchitecture(model, basePath) {
  return `
    ${titleHero({
      label: "Inspectable architecture",
      title: "从执行，到知识，再到可持续召回。",
      description:
        "站点的三层拆解直接对应 Tech Persistence 的真实目录与运行时边界。它不是一张抽象架构图，而是一份可沿路径核验的系统地图。",
      stats: [
        [model.metrics.architectureDocs, " architecture sources"],
        [model.metrics.hooks, " hook events"],
        [model.metrics.mcpTools, " MCP tools"],
      ],
    })}
    <section class="section">
      <div class="shell architecture-flow" data-section="three-layers">
        <article><span>01</span><div><small>Execution layer</small><h2>工作流状态机</h2><p>think、plan、work、test、review、compound 由 sprint 编排；checkpoint 保持长任务可恢复。</p><code>plugins/tech-persistence/codex-skills/</code></div></article>
        <article><span>02</span><div><small>Knowledge layer</small><h2>观察、验证与进化</h2><p>Memory v5、instinct confidence、skill signals、eval traces 与 publish guard 把原始信号转成可复用知识。</p><code>scripts/lib/memory-v5.js · skill-signals.js</code></div></article>
        <article><span>03</span><div><small>Storage layer</small><h2>项目隔离的持久存储</h2><p>compact index、topic notes、solutions、sessions 与 Obsidian graph 保留来源和读写边界。</p><code>~/.codex/homunculus/projects/&lt;hash&gt;/</code></div></article>
      </div>
    </section>
    <section class="section section--contrast">
      <div class="shell">
        ${sectionHeading({
          label: "CONTROL POINTS",
          title: "系统靠可见的门，而不是靠“相信自动化”。",
          description:
            "每个关键状态变化都有明确输入、停止条件、验证证据和恢复路径。",
        })}
        <div class="control-grid">
          <article><span>Scope gate</span><h3>Think</h3><p>锁定用户价值、范围和可观察成功条件。</p></article>
          <article><span>Design gate</span><h3>Plan</h3><p>拆依赖、风险、测试与回滚边界。</p></article>
          <article><span>Evidence gate</span><h3>Work + Test</h3><p>验证深度随影响面和可逆性变化。</p></article>
          <article><span>Quality gate</span><h3>Review</h3><p>安全、架构、质量、性能和测试证据一起审。</p></article>
          <article><span>Knowledge gate</span><h3>Compound</h3><p>只沉淀被当前证据支持、未来可复用的内容。</p></article>
          <article><span>Recovery gate</span><h3>Checkpoint</h3><p>上下文压力升高时保存最小可执行交接。</p></article>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="shell">
        ${sectionHeading({
          label: "SOURCE MAP",
          title: "沿着源文件继续验证。",
          description:
            "这些链接由当前仓库文档投影生成；文档新增或调整会在构建时重新索引。",
        })}
        <div class="source-grid">${architectureSourceCards(model)}</div>
      </div>
    </section>
    <section class="section section--ruled">
      <div class="shell final-cta-inner">
        <div><span class="section-label">[ DESIGN PRINCIPLE ]</span><h2>本地优先、显式边界、证据驱动。</h2><p>任何“已同步”“已学习”“已部署”的结论，都必须能回到文件、命令、日志或远端读回。</p></div>
        <a class="button button--secondary" href="${escapeHtml(`${model.meta.repository.replace(/\/$/, "")}/blob/main/README.md`)}" rel="noreferrer">阅读完整 README ${icon("arrow")}</a>
      </div>
    </section>`;
}

function renderUpdates(model) {
  const updates = model.updates.length
    ? model.updates
    : [
        {
          date: "Current",
          title: `Plugin ${model.meta.version}`,
          summary:
            "Current public projection generated from repository manifests and architecture sources.",
          href: model.meta.repository,
        },
      ];
  return `
    ${titleHero({
      label: "Source-backed updates",
      title: "不翻仓库，也能看见真实演进。",
      description:
        "这里汇总 manifest、架构文档与近期 solution 索引。每条更新都链接回来源，不把构建时间误写成产品发布时间。",
      stats: [
        [`v${model.meta.version}`, " current plugin"],
        [model.metrics.solutions, " solution notes"],
        [model.meta.buildId, " source fingerprint"],
      ],
    })}
    <section class="section">
      <div class="shell timeline">
        ${updates
          .map(
            (update) => `<article><time>${escapeHtml(update.date)}</time><div><h2>${escapeHtml(update.title)}</h2><p>${escapeHtml(update.summary)}</p><a href="${escapeHtml(update.href)}" rel="noreferrer">查看来源 ${icon("arrow")}</a></div></article>`,
          )
          .join("")}
      </div>
    </section>`;
}

function renderInstall(model, basePath) {
  const clone = "git clone https://github.com/songuu/tech-persistence.git";
  return `
    ${titleHero({
      label: "Install from source",
      title: "选择你实际使用的运行时。",
      description:
        "所有命令都来自当前仓库 installer。先 Clone，再选择 Codex、Claude Code plugin 或统一安装；DryRun 可在真正写入前核对计划。",
      stats: [
        ["Node ≥18", " runtime"],
        ["Git", " source install"],
        ["PowerShell", " Windows first"],
      ],
    })}
    <section class="section">
      <div class="shell install-layout">
        <aside class="install-index"><span>Install paths</span><a href="#install-unified">统一安装</a><a href="#install-codex">Codex</a><a href="#install-claude">Claude Code</a><a href="#install-shared">共享记忆</a><a href="#install-verify">验证</a></aside>
        <div class="install-content">
          <article id="install-unified"><span>Recommended on Windows</span><h2>统一安装</h2><p>同时覆盖 Claude legacy、Codex 与 Claude plugin，并保留各自的所有权边界。</p><div class="command-stack">${commandBlock({ id: "install-clone", command: clone })}${commandBlock({ id: "install-all", command: "powershell -ExecutionPolicy Bypass -File .\\install-all.ps1 -All" })}${commandBlock({ id: "install-dry", eyebrow: "preview first", command: "powershell -ExecutionPolicy Bypass -File .\\install-all.ps1 -All -DryRun" })}</div></article>
          <article id="install-codex"><span>Native Codex plugin</span><h2>Codex</h2><p>安装原生 plugin owner、skills、轻量 hooks 与 Memory MCP。</p><div class="command-stack">${commandBlock({ id: "install-codex-command", command: "powershell -ExecutionPolicy Bypass -File .\\install-codex.ps1 -All" })}</div></article>
          <article id="install-claude"><span>Plugin first</span><h2>Claude Code</h2><p>Claude Code 2.1+ 优先使用 plugin installer；legacy installer 只为明确的旧版本场景保留。</p><div class="command-stack">${commandBlock({ id: "install-claude-command", command: "powershell -ExecutionPolicy Bypass -File .\\install-plugin.ps1 -All" })}</div></article>
          <article id="install-shared"><span>Optional, one authority</span><h2>共享记忆</h2><p>让 Claude Code 与 Codex 指向同一个 homunculus/Obsidian vault。路径必须由你明确选择。</p><div class="command-stack">${commandBlock({ id: "install-shared-command", command: 'node scripts\\configure-shared-homunculus.js --path "C:\\Users\\you\\Documents\\TechPersistence"' })}</div><p class="callout">云端或客户端可见性仍需分别验证。脚本成功不等于 Obsidian Sync、OneDrive 或其他客户端已经完成同步。</p></article>
          <article id="install-verify"><span>Trust, then verify</span><h2>安装后验证</h2><p>运行时、插件包与跨平台 smoke 分开核验，避免把“文件已复制”误报成“全部可用”。</p><div class="command-stack">${commandBlock({ id: "verify-plugin", command: "node scripts\\validate-codex-plugin.js" })}${commandBlock({ id: "verify-install", command: "node scripts\\validate-codex-install.js --project" })}${commandBlock({ id: "verify-cross", command: "node scripts\\smoke-cross-platform.js" })}</div></article>
        </div>
      </div>
    </section>
    <section class="section section--ruled">
      <div class="shell final-cta-inner"><div><span class="section-label">[ NEED CONTEXT? ]</span><h2>先看能力目录，再决定装多深。</h2><p>目录按真实源文件生成，能直接看到每个 workflow 的用途与路径。</p></div><a class="button button--secondary" href="${route(basePath, "catalog")}">浏览能力 ${icon("arrow")}</a></div>
    </section>`;
}

function renderStatus(model) {
  const generated = Number.isNaN(Date.parse(model.meta.generatedAt))
    ? model.meta.generatedAt
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(new Date(model.meta.generatedAt));
  return `
    ${titleHero({
      label: "Build status",
      title: "这份页面与哪个仓库状态对应？",
      description:
        "状态页只陈述当前静态发布能证明的事情：源指纹、生成时间、manifest 版本与发现计数。运行时和云同步健康不在这里冒充成功。",
      stats: [
        [model.meta.buildId, " build id"],
        [`v${model.meta.version}`, " manifest"],
        [generated, " generated"],
      ],
    })}
    <section class="section">
      <div class="shell status-grid">
        <article class="status-card status-card--ok"><span><i></i>Generated</span><h2>Repository projection</h2><p>本次构建读取了 skills、commands、hooks、manifest、README 与架构文档索引。</p><dl><div><dt>Codex skills</dt><dd>${escapeHtml(model.metrics.codexSkills)}</dd></div><div><dt>Claude commands</dt><dd>${escapeHtml(model.metrics.claudeCommands)}</dd></div><div><dt>Architecture docs</dt><dd>${escapeHtml(model.metrics.architectureDocs)}</dd></div></dl></article>
        <article class="status-card"><span>Boundary</span><h2>Not asserted here</h2><p>此页不推断本地安装、MCP 进程、Obsidian 客户端、远端同步或第三方服务是否健康。</p><ul><li>安装状态需运行 validator</li><li>同步状态需读回目标端</li><li>部署状态需 loopback + public probe</li></ul></article>
        <article class="status-card"><span>Source</span><h2>Review the exact revision</h2><p>构建 ID 由公开投影输入计算，用于把线上页面与源树快照关联。</p><a href="${escapeHtml(model.meta.repository)}" rel="noreferrer">打开 GitHub ${icon("arrow")}</a></article>
      </div>
    </section>`;
}

function renderNotFound(basePath) {
  return `
    <section class="section not-found">
      <div class="shell"><span class="section-label">[ 404 ]</span><h1>这条记忆路径不存在。</h1><p>返回公开入口，或从能力目录重新定位。</p><div class="hero-actions"><a class="button button--primary" href="${route(basePath)}">返回首页</a><a class="button button--secondary" href="${route(basePath, "catalog")}">能力目录</a></div></div>
    </section>`;
}

function renderSitePages(input, options = {}) {
  const model = normalizeModel(input);
  const basePath = normalizeBasePath(options.basePath || "/tech-persistence/");
  const common = { model, basePath };
  return {
    "index.html": shell({
      ...common,
      page: "home",
      title: "Tech Persistence",
      description: model.meta.description,
      body: renderHome(model, basePath),
    }),
    "catalog/index.html": shell({
      ...common,
      page: "catalog",
      title: "能力目录",
      description:
        "从 Tech Persistence 当前仓库生成的 skills、commands 与工作流目录。",
      body: renderCatalog(model, basePath),
    }),
    "platforms/index.html": shell({
      ...common,
      page: "platforms",
      title: "平台支持",
      description:
        "Claude Code、Codex 与共享 Obsidian vault 的真实支持面和运行时边界。",
      body: renderPlatforms(model, basePath),
    }),
    "architecture/index.html": shell({
      ...common,
      page: "architecture",
      title: "系统架构",
      description:
        "Tech Persistence 的执行层、知识层、存储层与证据门。",
      body: renderArchitecture(model, basePath),
    }),
    "updates/index.html": shell({
      ...common,
      page: "updates",
      title: "更新记录",
      description:
        "从 Tech Persistence manifest、架构文档与 solution 索引投影的更新。",
      body: renderUpdates(model),
    }),
    "install/index.html": shell({
      ...common,
      page: "install",
      title: "安装",
      description:
        "Tech Persistence 面向 Codex、Claude Code 与共享记忆的真实安装路径。",
      body: renderInstall(model, basePath),
    }),
    "status/index.html": shell({
      ...common,
      page: "status",
      title: "构建状态",
      description:
        "Tech Persistence 公开站点的源指纹、生成时间与能力发现状态。",
      body: renderStatus(model),
    }),
    "404.html": shell({
      ...common,
      page: "not-found",
      title: "未找到",
      description: "Tech Persistence 页面未找到。",
      body: renderNotFound(basePath),
    }),
  };
}

module.exports = {
  escapeHtml,
  normalizeBasePath,
  normalizeModel,
  renderSitePages,
};

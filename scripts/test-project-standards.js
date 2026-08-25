#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectProjectProfiles,
  installProjectStandards,
  loadProjectStandardsCatalog,
  main,
  planProjectStandards,
  resolveAssets,
  validateProjectStandards,
} = require('./project-standards');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-standards-'));
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createCanonicalSource(root) {
  const profileNames = [
    'base',
    'frontend',
    'backend',
    'agent',
    'data',
    'infrastructure',
    'library',
    'monorepo',
    'fullstack',
    'unknown',
  ];
  const profiles = {};
  for (const name of profileNames) {
    const relative = `profiles/${name}/rules/architecture-${name}.md`;
    profiles[name] = {
      description: `${name} profile`,
      scopes: name === 'base' || name === 'unknown' ? ['**/*'] : [`${name}/**/*`],
      rules: [relative],
    };
    write(
      path.join(root, ...relative.split('/')),
      `# ${name}\n\nRead .claude/project-standards.json before ${name} work in Claude Code.\n`
    );
  }
  write(
    path.join(root, '.claude', 'commands', 'project-audit.md'),
    '---\ndescription: "Audit project standards"\n---\n\n# project-audit\n\nRead {{RUNTIME_DIR}}/project-standards.json and {{ENTRYPOINT}}. Compare {{SIBLING_RUNTIME_DIR}}/project-standards.json and {{SIBLING_ENTRYPOINT}}.\n'
  );
  write(
    path.join(root, '.claude', 'skills', 'project-standards', 'SKILL.md'),
    '---\nname: project-standards\ndescription: Route project standards.\n---\n\n# Project standards\n\nRead `.claude/rules/`.\n'
  );
  write(
    path.join(root, '.claude', 'skills', 'project-standards', 'references', 'audit.md'),
    '# Audit reference\n'
  );
  writeJson(path.join(root, 'profiles', 'catalog.json'), {
    schemaVersion: 1,
    shared: {
      commands: ['.claude/commands/project-audit.md'],
      skills: ['.claude/skills/project-standards'],
    },
    profiles,
  });
}

try {
  test('production catalog is complete and every project installer uses the shared resolver', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const catalog = loadProjectStandardsCatalog(path.join(repoRoot, 'project-level'));
    assert.deepStrictEqual(Object.keys(catalog.profiles), [
      'base', 'frontend', 'backend', 'agent', 'data', 'infrastructure', 'library',
      'monorepo', 'fullstack', 'unknown',
    ]);
    assert.deepStrictEqual(catalog.retiredAssets, []);
    assert.deepStrictEqual(catalog.legacyMarkerHashes, {
      entrypoint: { claude: [], codex: [] },
      attributes: [],
    });
    for (const [installer, runtime] of [
      ['install.ps1', 'claude'],
      ['install.sh', 'claude'],
      ['install-codex.ps1', 'codex'],
      ['install-codex.sh', 'codex'],
    ]) {
      const content = fs.readFileSync(path.join(repoRoot, installer), 'utf8');
      assert.ok(content.includes('project-standards.js'), `${installer} missing shared resolver`);
      assert.ok(content.includes(`--runtime ${runtime}`), `${installer} missing ${runtime} projection`);
      assert.ok(content.includes('--profiles auto'), `${installer} missing evidence-based detection`);
    }
    const installPs1 = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    const installSh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    const installCodexPs1 = fs.readFileSync(path.join(repoRoot, 'install-codex.ps1'), 'utf8');
    const installCodexSh = fs.readFileSync(path.join(repoRoot, 'install-codex.sh'), 'utf8');
    assert.ok(!installPs1.includes('Safe-Copy $_.FullName (Join-Path $cd "commands/'),
      'Claude PowerShell installer must not overwrite catalog-managed commands before the resolver');
    assert.ok(!installSh.includes('safe_copy "${SCRIPT_DIR}/project-level/.claude/commands/'),
      'Claude Bash installer must not overwrite catalog-managed commands before the resolver');
    assert.ok(!installCodexPs1.includes('$projectCommands = Copy-CodexCommandDir $projectCommandDir'),
      'Codex PowerShell installer must leave project commands to the conflict-aware resolver');
    assert.ok(!installCodexSh.includes('project_commands="$(copy_codex_commands "${SCRIPT_DIR}/project-level/.claude/commands"'),
      'Codex Bash installer must leave project commands to the conflict-aware resolver');
    assert.ok(installCodexSh.includes('"${CODEX_HOME}/commands" true)"'),
      'Codex Bash user install must keep user learn while excluding native duplicates');
    assert.ok(installCodexSh.includes('"${codex_dir}/commands" true true)"'),
      'Codex Bash project install must separately exclude catalog-managed commands');
    assert.ok(installCodexSh.includes('project-level/profiles/catalog.json'));
    assert.ok(!installCodexSh.includes('debug-journal.md|learn.md|project-audit.md|retrospective.md'));
    assert.ok(installCodexPs1.includes('$catalog.shared.commands'));
    const attributes = fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
    assert.ok(attributes.includes('# tech-persistence:project-standards:start'));
    assert.ok(attributes.includes('/.claude/**/*.md text eol=lf'));
    assert.ok(attributes.includes('/.codex/**/*.md text eol=lf'));
    assert.ok(attributes.includes('/.claude/project-standards.json text eol=lf'));
    assert.ok(attributes.includes('/.codex/project-standards.json text eol=lf'));
    assert.ok(attributes.trimEnd().endsWith('# tech-persistence:project-standards:end'));
    assert.ok(
      fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8').includes('hook-exit-codes.md'),
      'Claude Bash installer must not omit the hook exit-code project rule'
    );
    const learnCommand = fs.readFileSync(
      path.join(repoRoot, 'project-level', '.claude', 'commands', 'learn.md'),
      'utf8'
    );
    const debugCommand = fs.readFileSync(
      path.join(repoRoot, 'project-level', '.claude', 'commands', 'debug-journal.md'),
      'utf8'
    );
    const retrospectiveCommand = fs.readFileSync(
      path.join(repoRoot, 'project-level', '.claude', 'commands', 'retrospective.md'),
      'utf8'
    );
    assert.ok(learnCommand.includes('LearningCandidate'));
    assert.ok(!learnCommand.includes('写入 `.claude/rules/` 和'));
    assert.ok(debugCommand.includes('EvidenceRef'));
    assert.ok(!debugCommand.includes('自动创建 debugging'));
    assert.ok(!retrospectiveCommand.includes('observations.jsonl > 5MB → 自动归档'));
    const auditCommand = fs.readFileSync(
      path.join(repoRoot, 'project-level', '.claude', 'commands', 'project-audit.md'),
      'utf8'
    );
    assert.ok(auditCommand.includes('`shared`'));
    const standardsSkill = fs.readFileSync(
      path.join(repoRoot, 'project-level', '.claude', 'skills', 'project-standards', 'SKILL.md'),
      'utf8'
    );
    for (const phase of ['--detect-only', '--dry-run', '--runtime both', '--check']) {
      assert.ok(standardsSkill.includes(phase), `project standards skill missing controlled init phase: ${phase}`);
    }
    const codexSkill = resolveAssets({
      sourceRoot: path.join(repoRoot, 'project-level'),
      catalog,
      profiles: ['base'],
      runtime: 'codex',
    }).find((asset) => asset.path === 'skills/project-standards/SKILL.md').content;
    assert.ok(!codexSkill.includes('`.codex` 或 `.codex`'));
  });

  test('detects additive frontend, backend, agent, infrastructure, fullstack, and monorepo profiles', () => {
    const root = path.join(tempRoot, 'detect-composite');
    writeJson(path.join(root, 'package.json'), {
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      dependencies: {
        react: '^19.0.0',
        express: '^5.0.0',
        langchain: '^1.0.0',
      },
    });
    writeJson(path.join(root, 'apps', 'web', 'package.json'), {
      dependencies: { vite: '^8.0.0' },
    });
    write(path.join(root, 'prompts', 'system.md'), '# prompt\n');
    write(path.join(root, 'Dockerfile'), 'FROM node:22\n');

    const detected = detectProjectProfiles(root);
    assert.deepStrictEqual(detected.profiles, [
      'base', 'frontend', 'backend', 'agent', 'infrastructure', 'monorepo', 'fullstack',
    ]);
    for (const profile of detected.profiles.slice(1)) {
      assert.ok(
        detected.evidence.some((entry) => entry.profile === profile),
        `missing evidence for ${profile}`
      );
    }
    assert.ok(!detected.evidence.some((entry) => /AGENTS\.md|CLAUDE\.md/.test(entry.source)));
  });

  test('detects backend and data ecosystems without assuming a frontend', () => {
    const root = path.join(tempRoot, 'detect-python');
    write(
      path.join(root, 'pyproject.toml'),
      '[project]\ndependencies = ["fastapi", "sqlalchemy", "pandas", "apache-airflow"]\n'
    );
    write(path.join(root, 'migrations', '001_init.sql'), 'select 1;\n');
    const detected = detectProjectProfiles(root);
    assert.ok(detected.profiles.includes('backend'));
    assert.ok(detected.profiles.includes('data'));
    assert.ok(!detected.profiles.includes('frontend'));
    assert.ok(!detected.profiles.includes('unknown'));
  });

  test('reports the exact package manifest that supplied each monorepo dependency signal', () => {
    const root = path.join(tempRoot, 'detect-child-package-evidence');
    writeJson(path.join(root, 'apps', 'web', 'package.json'), {
      dependencies: { react: '^19.0.0', express: '^5.0.0', langchain: '^1.0.0' },
    });
    const detected = detectProjectProfiles(root);
    for (const profile of ['frontend', 'backend', 'agent']) {
      const dependencyEvidence = detected.evidence.find(
        (entry) => entry.profile === profile && entry.signal.includes('dependency:')
      );
      assert.strictEqual(dependencyEvidence.source, 'apps/web/package.json');
    }
  });

  test('uses discovery-first unknown profile when architecture evidence is absent', () => {
    const root = path.join(tempRoot, 'detect-unknown');
    fs.mkdirSync(root, { recursive: true });
    write(path.join(root, 'README.md'), '# empty project\n');
    assert.deepStrictEqual(detectProjectProfiles(root).profiles, ['base', 'unknown']);
  });

  test('ignores empty architecture directories and uses stable Agent implementation evidence', () => {
    const root = path.join(tempRoot, 'detect-empty-agent-directory');
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    write(path.join(root, 'README.md'), '# project without implementation evidence\n');
    assert.deepStrictEqual(detectProjectProfiles(root).profiles, ['base', 'unknown']);

    write(path.join(root, 'agents', '.gitkeep'), '');
    assert.deepStrictEqual(detectProjectProfiles(root).profiles, ['base', 'unknown']);

    for (const [name, content] of [
      ['.DS_Store', 'local metadata\n'],
      ['debug.log', 'local log\n'],
      ['.env.local', 'SECRET=not-architecture-evidence\n'],
      ['settings.local.json', '{}\n'],
    ]) {
      write(path.join(root, 'agents', name), content);
    }
    assert.deepStrictEqual(detectProjectProfiles(root).profiles, ['base', 'unknown']);

    write(path.join(root, 'scripts', 'agent-orchestrator.js'), 'module.exports = {};\n');
    const detected = detectProjectProfiles(root);
    assert.ok(detected.profiles.includes('agent'));
    assert.ok(detected.evidence.some((entry) => (
      entry.profile === 'agent' && entry.source === 'scripts/agent-orchestrator.js'
    )));
  });

  test('does not follow linked or non-file architecture evidence', () => {
    const root = path.join(tempRoot, 'detect-linked-evidence');
    write(path.join(root, 'src', 'app', 'page.tsx'), 'export default function Page() {}\n');
    write(path.join(root, 'vite.config.ts', 'not-a-config.ts'), 'export default {};\n');
    assert.deepStrictEqual(detectProjectProfiles(root).profiles, ['base', 'unknown']);

    const external = path.join(tempRoot, 'external-fastapi-pyproject.toml');
    write(external, '[project]\ndependencies = ["fastapi"]\n');
    const linkedManifest = path.join(root, 'pyproject.toml');
    try {
      fs.symlinkSync(external, linkedManifest, 'file');
      assert.ok(!detectProjectProfiles(root).profiles.includes('backend'));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error && error.code)) throw error;
    }
  });

  test('does not treat a single-package pnpm workspace with policy sections as a monorepo', () => {
    const root = path.join(tempRoot, 'single-package-workspace');
    writeJson(path.join(root, 'package.json'), { dependencies: { react: '^19.0.0' } });
    write(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nallowBuilds:\n  esbuild: true\n\noverrides:\n  vite: 8.0.0\n'
    );
    writeJson(path.join(root, '.opencode', 'package.json'), { dependencies: { helper: '1.0.0' } });
    const detected = detectProjectProfiles(root);
    assert.ok(detected.profiles.includes('frontend'));
    assert.ok(!detected.profiles.includes('monorepo'));

    const slashRoot = path.join(tempRoot, 'single-package-workspace-slash');
    writeJson(path.join(slashRoot, 'package.json'), {
      workspaces: ['./'],
      dependencies: { react: '^19.0.0' },
    });
    write(
      path.join(slashRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - ./ # root only\n  - \'./\'\n  - \'!**/fixtures/**\'\n'
    );
    assert.ok(!detectProjectProfiles(slashRoot).profiles.includes('monorepo'));
  });

  test('detects common Java backend, Agent, Rust library, and Go library manifests', () => {
    const javaRoot = path.join(tempRoot, 'detect-java-backend');
    write(path.join(javaRoot, 'pom.xml'), '<artifactId>spring-boot-starter-web</artifactId>\n');
    assert.ok(detectProjectProfiles(javaRoot).profiles.includes('backend'));

    const agentRoot = path.join(tempRoot, 'detect-openai-agent');
    writeJson(path.join(agentRoot, 'package.json'), { dependencies: { '@openai/agents': '^1.0.0' } });
    assert.ok(detectProjectProfiles(agentRoot).profiles.includes('agent'));

    const rustRoot = path.join(tempRoot, 'detect-rust-library');
    write(path.join(rustRoot, 'Cargo.toml'), '[package]\nname = "demo"\n\n[lib]\npath = "src/lib.rs"\n');
    assert.ok(detectProjectProfiles(rustRoot).profiles.includes('library'));

    const diagnosticsRoot = path.join(tempRoot, 'detect-rust-diagnostics-library');
    write(
      path.join(diagnosticsRoot, 'Cargo.toml'),
      '[package]\nname = "diagnostics-lib"\n\n[dependencies]\ndiagnostics = "1"\n\n[lib]\npath = "src/lib.rs"\n'
    );
    const diagnosticsProfiles = detectProjectProfiles(diagnosticsRoot).profiles;
    assert.ok(diagnosticsProfiles.includes('library'));
    assert.ok(!diagnosticsProfiles.includes('agent'));

    const goRoot = path.join(tempRoot, 'detect-go-library');
    write(path.join(goRoot, 'go.mod'), 'module example.com/demo\n\ngo 1.24\n');
    write(path.join(goRoot, 'demo.go'), 'package demo\n');
    assert.ok(detectProjectProfiles(goRoot).profiles.includes('library'));
  });

  test('expands an explicit fullstack shorthand into frontend and backend profiles', () => {
    const root = path.join(tempRoot, 'explicit-fullstack');
    fs.mkdirSync(root, { recursive: true });
    const sourceRoot = path.join(tempRoot, 'explicit-fullstack-source');
    createCanonicalSource(sourceRoot);
    const planned = installProjectStandards({
      projectRoot: root,
      sourceRoot,
      runtime: 'claude',
      profiles: ['fullstack'],
    });
    assert.deepStrictEqual(planned.profiles, ['base', 'frontend', 'backend', 'fullstack']);
    assert.strictEqual(validateProjectStandards({
      projectRoot: root,
      sourceRoot,
      runtime: 'claude',
      profiles: ['backend'],
    }).valid, false);
  });

  test('preserves an existing explicit profile selection across automatic installer updates', () => {
    const root = path.join(tempRoot, 'preserve-explicit-selection');
    const sourceRoot = path.join(tempRoot, 'preserve-explicit-source');
    fs.mkdirSync(root, { recursive: true });
    createCanonicalSource(sourceRoot);
    installProjectStandards({
      projectRoot: root,
      sourceRoot,
      runtime: 'both',
      profiles: ['frontend', 'agent'],
    });

    const updated = installProjectStandards({
      projectRoot: root,
      sourceRoot,
      runtime: 'both',
      profiles: 'auto',
    });
    assert.strictEqual(updated.mode, 'explicit');
    assert.deepStrictEqual(updated.profiles, ['base', 'frontend', 'agent']);
    assert.deepStrictEqual(updated.results.claude.retired, []);
    assert.deepStrictEqual(updated.results.codex.retired, []);

    const refreshed = installProjectStandards({
      projectRoot: root,
      sourceRoot,
      runtime: 'both',
      profiles: 'auto',
      refreshAuto: true,
    });
    assert.strictEqual(refreshed.mode, 'auto');
    assert.deepStrictEqual(refreshed.profiles, ['base', 'unknown']);
  });

  test('validates canonical catalog, scopes, skill frontmatter, and non-empty skill trees', () => {
    const sourceRoot = path.join(tempRoot, 'catalog');
    createCanonicalSource(sourceRoot);
    const catalog = loadProjectStandardsCatalog(sourceRoot);
    assert.strictEqual(catalog.schemaVersion, 1);
    assert.ok(catalog.profiles.frontend.rules.length > 0);

    const skillRoot = path.join(sourceRoot, '.claude', 'skills', 'project-standards');
    for (const forbiddenName of [
      'settings.local.yaml', 'package-lock.json', 'pnpm-lock.yaml', 'debug.log', '.DS_Store', 'Thumbs.db',
      '.env', '.env.local', '.env.production.local', 'credentials.json', 'secrets.json',
      '.git/config', 'node_modules/x/index.js', '__pycache__/cache.pyc', '.venv/pyvenv.cfg',
    ]) {
      const pathSegments = forbiddenName.split('/');
      const forbiddenLocal = path.join(skillRoot, ...pathSegments);
      write(forbiddenLocal, 'ephemeral\n');
      assert.throws(
        () => loadProjectStandardsCatalog(sourceRoot),
        /local|ephemeral|forbidden/i,
        `canonical skill accepted forbidden local asset: ${forbiddenName}`
      );
      fs.rmSync(path.join(skillRoot, pathSegments[0]), { recursive: true, force: true });
    }

    write(path.join(sourceRoot, '.claude', 'skills', 'project-standards', 'SKILL.md'), '# invalid\n');
    assert.throws(() => loadProjectStandardsCatalog(sourceRoot), /frontmatter|name|description/i);
  });

  test('installs deterministic Claude and Codex projections from one canonical source', () => {
    const sourceRoot = path.join(tempRoot, 'install-source');
    const projectRoot = path.join(tempRoot, 'install-project');
    createCanonicalSource(sourceRoot);
    writeJson(path.join(projectRoot, 'package.json'), { dependencies: { react: '^19.0.0' } });
    write(path.join(projectRoot, 'CLAUDE.md'), '# Custom Claude instructions\n');
    write(path.join(projectRoot, 'AGENTS.md'), '# Custom Codex instructions\n');
    write(path.join(projectRoot, '.gitattributes'), '# User-owned attributes stay intact\n');

    const installed = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
    });
    assert.deepStrictEqual(installed.profiles, ['base', 'frontend']);
    assert.deepStrictEqual(installed.results.claude.conflicts, []);
    assert.deepStrictEqual(installed.results.codex.conflicts, []);

    const claudeManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.claude', 'project-standards.json'), 'utf8')
    );
    const codexManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.codex', 'project-standards.json'), 'utf8')
    );
    assert.deepStrictEqual(claudeManifest.profiles, ['base', 'frontend']);
    assert.deepStrictEqual(codexManifest.profiles, claudeManifest.profiles);
    assert.deepStrictEqual(Object.keys(claudeManifest.scopes), ['base', 'frontend']);
    assert.strictEqual(claudeManifest.attributes.path, '.gitattributes');
    assert.deepStrictEqual(codexManifest.attributes, claudeManifest.attributes);
    assert.deepStrictEqual(
      codexManifest.assets.map((entry) => [entry.kind, entry.profile, entry.path]),
      claudeManifest.assets.map((entry) => [entry.kind, entry.profile, entry.path])
    );
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'project-standards', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'project-standards', 'SKILL.md')));
    assert.ok(
      fs.readFileSync(path.join(projectRoot, '.codex', 'rules', 'architecture-frontend.md'), 'utf8')
        .includes('.codex/project-standards.json')
    );
    assert.ok(
      fs.readFileSync(path.join(projectRoot, '.codex', 'rules', 'architecture-frontend.md'), 'utf8')
        .includes('Codex')
    );
    const codexAudit = fs.readFileSync(
      path.join(projectRoot, '.codex', 'commands', 'project-audit.md'),
      'utf8'
    );
    assert.ok(codexAudit.includes('.codex/project-standards.json'));
    assert.ok(codexAudit.includes('.claude/project-standards.json'));
    assert.ok(codexAudit.includes('AGENTS.md'));
    assert.ok(codexAudit.includes('CLAUDE.md'));
    assert.ok(fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8').includes('tech-persistence:project-standards:start'));
    assert.ok(fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8').includes('tech-persistence:project-standards:start'));
    const attributesPath = path.join(projectRoot, '.gitattributes');
    const originalAttributes = fs.readFileSync(attributesPath, 'utf8');
    assert.ok(originalAttributes.startsWith('# User-owned attributes stay intact\n'));
    assert.ok(originalAttributes.includes('/.claude/**/*.md text eol=lf'));
    assert.ok(originalAttributes.includes('/.codex/**/*.md text eol=lf'));
    assert.ok(originalAttributes.trimEnd().endsWith('# tech-persistence:project-standards:end'));
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' }).valid, true);
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid, true);

    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    const originalAgents = fs.readFileSync(agentsPath, 'utf8');
    fs.writeFileSync(agentsPath, originalAgents.replace(
      'Treat detected profiles as evidence',
      'Treat detected profiles as guesses'
    ));
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid, false);
    const entrypointConflict = installProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' });
    assert.ok(entrypointConflict.results.codex.conflicts.some((entry) => entry.path === 'AGENTS.md'));
    assert.ok(fs.readFileSync(agentsPath, 'utf8').includes('Treat detected profiles as guesses'));
    fs.writeFileSync(agentsPath, originalAgents);

    const frontendRule = path.join(projectRoot, '.codex', 'rules', 'architecture-frontend.md');
    const originalRule = fs.readFileSync(frontendRule, 'utf8');
    fs.writeFileSync(frontendRule, originalRule.replace(/\n/g, '\r\n'));
    assert.strictEqual(
      validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid,
      false,
      'manifest hashes must bind exact output bytes, including line endings'
    );
    fs.writeFileSync(frontendRule, originalRule);
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' });
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid, true);

    fs.appendFileSync(attributesPath, '*.md -text\n');
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid, false);
    const attributesConflict = installProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' });
    assert.ok(attributesConflict.results.codex.conflicts.some((entry) => entry.path === '.gitattributes'));
    assert.ok(fs.readFileSync(attributesPath, 'utf8').endsWith('*.md -text\n'));
    fs.writeFileSync(attributesPath, originalAttributes);
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' });

    const claudeBase = path.join(projectRoot, '.claude', 'rules', 'architecture-base.md');
    const originalClaudeBase = fs.readFileSync(claudeBase, 'utf8');
    fs.appendFileSync(claudeBase, 'sibling drift\n');
    const siblingValidation = validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' });
    assert.strictEqual(siblingValidation.valid, false);
    assert.ok(siblingValidation.issues.some((issue) => /sibling|claude|hash/i.test(`${issue.path} ${issue.reason}`)));
    fs.writeFileSync(claudeBase, originalClaudeBase);

    const second = installProjectStandards({ projectRoot, sourceRoot, runtime: 'both' });
    assert.deepStrictEqual(second.results.claude.updated, []);
    assert.deepStrictEqual(second.results.codex.updated, []);
    assert.deepStrictEqual(second.results.claude.conflicts, []);
  });

  test('dry-run previews creates, updates, retirements, and conflicts without mutating a new project', () => {
    const sourceRoot = path.join(tempRoot, 'dry-run-source');
    const projectRoot = path.join(tempRoot, 'dry-run-project');
    createCanonicalSource(sourceRoot);
    fs.mkdirSync(projectRoot, { recursive: true });

    const freshPlan = planProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
      profiles: ['frontend'],
    });
    assert.ok(freshPlan.results.claude.created.includes('rules/architecture-frontend.md'));
    assert.ok(freshPlan.results.codex.created.includes('rules/architecture-frontend.md'));
    assert.strictEqual(freshPlan.results.claude.attributes.status, 'updated');
    assert.strictEqual(freshPlan.results.codex.entrypoint.status, 'updated');
    assert.deepStrictEqual(fs.readdirSync(projectRoot), []);

    const collision = path.join(projectRoot, '.claude', 'rules', 'architecture-base.md');
    write(collision, '# user-owned base rule\n');
    const before = fs.readFileSync(collision, 'utf8');
    const conflictPlan = planProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['frontend'],
    });
    assert.ok(conflictPlan.results.claude.conflicts.some(
      (entry) => entry.path === 'rules/architecture-base.md'
    ));
    assert.strictEqual(fs.readFileSync(collision, 'utf8'), before);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.claude', 'project-standards.json')), false);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')), false);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.gitattributes')), false);

    const installedRoot = path.join(tempRoot, 'dry-run-installed-project');
    fs.mkdirSync(installedRoot, { recursive: true });
    installProjectStandards({
      projectRoot: installedRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['frontend'],
    });
    const installedManifest = path.join(installedRoot, '.claude', 'project-standards.json');
    const installedFrontend = path.join(installedRoot, '.claude', 'rules', 'architecture-frontend.md');
    const beforeManifest = fs.readFileSync(installedManifest, 'utf8');
    const beforeFrontend = fs.readFileSync(installedFrontend, 'utf8');
    const switchPlan = planProjectStandards({
      projectRoot: installedRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['backend'],
    });
    assert.ok(switchPlan.results.claude.created.includes('rules/architecture-backend.md'));
    assert.ok(switchPlan.results.claude.retired.some(
      (entry) => entry.path === 'rules/architecture-frontend.md'
    ));
    assert.strictEqual(fs.readFileSync(installedManifest, 'utf8'), beforeManifest);
    assert.strictEqual(fs.readFileSync(installedFrontend, 'utf8'), beforeFrontend);
    assert.strictEqual(fs.existsSync(path.join(installedRoot, '.claude', 'rules', 'architecture-backend.md')), false);
  });

  test('migrates only explicitly allowlisted legacy generated assets', () => {
    const sourceRoot = path.join(tempRoot, 'legacy-source');
    const projectRoot = path.join(tempRoot, 'legacy-project');
    createCanonicalSource(sourceRoot);
    const legacy = '# legacy generated project audit\n';
    const catalogPath = path.join(sourceRoot, 'profiles', 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    catalog.legacyHashes = {
      'commands/project-audit.md': {
        claude: [crypto.createHash('sha256').update(legacy).digest('hex')],
      },
    };
    writeJson(catalogPath, catalog);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    write(path.join(projectRoot, '.claude', 'commands', 'project-audit.md'), legacy);

    const result = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['unknown'],
    });
    assert.deepStrictEqual(result.results.claude.conflicts, []);
    assert.ok(result.results.claude.updated.includes('commands/project-audit.md'));
    assert.ok(!fs.readFileSync(
      path.join(projectRoot, '.claude', 'commands', 'project-audit.md'),
      'utf8'
    ).includes('legacy generated'));
  });

  test('retires catalog-removed assets only through hash-bound tombstones', () => {
    const sourceRoot = path.join(tempRoot, 'tombstone-source');
    const projectRoot = path.join(tempRoot, 'tombstone-project');
    createCanonicalSource(sourceRoot);
    fs.mkdirSync(projectRoot, { recursive: true });
    installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
      profiles: ['unknown'],
    });
    const claudeManifest = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.claude', 'project-standards.json'),
      'utf8'
    ));
    const codexManifest = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.codex', 'project-standards.json'),
      'utf8'
    ));
    const assetPath = 'commands/project-audit.md';
    const claudeAsset = claudeManifest.assets.find((asset) => asset.path === assetPath);
    const codexAsset = codexManifest.assets.find((asset) => asset.path === assetPath);
    const catalogPath = path.join(sourceRoot, 'profiles', 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    catalog.shared.commands = [];
    catalog.retiredAssets = [{
      kind: claudeAsset.kind,
      profile: claudeAsset.profile,
      source: claudeAsset.source,
      path: claudeAsset.path,
      hashes: {
        claude: [claudeAsset.sha256],
        codex: [codexAsset.sha256],
      },
    }];
    writeJson(catalogPath, catalog);
    fs.rmSync(path.join(sourceRoot, '.claude', 'commands', 'project-audit.md'));

    const retired = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
      profiles: ['unknown'],
    });
    for (const runtime of ['claude', 'codex']) {
      assert.deepStrictEqual(retired.results[runtime].conflicts, []);
      assert.ok(retired.results[runtime].retired.some((asset) => asset.path === assetPath));
      assert.strictEqual(fs.existsSync(path.join(projectRoot, `.${runtime}`, ...assetPath.split('/'))), false);
      assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime }).valid, true);
    }

    catalog.retiredAssets[0].path = 'commands/settings.local.json';
    writeJson(catalogPath, catalog);
    assert.throws(
      () => loadProjectStandardsCatalog(sourceRoot),
      /retired|local|identity/i
    );
  });

  test('upgrades proven-owned entrypoint and attributes blocks through marker allowlists', () => {
    const sourceRoot = path.join(tempRoot, 'marker-upgrade-source');
    const projectRoot = path.join(tempRoot, 'marker-upgrade-project');
    createCanonicalSource(sourceRoot);
    fs.mkdirSync(projectRoot, { recursive: true });
    installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
      profiles: ['unknown'],
    });

    const markerHashes = { entrypoint: { claude: [], codex: [] }, attributes: [] };
    for (const [runtime, entryName] of [['claude', 'CLAUDE.md'], ['codex', 'AGENTS.md']]) {
      const entryPath = path.join(projectRoot, entryName);
      const current = fs.readFileSync(entryPath, 'utf8');
      const start = current.indexOf('<!-- tech-persistence:project-standards:start -->');
      const endMarker = '<!-- tech-persistence:project-standards:end -->';
      const end = current.indexOf(endMarker, start) + endMarker.length;
      const currentBlock = current.slice(start, end);
      const legacyBlock = currentBlock.replace('Treat detected profiles', 'Treat legacy profiles');
      fs.writeFileSync(entryPath, `${current.slice(0, start)}${legacyBlock}${current.slice(end)}`);
      const legacyHash = crypto.createHash('sha256').update(legacyBlock).digest('hex');
      markerHashes.entrypoint[runtime].push(legacyHash);
      const manifestPath = path.join(projectRoot, `.${runtime}`, 'project-standards.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.entrypoint.markerSha256 = legacyHash;
      writeJson(manifestPath, manifest);
    }

    const attributesPath = path.join(projectRoot, '.gitattributes');
    const attributes = fs.readFileSync(attributesPath, 'utf8');
    const attributesStart = attributes.indexOf('# tech-persistence:project-standards:start');
    const attributesEndMarker = '# tech-persistence:project-standards:end';
    const attributesEnd = attributes.indexOf(attributesEndMarker, attributesStart) + attributesEndMarker.length;
    const attributesBlock = attributes.slice(attributesStart, attributesEnd);
    const legacyAttributesBlock = attributesBlock.replace('/.codex/**/*.svg text eol=lf\n', '');
    fs.writeFileSync(
      attributesPath,
      `${attributes.slice(0, attributesStart)}${legacyAttributesBlock}${attributes.slice(attributesEnd)}`
    );
    const legacyAttributesHash = crypto.createHash('sha256').update(legacyAttributesBlock).digest('hex');
    markerHashes.attributes.push(legacyAttributesHash);
    for (const runtime of ['claude', 'codex']) {
      const manifestPath = path.join(projectRoot, `.${runtime}`, 'project-standards.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.attributes.markerSha256 = legacyAttributesHash;
      writeJson(manifestPath, manifest);
    }

    const catalogPath = path.join(sourceRoot, 'profiles', 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    catalog.legacyMarkerHashes = markerHashes;
    writeJson(catalogPath, catalog);
    const upgraded = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'both',
      profiles: ['unknown'],
    });
    assert.deepStrictEqual(upgraded.results.claude.conflicts, []);
    assert.deepStrictEqual(upgraded.results.codex.conflicts, []);
    assert.strictEqual(upgraded.results.claude.attributes.status, 'updated');
    assert.strictEqual(upgraded.results.codex.attributes.status, 'unchanged');
    assert.strictEqual(upgraded.results.claude.entrypoint.status, 'updated');
    assert.strictEqual(upgraded.results.codex.entrypoint.status, 'updated');
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' }).valid, true);
    assert.strictEqual(validateProjectStandards({ projectRoot, sourceRoot, runtime: 'codex' }).valid, true);
  });

  test('updates owned files, retires obsolete profile assets recoverably, and preserves diverged files', () => {
    const sourceRoot = path.join(tempRoot, 'ownership-source');
    const projectRoot = path.join(tempRoot, 'ownership-project');
    createCanonicalSource(sourceRoot);
    fs.mkdirSync(projectRoot, { recursive: true });
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');

    installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['frontend'],
    });
    const frontendRule = path.join(projectRoot, '.claude', 'rules', 'architecture-frontend.md');
    assert.ok(fs.existsSync(frontendRule));

    const switched = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['backend'],
    });
    assert.strictEqual(fs.existsSync(frontendRule), false);
    assert.ok(switched.results.claude.retired.some((entry) => entry.path === 'rules/architecture-frontend.md'));
    assert.ok(switched.results.claude.backupRoot);

    const backendRule = path.join(projectRoot, '.claude', 'rules', 'architecture-backend.md');
    fs.appendFileSync(backendRule, 'user edit\n');
    write(
      path.join(sourceRoot, 'profiles', 'backend', 'rules', 'architecture-backend.md'),
      '# backend v2\n'
    );
    const preserved = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['backend'],
    });
    assert.ok(preserved.results.claude.conflicts.some((entry) => entry.path === 'rules/architecture-backend.md'));
    assert.ok(fs.readFileSync(backendRule, 'utf8').includes('user edit'));
    const validation = validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' });
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.issues.some((issue) => issue.path === 'rules/architecture-backend.md'));
  });

  test('restores the active path and reports a conflict when an obsolete asset changes during retirement', () => {
    const sourceRoot = path.join(tempRoot, 'retirement-race-source');
    const projectRoot = path.join(tempRoot, 'retirement-race-project');
    createCanonicalSource(sourceRoot);
    fs.mkdirSync(projectRoot, { recursive: true });
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['frontend'] });
    const frontendRule = path.join(projectRoot, '.claude', 'rules', 'architecture-frontend.md');
    const concurrentBytes = '# concurrent user edit\n';
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function renameWithConcurrentEdit(source, destination) {
      if (!injected && path.resolve(String(source)) === path.resolve(frontendRule)) {
        injected = true;
        fs.writeFileSync(frontendRule, concurrentBytes);
      }
      return originalRename.call(this, source, destination);
    };
    let result;
    try {
      result = installProjectStandards({
        projectRoot,
        sourceRoot,
        runtime: 'claude',
        profiles: ['backend'],
      });
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(injected, true);
    assert.ok(result.results.claude.conflicts.some(
      (entry) => entry.path === 'rules/architecture-frontend.md' && /during retirement/i.test(entry.reason)
    ));
    assert.ok(!result.results.claude.retired.some(
      (entry) => entry.path === 'rules/architecture-frontend.md'
    ));
    assert.strictEqual(fs.readFileSync(frontendRule, 'utf8'), concurrentBytes);
  });

  test('rejects forged manifest ownership before moving any user file', () => {
    const sourceRoot = path.join(tempRoot, 'forged-manifest-source');
    const projectRoot = path.join(tempRoot, 'forged-manifest-project');
    createCanonicalSource(sourceRoot);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['frontend'] });

    const localSettings = path.join(projectRoot, '.claude', 'settings.local.json');
    const localBytes = '{"permissions":{"allow":[]}}\n';
    write(localSettings, localBytes);
    const manifestPath = path.join(projectRoot, '.claude', 'project-standards.json');
    const forged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    forged.assets.push({
      kind: 'rule',
      profile: 'frontend',
      source: 'profiles/frontend/rules/architecture-frontend.md',
      path: 'settings.local.json',
      sha256: crypto.createHash('sha256').update(localBytes).digest('hex'),
    });
    writeJson(manifestPath, forged);

    assert.throws(
      () => installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['backend'] }),
      /untrusted|manifest|asset/i
    );
    assert.strictEqual(fs.readFileSync(localSettings, 'utf8'), localBytes);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.claude', 'tech-persistence-backups')), false);
  });

  test('rejects an omitted live canonical asset and flags undeclared stale profile rules', () => {
    const sourceRoot = path.join(tempRoot, 'manifest-inventory-source');
    const projectRoot = path.join(tempRoot, 'manifest-inventory-project');
    createCanonicalSource(sourceRoot);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['frontend'] });

    const manifestPath = path.join(projectRoot, '.claude', 'project-standards.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.assets = manifest.assets.filter((asset) => asset.path !== 'rules/architecture-frontend.md');
    writeJson(manifestPath, manifest);
    assert.throws(
      () => installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['backend'] }),
      /omits|inventory|manifest/i
    );
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude', 'rules', 'architecture-frontend.md')));

    writeJson(manifestPath, {
      ...manifest,
      profiles: ['base', 'backend'],
      scopes: {
        base: loadProjectStandardsCatalog(sourceRoot).profiles.base.scopes,
        backend: loadProjectStandardsCatalog(sourceRoot).profiles.backend.scopes,
      },
      evidence: [{ profile: 'backend', source: 'explicit', signal: 'profile selected explicitly: backend' }],
      assets: manifest.assets.filter((asset) => asset.profile === 'shared' || asset.profile === 'base'),
      mode: 'explicit',
    });
    const staleValidation = validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' });
    assert.strictEqual(staleValidation.valid, false);
    assert.ok(staleValidation.issues.some((issue) => /frontend|undeclared|stale/i.test(`${issue.path} ${issue.reason}`)));
  });

  test('reports a pre-existing unselected canonical target as an install conflict', () => {
    const sourceRoot = path.join(tempRoot, 'reserved-target-source');
    const projectRoot = path.join(tempRoot, 'reserved-target-project');
    createCanonicalSource(sourceRoot);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    const reserved = path.join(projectRoot, '.claude', 'rules', 'architecture-frontend.md');
    write(reserved, '# user-owned frontend rule\n');

    const result = installProjectStandards({
      projectRoot,
      sourceRoot,
      runtime: 'claude',
      profiles: ['backend'],
    });
    assert.ok(result.results.claude.conflicts.some((entry) => entry.path === 'rules/architecture-frontend.md'));
    assert.strictEqual(fs.readFileSync(reserved, 'utf8'), '# user-owned frontend rule\n');
  });

  test('never overwrites a manifest created concurrently after initial absence', () => {
    const sourceRoot = path.join(tempRoot, 'manifest-race-source');
    const projectRoot = path.join(tempRoot, 'manifest-race-project');
    createCanonicalSource(sourceRoot);
    const claudePath = path.join(projectRoot, 'CLAUDE.md');
    const manifestPath = path.join(projectRoot, '.claude', 'project-standards.json');
    write(claudePath, '# Claude\n');
    const originalRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function readWithManifestRace(file, ...args) {
      if (!injected && path.resolve(String(file)) === path.resolve(claudePath)) {
        injected = true;
        write(manifestPath, '{"owner":"user"}\n');
      }
      return originalRead.call(this, file, ...args);
    };
    try {
      assert.throws(
        () => installProjectStandards({
          projectRoot,
          sourceRoot,
          runtime: 'claude',
          profiles: ['backend'],
        }),
        /changed|another writer|created|absent|compare-and-swap/i
      );
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), '{"owner":"user"}\n');
  });

  test('rejects malformed manifest metadata and managed parent junctions', () => {
    const sourceRoot = path.join(tempRoot, 'manifest-schema-source');
    const projectRoot = path.join(tempRoot, 'manifest-schema-project');
    createCanonicalSource(sourceRoot);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['frontend'] });

    const manifestPath = path.join(projectRoot, '.claude', 'project-standards.json');
    const validManifest = fs.readFileSync(manifestPath, 'utf8');
    const malformed = JSON.parse(validManifest);
    malformed.mode = 'anything-but-auto';
    writeJson(manifestPath, malformed);
    const malformedValidation = validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' });
    assert.strictEqual(malformedValidation.valid, false);
    assert.ok(malformedValidation.issues.some((issue) => /mode|manifest/i.test(issue.reason)));
    fs.writeFileSync(manifestPath, validManifest);

    const rulesPath = path.join(projectRoot, '.claude', 'rules');
    const rulesRealPath = path.join(projectRoot, '.claude', 'rules-real');
    fs.renameSync(rulesPath, rulesRealPath);
    fs.symlinkSync(rulesRealPath, rulesPath, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedValidation = validateProjectStandards({ projectRoot, sourceRoot, runtime: 'claude' });
    assert.strictEqual(linkedValidation.valid, false);
    assert.ok(linkedValidation.issues.some((issue) => /symlink|junction|reparse|plain/i.test(issue.reason)));
  });

  test('rejects a linked backup parent before creating anything outside the runtime root', () => {
    const sourceRoot = path.join(tempRoot, 'backup-link-source');
    const projectRoot = path.join(tempRoot, 'backup-link-project');
    const externalRoot = path.join(tempRoot, 'backup-link-external');
    createCanonicalSource(sourceRoot);
    write(path.join(projectRoot, 'CLAUDE.md'), '# Claude\n');
    fs.mkdirSync(externalRoot, { recursive: true });
    installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['frontend'] });
    fs.symlinkSync(
      externalRoot,
      path.join(projectRoot, '.claude', 'tech-persistence-backups'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(
      () => installProjectStandards({ projectRoot, sourceRoot, runtime: 'claude', profiles: ['backend'] }),
      /symlink|junction|reparse|plain/i
    );
    assert.deepStrictEqual(fs.readdirSync(externalRoot), []);
  });

  test('CLI exposes evidence-only detection without mutating the project', () => {
    const sourceRoot = path.join(tempRoot, 'cli-source');
    const projectRoot = path.join(tempRoot, 'cli-project');
    createCanonicalSource(sourceRoot);
    writeJson(path.join(projectRoot, 'package.json'), { dependencies: { fastify: '^5.0.0' } });
    const output = [];
    const originalLog = console.log;
    console.log = (value) => output.push(String(value));
    let status;
    try {
      status = main([
      '--project-root', projectRoot,
      '--source-root', sourceRoot,
      '--detect-only',
      '--json',
      ]);
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(status, 0);
    const payload = JSON.parse(output.join('\n').trim());
    assert.deepStrictEqual(payload.profiles, ['base', 'backend']);
    assert.ok(payload.evidence.length > 0);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.claude')), false);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.codex')), false);
  });

  console.log(`\n[OK] ${passed} project standards tests passed`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

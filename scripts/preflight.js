#!/usr/bin/env node

/**
 * preflight.js — 安装前环境检查
 *
 * 用法: node preflight.js
 *
 * 检查：
 *   1. Node.js 版本 >= 18
 *   2. Claude Code 是否安装
 *   3. ~/.claude 目录权限
 *   4. 现有配置冲突检测
 *   5. Hook 兼容性
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { classifyExistingAgents } = require('./install-codex-agents');

const OK = '\x1b[32m✅\x1b[0m';
const WARN = '\x1b[33m⚠️\x1b[0m';
const FAIL = '\x1b[31m❌\x1b[0m';
const INFO = '\x1b[34mℹ️\x1b[0m';

let hasError = false;
let hasWarning = false;

function check(label, fn) {
  try {
    const result = fn();
    if (result === true) {
      console.log(`  ${OK} ${label}`);
    } else if (result === 'warn') {
      console.log(`  ${WARN} ${label}`);
      hasWarning = true;
    } else {
      console.log(`  ${FAIL} ${label}`);
      hasError = true;
    }
  } catch (err) {
    console.log(`  ${FAIL} ${label}: ${err.message}`);
    hasError = true;
  }
}

function commandAvailable(command) {
  const lookup = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
  execSync(lookup, { stdio: 'pipe' });
}

function checkWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const testFile = path.join(dir, `.write-test-${Date.now()}`);
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
}

function expandHome(value, home) {
  if (!value) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function sharedConfigPath(home) {
  return process.env.TECH_PERSISTENCE_CONFIG
    ? path.resolve(expandHome(process.env.TECH_PERSISTENCE_CONFIG, home))
    : path.join(home, '.tech-persistence', 'config.json');
}

function describeSharedHomunculus(home) {
  if (process.env.TECH_PERSISTENCE_HOME) {
    return {
      source: 'TECH_PERSISTENCE_HOME',
      homunculusHome: path.resolve(expandHome(process.env.TECH_PERSISTENCE_HOME, home)),
    };
  }

  const configPath = sharedConfigPath(home);
  if (!fs.existsSync(configPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const configured = config.homunculusHome || config.homunculusDir || config.vaultPath;
    if (!configured) return { source: configPath, error: 'missing homunculusHome' };
    return {
      source: configPath,
      homunculusHome: path.resolve(expandHome(configured, home)),
    };
  } catch (error) {
    return { source: configPath, error: error.message };
  }
}

function describeCodexAgents(file, kind) {
  const template = path.join(__dirname, '..', 'codex-native', 'agents', `${kind}.md`);
  if (!fs.existsSync(file)) return { state: 'absent' };
  if (!fs.existsSync(template)) return { state: 'invalid', message: `missing native template: ${template}` };
  const raw = fs.readFileSync(file);
  const templateRaw = fs.readFileSync(template);
  const classification = classifyExistingAgents({ raw, templateRaw, legacyRaw: null, kind });
  if (classification === 'managed-current') return { state: 'optimized' };
  if (classification === 'managed-marker' || classification === 'legacy-generated') {
    return { state: 'migratable', classification };
  }
  return { state: 'custom' };
}

function finish(recommendedCommand) {
  console.log('\n' + '─'.repeat(50));
  if (hasError) {
    console.log(`\n${FAIL} 存在阻断问题，请先解决后再安装\n`);
    process.exit(1);
  }
  if (hasWarning) {
    console.log(`\n${WARN} 存在需要注意的项，安装时会自动处理或提示手动合并`);
    console.log(`${INFO} 可以继续安装: ${recommendedCommand}\n`);
    return;
  }
  console.log(`\n${OK} 环境检查通过，可以安装: ${recommendedCommand}\n`);
}

function runCodexPreflight() {
  console.log('\n🔍 Tech Persistence for Codex — 环境检查\n');

  let codexAvailable = false;

  console.log('运行环境:');
  check('Node.js >= 18', () => {
    const ver = parseInt(process.versions.node.split('.')[0]);
    if (ver >= 18) return true;
    console.log(`     当前版本: ${process.versions.node}`);
    return false;
  });

  check('Git 可用', () => {
    try {
      execSync('git --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  });

  check('Codex CLI 可用', () => {
    try {
      commandAvailable('codex');
      codexAvailable = true;
      return true;
    } catch {
      console.log('     未检测到 codex 命令；--project 将安装带哈希清单的 direct fallback');
      return 'warn';
    }
  });

  console.log('\n目录权限:');
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const codexHome = path.join(homeDir, '.codex');
  const agentsPluginsDir = path.join(homeDir, '.agents', 'plugins');
  const userPluginDir = path.join(homeDir, 'plugins', 'tech-persistence');
  const marketplacePath = path.join(agentsPluginsDir, 'marketplace.json');

  check('~/.codex 目录可写', () => {
    try {
      checkWritableDir(codexHome);
      return true;
    } catch {
      return false;
    }
  });

  check('~/.agents/plugins 目录可写', () => {
    try {
      checkWritableDir(agentsPluginsDir);
      return true;
    } catch {
      return false;
    }
  });

  console.log('\n现有 Codex 配置:');
  check('~/plugins/tech-persistence', () => {
    if (fs.existsSync(userPluginDir)) {
      console.log('     已存在 — 安装时会创建备份并替换插件目录');
      return 'warn';
    }
    console.log('     不存在 — 将新建');
    return true;
  });

  check('~/.codex/homunculus', () => {
    const homunculusDir = path.join(codexHome, 'homunculus');
    if (fs.existsSync(homunculusDir)) {
      console.log('     已存在 — 会保留现有知识库');
      return 'warn';
    }
    console.log('     不存在 — 将初始化');
    return true;
  });

  check('shared homunculus config', () => {
    const shared = describeSharedHomunculus(homeDir);
    if (!shared) {
      console.log('     未配置 — Codex 将使用 ~/.codex/homunculus');
      return true;
    }
    if (shared.error) {
      console.log(`     ${shared.source} 无效: ${shared.error}`);
      return 'warn';
    }
    console.log(`     ${shared.source} -> ${shared.homunculusHome}`);
    return fs.existsSync(shared.homunculusHome) ? 'warn' : true;
  });

  check('~/.codex/commands', () => {
    const commandsDir = path.join(codexHome, 'commands');
    if (!fs.existsSync(commandsDir)) {
      console.log('     不存在 — 将安装 21 个用户命令');
      return true;
    }
    const commandCount = fs.readdirSync(commandsDir).filter((name) => name.endsWith('.md')).length;
    console.log(`     已存在 (${commandCount} 个命令) — 安装时会刷新本系统命令`);
    return commandCount >= 21 ? 'warn' : true;
  });

  check('~/.codex/AGENTS.md lean context', () => {
    const status = describeCodexAgents(path.join(codexHome, 'AGENTS.md'), 'user');
    if (status.state === 'absent') {
      console.log('     不存在 — 将安装 lean Codex-native user template');
      return true;
    }
    if (status.state === 'optimized') return true;
    if (status.state === 'migratable') {
      console.log(`     ${status.classification} — 将保留唯一备份后迁移为 lean native template`);
      return 'warn';
    }
    if (status.state === 'custom') {
      console.log('     自定义内容将原样保留；lean context optimization 不会启用');
      return 'warn';
    }
    console.log(`     ${status.message}`);
    return false;
  });

  check('Codex-native think/plan/work/review/compound/sprint commands', () => {
    const commandsDir = path.join(codexHome, 'commands');
    const nativeDir = path.join(__dirname, '..', 'codex-native', 'commands');
    const mismatched = ['compound.md', 'plan.md', 'review.md', 'sprint.md', 'think.md', 'work.md'].filter((name) => {
      const installed = path.join(commandsDir, name);
      const expected = path.join(nativeDir, name);
      return !fs.existsSync(installed)
        || !fs.existsSync(expected)
        || !fs.readFileSync(installed).equals(fs.readFileSync(expected));
    });
    if (mismatched.length === 0) return true;
    console.log(`     将替换为 thin native command: ${mismatched.join(', ')}`);
    return 'warn';
  });

  check('Codex direct skill copies', () => {
    const skillsDir = path.join(codexHome, 'skills');
    if (!fs.existsSync(skillsDir)) {
      console.log('     不存在 — 正常；user skills 由 canonical plugin 提供');
      return true;
    }
    const count = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .length;
    console.log(`     检测到 ${count} 个 direct skills；installer doctor 会原地保留文件，并通过完整 SKILL.md 路径 exclusion 禁用冲突副本（config 变更先备份）`);
    return 'warn';
  });

  check('marketplace tech-persistence entry', () => {
    if (!fs.existsSync(marketplacePath)) {
      console.log('     marketplace.json 不存在 — 将新建');
      return true;
    }
    try {
      const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'));
      const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
      const entries = plugins.filter((plugin) => plugin.name === 'tech-persistence');
      if (marketplace.name === 'local-plugins' && entries.length === 1) {
        console.log('     已存在一个 canonical entry — 安装时会幂等刷新');
        return 'warn';
      }
      console.log('     将规范化为 local-plugins 中唯一的 tech-persistence entry');
      return 'warn';
    } catch {
      console.log('     marketplace.json 解析失败 — 安装时会备份并重建');
      return 'warn';
    }
  });

  check('Codex runtime owner', () => {
    if (!codexAvailable) {
      console.log('     CLI 不可用，无法读取 plugin owner；project installer 将使用 direct fallback');
      return 'warn';
    }
    const doctor = path.join(__dirname, 'codex-runtime-doctor.js');
    const result = spawnSync(process.execPath, [doctor, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const report = JSON.parse(result.stdout || '{}');
      if (report.blocked) {
        console.log(`     doctor 阻断安全修复: ${report.blocked}`);
        return false;
      }
      const ownerCount = report.report?.ownerCount;
      if (ownerCount === 1 && report.report?.healthy) {
        console.log(`     ownerCount=1 (${report.report.pluginOwners?.[0]?.pluginId || 'direct fallback'})`);
        return true;
      }
      console.log(`     ownerCount=${ownerCount ?? 'unknown'}；--user 将先 dry-run 再执行显式安全修复`);
      return 'warn';
    } catch (error) {
      console.log(`     runtime doctor 输出不可解析: ${error.message}`);
      return false;
    }
  });

  console.log('\n当前目录:');
  check('Git 仓库', () => {
    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
      return true;
    } catch {
      console.log('     不在 Git 仓库中 — 项目级安装需要在项目根目录');
      return 'warn';
    }
  });

  check('.codex/ 目录', () => {
    if (fs.existsSync('.codex')) {
      console.log('     已存在 — 安装时会保留现有文件');
      return 'warn';
    }
    return true;
  });

  check('AGENTS.md', () => {
    const status = describeCodexAgents(path.resolve('AGENTS.md'), 'project');
    if (status.state === 'absent') return true;
    if (status.state === 'optimized') return true;
    if (status.state === 'migratable') {
      console.log(`     ${status.classification} — explicit project install 将备份后迁移`);
      return 'warn';
    }
    console.log('     自定义内容将原样保留；project lean context optimization 不会启用');
    return 'warn';
  });

  finish(process.platform === 'win32'
    ? 'powershell -ExecutionPolicy Bypass -File .\\install-codex.ps1 -All'
    : 'bash install-codex.sh --all');
}

if (process.argv.includes('--codex')) {
  runCodexPreflight();
  process.exit(hasError ? 1 : 0);
}

console.log('\n🔍 技术沉淀系统 v2 — 环境检查\n');

// ── Node.js ──
console.log('运行环境:');
check('Node.js >= 18', () => {
  const ver = parseInt(process.versions.node.split('.')[0]);
  if (ver >= 18) return true;
  console.log(`     当前版本: ${process.versions.node}`);
  return false;
});

// ── Git ──
check('Git 可用', () => {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
});

// ── Claude Code ──
check('Claude Code CLI 可用', () => {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    console.log('     未检测到 claude 命令，请先安装 Claude Code');
    return 'warn';
  }
});

// ── 目录权限 ──
console.log('\n目录权限:');
const home = process.env.HOME || process.env.USERPROFILE;
const claudeHome = path.join(home, '.claude');

check('~/.claude 目录可写', () => {
  try {
    fs.mkdirSync(claudeHome, { recursive: true });
    const testFile = path.join(claudeHome, '.write-test-' + Date.now());
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
});

// ── 现有配置检测 ──
console.log('\n现有配置:');
const existingFiles = {
  '~/.claude/CLAUDE.md': path.join(claudeHome, 'CLAUDE.md'),
  '~/.claude/settings.json': path.join(claudeHome, 'settings.json'),
  '~/.claude/homunculus/': path.join(claudeHome, 'homunculus'),
};

Object.entries(existingFiles).forEach(([label, filePath]) => {
  check(label, () => {
    if (fs.existsSync(filePath)) {
      console.log(`     已存在 — 安装时会创建备份`);
      return 'warn';
    }
    console.log(`     不存在 — 将新建`);
    return true;
  });
});

check('shared homunculus config', () => {
  const shared = describeSharedHomunculus(home);
  if (!shared) {
    console.log('     未配置 — Claude Code 将使用 ~/.claude/homunculus');
    return true;
  }
  if (shared.error) {
    console.log(`     ${shared.source} 无效: ${shared.error}`);
    return 'warn';
  }
  console.log(`     ${shared.source} -> ${shared.homunculusHome}`);
  return fs.existsSync(shared.homunculusHome) ? 'warn' : true;
});

// ── Hook 冲突检测 ──
console.log('\nHook 兼容性:');
const settingsPath = path.join(claudeHome, 'settings.json');
check('Hook 配置', () => {
  if (!fs.existsSync(settingsPath)) {
    console.log('     无现有 Hook — 将全新安装');
    return true;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks || {};
    const conflicts = [];

    ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].forEach(hook => {
      if (hooks[hook]) {
        const existing = JSON.stringify(hooks[hook]);
        if (existing.includes('observe.js') || existing.includes('evaluate-session') || existing.includes('inject-context')) {
          // 已安装过本系统的 hook
        } else {
          conflicts.push(hook);
        }
      }
    });

    if (conflicts.length > 0) {
      console.log(`     已有 Hook: ${conflicts.join(', ')} — 需要手动合并`);
      return 'warn';
    }
    return true;
  } catch {
    console.log('     settings.json 解析失败 — 需要手动检查');
    return 'warn';
  }
});

// ── 第三方插件检测 ──
console.log('\n第三方插件检测:');
check('Claude-Mem', () => {
  const cmemDb = path.join(home, '.claude-mem', 'claude-mem.db');
  if (fs.existsSync(cmemDb)) {
    console.log('     检测到 Claude-Mem — 两者可共存，观察数据独立');
    return 'warn';
  }
  console.log('     未安装');
  return true;
});

check('ECC (Everything Claude Code)', () => {
  const eccMarkers = [
    path.join(claudeHome, 'skills', 'continuous-learning'),
    path.join(claudeHome, 'skills', 'continuous-learning-v2'),
  ];
  const found = eccMarkers.find(p => fs.existsSync(p));
  if (found) {
    console.log('     检测到 ECC continuous-learning — 建议先卸载再安装本系统');
    console.log('     或手动合并 Hook 配置，避免重复观察');
    return 'warn';
  }
  console.log('     未安装');
  return true;
});

check('Superpowers', () => {
  const pluginsDir = path.join(home, '.claude', 'plugins');
  try {
    if (fs.existsSync(pluginsDir)) {
      const items = fs.readdirSync(pluginsDir).join(' ');
      if (items.includes('superpowers')) {
        console.log('     检测到 Superpowers — 可共存，技能系统互补');
        return 'warn';
      }
    }
  } catch {}
  console.log('     未安装');
  return true;
});

// ── 项目级检测 ──
console.log('\n当前目录:');
check('Git 仓库', () => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    let remote = '';
    try { remote = execSync('git remote get-url origin', { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }).trim(); } catch {}
    console.log(`     仓库: ${remote || '(无 remote)'}`);
    return true;
  } catch {
    console.log('     不在 Git 仓库中 — 项目级安装需要在项目根目录');
    return 'warn';
  }
});

check('.claude/ 目录', () => {
  if (fs.existsSync('.claude')) {
    console.log('     已存在 — 安装时会保留现有文件');
    return 'warn';
  }
  return true;
});

check('CLAUDE.md', () => {
  if (fs.existsSync('CLAUDE.md')) {
    const lines = fs.readFileSync('CLAUDE.md', 'utf-8').split('\n').length;
    console.log(`     已存在 (${lines} 行) — 不会覆盖`);
    return 'warn';
  }
  return true;
});

// ── 总结 ──
console.log('\n' + '─'.repeat(50));
if (hasError) {
  console.log(`\n${FAIL} 存在阻断问题，请先解决后再安装\n`);
  process.exit(1);
} else if (hasWarning) {
  console.log(`\n${WARN} 存在需要注意的项，安装时会自动处理或提示手动合并`);
  console.log(`${INFO} 可以继续安装: bash install.sh --all\n`);
} else {
  console.log(`\n${OK} 环境检查通过，可以安装: bash install.sh --all\n`);
}

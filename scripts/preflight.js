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
const { execSync } = require('child_process');

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

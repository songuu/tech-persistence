#!/usr/bin/env node

/**
 * inject-context.js — SessionStart Hook 上下文注入
 *
 * 灵感来源：
 *   - Claude-Mem: SessionStart 时注入近期会话摘要和观察
 *   - ECC v2.1: 注入高置信度的项目本能
 *
 * 在每次新会话开始时：
 *   1. 加载最近 N 个会话摘要
 *   2. 加载高置信度本能（>=0.7 自动应用）
 *   3. 格式化后通过 hookSpecificOutput.additionalContext 注入
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function detectProject() {
  const { execSync } = require('child_process');
  const execOpts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    const remote = execSync('git remote get-url origin', execOpts).trim();
    if (remote) {
      const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(remote, '.git') };
    }
  } catch {}
  try {
    const root = execSync('git rev-parse --show-toplevel', execOpts).trim();
    if (root) {
      const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(root) };
    }
  } catch {}
  const cwd = process.cwd();
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return { id: hash, name: path.basename(cwd) };
}

function loadInstincts(dir, minConfidence) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const meta = {};
      match[1].split('\n').forEach(line => {
        const [key, ...vals] = line.split(':');
        if (key && vals.length) meta[key.trim()] = vals.join(':').trim().replace(/^["']|["']$/g, '');
      });
      meta.body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
      return meta;
    })
    .filter(inst => inst && parseFloat(inst.confidence) >= minConfidence)
    .sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence));
}

function loadRecentSessions(sessionsDir, limit = 5) {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .slice(-limit)
    .map(f => fs.readFileSync(path.join(sessionsDir, f), 'utf-8'))
    .reverse();
}

function main() {
  const project = detectProject();
  const home = process.env.HOME || process.env.USERPROFILE;
  const hDir = path.join(home, '.claude', 'homunculus');
  const projectDir = path.join(hDir, 'projects', project.id);

  const sections = [];

  // 1. 近期会话摘要
  const sessions = loadRecentSessions(path.join(projectDir, 'sessions'), 3);
  if (sessions.length > 0) {
    sections.push(`## 近期会话 (${project.name})\n${sessions.join('\n---\n')}`);
  }

  // 2. 高置信度项目本能 (>=0.5)
  const projectInstincts = loadInstincts(path.join(projectDir, 'instincts'), 0.5);
  if (projectInstincts.length > 0) {
    const instinctLines = projectInstincts.slice(0, 10).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      const flag = parseFloat(inst.confidence) >= 0.7 ? '🟢' : '🟡';
      return `- ${flag} [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    sections.push(`## 项目本能 (已学习的行为模式)\n${instinctLines.join('\n')}`);
  }

  // 3. 高置信度全局本能 (>=0.7)
  const globalInstincts = loadInstincts(path.join(hDir, 'instincts', 'personal'), 0.7);
  if (globalInstincts.length > 0) {
    const instinctLines = globalInstincts.slice(0, 5).map(inst => {
      const conf = parseFloat(inst.confidence).toFixed(1);
      return `- 🟢 [${conf}] [${inst.domain || '?'}] ${inst.trigger || inst.id}`;
    });
    sections.push(`## 全局本能 (跨项目通用)\n${instinctLines.join('\n')}`);
  }

  if (sections.length === 0) {
    process.exit(0); // 无内容可注入
  }

  // 输出格式：Claude Code 2.1+ 通过 additionalContext 注入
  const context = `<learned-context project="${project.name}">
${sections.join('\n\n')}
</learned-context>`;

  // 通过 stdout 输出 JSON，Claude Code 会读取
  const output = JSON.stringify({
    hookSpecificOutput: {
      additionalContext: context
    }
  });
  console.log(output);
}

try { main(); } catch { process.exit(0); }

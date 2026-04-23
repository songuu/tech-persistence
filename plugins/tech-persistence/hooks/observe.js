#!/usr/bin/env node

/**
 * observe.js — PreToolUse / PostToolUse 观察 Hook
 *
 * 灵感来源：
 *   - ECC continuous-learning-v2: 100% 确定性 Hook 捕获
 *   - Codex-Mem: PostToolUse 观察 + 异步压缩
 *
 * 工作原理：
 *   1. Hook 触发时立即将原始事件追加到 observations.jsonl
 *   2. 保持 < 1 秒执行时间（fire-and-forget 模式）
 *   3. 后续由 evaluate-session.js (Stop hook) 批量分析
 *
 * 使用方式（在 settings.json 中配置）：
 *   "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <path>/observe.js pre" }] }]
 *   "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <path>/observe.js post" }] }]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBaseDir, resolveSessionId } = require('./lib/runtime-paths');

// ─── 项目检测 ───
function detectProject() {
  const { execSync } = require('child_process');
  const execOpts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    const remote = execSync('git remote get-url origin', execOpts).trim();
    if (remote) {
      const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
      const name = path.basename(remote, '.git');
      return { id: hash, name, source: 'git-remote' };
    }
  } catch {}
  try {
    const root = execSync('git rev-parse --show-toplevel', execOpts).trim();
    if (root) {
      const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
      return { id: hash, name: path.basename(root), source: 'git-root' };
    }
  } catch {}
  const cwd = process.cwd();
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return { id: hash, name: path.basename(cwd), source: 'cwd' };
}

// ─── 存储路径 ───
function getObservationPath(project) {
  const homunculusDir = resolveBaseDir();
  // 项目级观察
  const projectDir = path.join(homunculusDir, 'projects', project.id);
  fs.mkdirSync(projectDir, { recursive: true });
  return path.join(projectDir, 'observations.jsonl');
}

// ─── 主逻辑 ───
function main() {
  const phase = process.argv[2] || 'post'; // pre | post
  const project = detectProject();
  const obsPath = getObservationPath(project);

  // 从 stdin 读取 hook payload (Codex 通过 stdin 传入 JSON)
  let input = '';
  try {
    // 跨平台读取 stdin：Windows 无 /dev/stdin
    if (process.platform === 'win32') {
      input = fs.readFileSync(0, 'utf-8').trim();
    } else {
      input = fs.readFileSync('/dev/stdin', 'utf-8').trim();
    }
  } catch {
    // stdin 不可用时静默继续
  }

  let toolName = 'unknown';
  let toolInput = '';
  let toolOutput = '';

  if (input) {
    try {
      const payload = JSON.parse(input);
      toolName = payload.tool_name || payload.name || 'unknown';
      toolInput = typeof payload.input === 'string'
        ? payload.input.slice(0, 500)
        : JSON.stringify(payload.input || '').slice(0, 500);
      toolOutput = typeof payload.output === 'string'
        ? payload.output.slice(0, 1000)
        : JSON.stringify(payload.output || '').slice(0, 1000);
    } catch {
      // 非 JSON 格式，记录原始内容的摘要
      toolInput = input.slice(0, 300);
    }
  }

  const observation = {
    timestamp: new Date().toISOString(),
    phase, // pre | post
    session_id: resolveSessionId(),
    project: project,
    tool: toolName,
    input_summary: toolInput,
    output_summary: phase === 'post' ? toolOutput : undefined,
    cwd: process.cwd(),
  };

  // 追加写入 JSONL（fire-and-forget，不阻塞）
  try {
    fs.appendFileSync(obsPath, JSON.stringify(observation) + '\n');
  } catch (err) {
    // 写入失败时静默退出，不影响 Codex 主流程
    process.exit(0);
  }

  // 限制文件大小：超过 10MB 时归档
  try {
    const stats = fs.statSync(obsPath);
    if (stats.size > 10 * 1024 * 1024) {
      const archiveDir = path.join(path.dirname(obsPath), 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const archiveName = `observations-${Date.now()}.jsonl`;
      fs.renameSync(obsPath, path.join(archiveDir, archiveName));
    }
  } catch {}
}

try { main(); } catch { process.exit(0); }

'use strict';

/**
 * plugin-manifest-checks.js — 纯函数：Claude 插件 manifest 的确定性约束校验。
 *
 * 为什么存在：`.claude-plugin/plugin.json` 受 Claude 插件 validator 的一组**未文档化、
 * 版本相关**约束限制（声明 agents / hooks 会被判 "Invalid input" / "Duplicate hooks file"；
 * MCP 全限定工具名超长会被 gateway 拒）。这些约束此前只靠"记得保持 manifest 最小"维持，
 * 是 documented-claim-vs-code-reality drift（P0a）的典型来源。本模块把约束下沉为确定性断言。
 *
 * 设计约束（守 4 不可妥协）：
 *  - 纯函数、无副作用、无依赖（lightweight-first）；调用方 validate-codex-plugin.js 负责 IO + 报错。
 *  - repo-only（不进 scripts/lib，避免被 copyHookLibs glob 进 plugin hooks/lib 的 inventory 耦合）。
 *  - 仅校验 Claude manifest；Codex manifest 的相反要求（必须声明 skills/hooks/mcpServers）由
 *    validate-codex-plugin.js 既有逻辑负责——两 manifest 要求相反，不可统一断言。
 */

// Anthropic 工具名硬限制：^[A-Za-z0-9_-]{1,64}$ → 最多 64 字符（含）。
// MCP gateway 暴露的全限定名形如 `mcp__<server>__<tool>`，整体仍受 64 限制。
// 拒 length > 64（而非 >= 64）：拒合法的恰好 64 字符名是误杀，会催生 --no-verify（P0e）。
const MCP_FQ_NAME_MAX = 64;

// Claude 自动发现 agents/ 与 hooks/hooks.json；在 plugin.json 里显式声明它们会破坏安装。
const CLAUDE_FORBIDDEN_KEYS = ['agents', 'hooks'];

// 这些 key 若出现，必须是数组（Claude validator 拒绝非数组形状）。
const CLAUDE_ARRAY_KEYS = ['commands', 'skills'];

/**
 * 校验 .claude-plugin/plugin.json 对象，返回错误消息数组（空 = 通过）。
 * @param {unknown} manifest 已解析的 manifest 对象
 * @returns {string[]}
 */
function checkClaudeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['.claude-plugin/plugin.json must be a JSON object'];
  }
  const errors = [];
  for (const key of CLAUDE_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      errors.push(
        `.claude-plugin/plugin.json must NOT declare "${key}" — Claude auto-discovers it; `
        + 'explicit declaration triggers "Invalid input" / "Duplicate hooks file" and silently breaks install',
      );
    }
  }
  for (const key of CLAUDE_ARRAY_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(manifest, key)
      && !Array.isArray(manifest[key])
    ) {
      errors.push(`.claude-plugin/plugin.json "${key}" must be an array when present`);
    }
  }
  return errors;
}

/**
 * 从 memory-tools.js 源码文本中提取 tp_* 工具名（不 require，避免触发 handler 依赖）。
 * @param {string} source 文件内容
 * @returns {string[]} 去重后的工具名
 */
function extractMcpToolNames(source) {
  const names = new Set();
  const pattern = /name:\s*['"](tp_[a-z0-9_]+)['"]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    names.add(match[1]);
  }
  return Array.from(names).sort();
}

/**
 * 构造 Claude 侧全限定 MCP 工具名 mcp__<server>__<tool>。
 * @param {string} serverName
 * @param {string[]} toolNames
 * @returns {string[]}
 */
function buildMcpFqNames(serverName, toolNames) {
  return toolNames.map((tool) => `mcp__${serverName}__${tool}`);
}

/**
 * 找出超过 64 字符的全限定名。
 * @param {string[]} fqNames
 * @param {number} [max=MCP_FQ_NAME_MAX]
 * @returns {{name: string, length: number}[]}
 */
function findOverlongMcpNames(fqNames, max = MCP_FQ_NAME_MAX) {
  return fqNames
    .filter((name) => name.length > max)
    .map((name) => ({ name, length: name.length }));
}

module.exports = {
  MCP_FQ_NAME_MAX,
  CLAUDE_FORBIDDEN_KEYS,
  CLAUDE_ARRAY_KEYS,
  checkClaudeManifest,
  extractMcpToolNames,
  buildMcpFqNames,
  findOverlongMcpNames,
};

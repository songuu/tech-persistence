'use strict';

/**
 * knowledge-drift.js — 知识层 drift 检测纯函数（缺陷 E）
 *
 * WHY：rules/solutions/ADR 是 append-only、零校验，「文档声称的代码位置 vs 代码现实漂移」
 * 是本仓库 #1 回归源（[[documented-claim-vs-code-reality-drift]]）。本 lib 解析 md 里
 * 「带行号的代码位置引用」，校验所指文件是否还存在。
 *
 * 设计（经 dogfood 探针 v1→v2 验证，见 plan 2026-06-01-knowledge-drift-checker）：
 *   - 只校验「带行号」引用——作者标行号 = 明确指向 repo 内具体代码位置（强 drift 信号）。
 *     无行号路径引用大量是假设/未来/运行时文件（dogfood：would-block 40/42），故 skip。
 *   - 绝不校验行号「值」——行号必随编辑漂移，校验=持续误报。只校验文件存在性。
 *   - block 仅限源码前缀（scripts/docs/plugins/user-level）：dogfood 证明此集 0 FP，无需 grandfather。
 *   - 裸文件名 → glob basename（≥1 匹配=存在，0=warn，不要求唯一：pipeline.js 有 plugin 副本属正常）。
 *   - 运行时前缀（.claude//.codex/）+ `...` 简写 → skip（合法的非 repo-source 引用）。
 *
 * 纯函数：不碰 fs/git。调用方（checker）用 `git ls-files` 构造 known 索引传入，便于单测。
 */

// 源码目录前缀——带行号引用落此集 = 必须存在的 repo 源码（dogfood 验证 0 FP）
const SRC_PREFIX_RE = /^(?:scripts|docs|plugins|user-level)\//;

// 代码位置引用正则：alternation 长扩展名在前（jsonl|json|...|js），
// 否则 `settings.json` 会被 `js` 先截成 `settings.js`（dogfood v1 实证 bug）。
const REF_RE = /([A-Za-z0-9_./-]+\.(?:jsonl|json|mjs|cjs|tsx|ts|js|sh|ps1)):(\d+)/g;

/**
 * 从 md 文本提取所有带行号的代码位置引用。
 * @param {string} text
 * @returns {Array<{ ref: string, lineNum: number }>}
 */
function parseCodeReferences(text) {
  const refs = [];
  if (typeof text !== 'string' || !text) return refs;
  REF_RE.lastIndex = 0;
  let match;
  while ((match = REF_RE.exec(text)) !== null) {
    refs.push({ ref: match[1], lineNum: Number(match[2]) });
  }
  return refs;
}

/**
 * 对单个引用分档。
 * @param {string} ref - 引用的文件路径部分（不含 :line）
 * @param {{ paths: Set<string>, basenames: Map<string, number> }} known - repo 已知文件索引
 * @returns {'block' | 'warn' | 'ok' | 'skip'}
 */
function classifyReference(ref, known) {
  if (ref.includes('...') || ref.includes('*')) return 'skip'; // 文档简写惯例
  if (SRC_PREFIX_RE.test(ref)) {
    return known.paths.has(ref) ? 'ok' : 'block'; // 源码前缀 + 行号：文件必须存在
  }
  if (!ref.includes('/')) {
    return (known.basenames.get(ref) || 0) > 0 ? 'ok' : 'warn'; // 裸名：glob basename
  }
  return 'skip'; // 运行时前缀（.claude//.codex/）或其他非源码路径
}

/**
 * 分析一份 md 文本，返回 block / warn 引用列表。
 * @param {string} text
 * @param {{ paths: Set<string>, basenames: Map<string, number> }} known
 * @returns {{ blocks: Array<{ref:string,lineNum:number}>, warns: Array<{ref:string,lineNum:number}> }}
 */
function analyzeKnowledgeDrift(text, known) {
  const blocks = [];
  const warns = [];
  const safeKnown = {
    paths: known && known.paths instanceof Set ? known.paths : new Set(),
    basenames: known && known.basenames instanceof Map ? known.basenames : new Map(),
  };
  for (const entry of parseCodeReferences(text)) {
    const verdict = classifyReference(entry.ref, safeKnown);
    if (verdict === 'block') blocks.push(entry);
    else if (verdict === 'warn') warns.push(entry);
  }
  return { blocks, warns };
}

/**
 * 从 `git ls-files` 输出构造 known 索引（供 checker 用；lib 不自己跑 git，便于测试）。
 * @param {string} lsFilesOutput - `git ls-files` 的 stdout
 * @returns {{ paths: Set<string>, basenames: Map<string, number> }}
 */
function buildKnownIndex(lsFilesOutput) {
  const paths = new Set();
  const basenames = new Map();
  for (const raw of String(lsFilesOutput || '').split('\n')) {
    const file = raw.trim();
    if (!file) continue;
    paths.add(file);
    const base = file.split('/').pop();
    basenames.set(base, (basenames.get(base) || 0) + 1);
  }
  return { paths, basenames };
}

module.exports = {
  SRC_PREFIX_RE,
  REF_RE,
  parseCodeReferences,
  classifyReference,
  analyzeKnowledgeDrift,
  buildKnownIndex,
};

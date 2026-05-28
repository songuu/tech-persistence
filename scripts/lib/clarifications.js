'use strict';

/**
 * clarifications.js — agent-loop A3 clarification channel
 *
 * frozen spec artifact 旁的 append-only 异步澄清通道：
 *   - implementer（Codex）遇 spec 歧义 → appendClarifications 记录「假设 + 问题」（status: open），不阻塞。
 *   - 下一个 gate（review）→ spec-writer（Claude）裁决 → appendRulings（status: ruled）。
 *   - ruling 若要求改 spec → 由 orchestrator 走 classic 模式 review→needs-followup→re-implement 回路
 *     （不重新发明 pipeline 的 contract-revision）。
 *
 * 关键不变量：
 *   - append-only：只用 fs.appendFileSync 追加，绝不覆盖/截断已有条目。
 *   - 写入前脱敏：所有字符串字段过 stripPrivateTags（纵深防御真实输入泄漏）。
 *   - 纯 markdown + frontmatter（Obsidian 兼容），双 runtime 在同一 run 目录读写。
 */

const fs = require('fs');
const path = require('path');
const { stripPrivateTags } = require('./redaction');

const CLARIFICATIONS_FILE = 'clarifications.md';

function clarificationsPath(runDir) {
  if (!runDir) throw new Error('clarifications: runDir required');
  return path.join(runDir, CLARIFICATIONS_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function redact(value) {
  return typeof value === 'string' ? stripPrivateTags(value) : '';
}

function ensureHeader(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 首次写入头部（frontmatter + 标题）。后续一律 append section，不再触碰头部。
  const header = [
    '---',
    'type: clarifications',
    'channel: agent-loop-a3',
    `created: "${nowIso()}"`,
    '---',
    '',
    '# Clarifications',
    '',
    '> Append-only 异步澄清通道。implementer 记录歧义假设（不阻塞），spec-writer 在下一 gate 裁决。',
    '> ruling 若要求改 spec → orchestrator 走 review→needs-followup→re-implement 回路。',
    '',
  ].join('\n');
  fs.writeFileSync(file, header);
}

function nextSequence(file) {
  // id 形如 clr-001；从已有文件统计已存在的 clarification section 推下一个序号。
  if (!fs.existsSync(file)) return 1;
  const body = fs.readFileSync(file, 'utf8');
  const matches = body.match(/^## clarification\b/gim);
  return (matches ? matches.length : 0) + 1;
}

function formatId(seq) {
  return `clr-${String(seq).padStart(3, '0')}`;
}

function renderClarificationSection(entry) {
  return [
    '',
    `## clarification ${entry.id}`,
    '',
    `- status: open`,
    `- recordedAt: ${entry.recordedAt}`,
    `- assumption: ${entry.assumption || '(none)'}`,
    `- question: ${entry.question || '(none)'}`,
    '',
  ].join('\n');
}

function renderRulingSection(ruling) {
  return [
    '',
    `## ruling ${ruling.id}`,
    '',
    `- status: ruled`,
    `- ruledAt: ${ruling.ruledAt}`,
    `- decision: ${ruling.decision}`,
    `- note: ${ruling.note || '(none)'}`,
    '',
  ].join('\n');
}

/**
 * 把 implementer 提出的 clarification 以 append-only 追加。
 * @param {string} runDir
 * @param {Array<{id?:string, assumption?:string, question?:string}>} entries
 * @returns {{ ids: string[], file: string }}
 */
function appendClarifications(runDir, entries) {
  const file = clarificationsPath(runDir);
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return { ids: [], file };

  ensureHeader(file);
  let seq = nextSequence(file);
  const ids = [];
  let chunk = '';

  for (const raw of list) {
    const provided = typeof raw.id === 'string' ? redact(raw.id).trim() : '';
    const id = provided || formatId(seq);
    const entry = {
      id,
      recordedAt: nowIso(),
      assumption: redact(raw.assumption),
      question: redact(raw.question),
    };
    chunk += renderClarificationSection(entry);
    ids.push(id);
    seq += 1;
  }

  fs.appendFileSync(file, chunk);
  return { ids, file };
}

/**
 * 把 spec-writer 的裁决以 append-only 追加。
 * @param {string} runDir
 * @param {Array<{id?:string, decision?:string, note?:string}>} rulings
 * @returns {{ ids: string[], file: string }}
 */
function appendRulings(runDir, rulings) {
  const file = clarificationsPath(runDir);
  const list = Array.isArray(rulings) ? rulings.filter(Boolean) : [];
  if (list.length === 0) return { ids: [], file };

  ensureHeader(file);
  const ids = [];
  let chunk = '';

  for (const raw of list) {
    const id = typeof raw.id === 'string' ? redact(raw.id).trim() : '';
    if (!id) continue; // ruling 必须引用一个 clarification id
    const ruling = {
      id,
      ruledAt: nowIso(),
      decision: redact(raw.decision) || 'confirm-assumption',
      note: redact(raw.note),
    };
    chunk += renderRulingSection(ruling);
    ids.push(id);
  }

  if (chunk) fs.appendFileSync(file, chunk);
  return { ids, file };
}

function parseSectionFields(block) {
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^-\s+([a-zA-Z]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

/**
 * 解析 clarifications.md → 结构化数组（合并 clarification 与其 ruling）。
 * @param {string} runDir
 * @returns {Array<{id, assumption, question, status, decision?, note?}>}
 */
function readClarifications(runDir) {
  const file = clarificationsPath(runDir);
  if (!fs.existsSync(file)) return [];
  const body = fs.readFileSync(file, 'utf8');

  const byId = new Map();
  const order = [];
  const sectionRe = /^##\s+(clarification|ruling)\s+(\S+)\s*$/gim;
  const sections = [];
  let match;
  while ((match = sectionRe.exec(body)) !== null) {
    sections.push({ kind: match[1].toLowerCase(), id: match[2], start: match.index });
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1].start : body.length;
    s.block = body.slice(s.start, end);
  }

  for (const s of sections) {
    const fields = parseSectionFields(s.block);
    if (s.kind === 'clarification') {
      if (!byId.has(s.id)) order.push(s.id);
      byId.set(s.id, {
        id: s.id,
        assumption: fields.assumption || '',
        question: fields.question || '',
        status: 'open',
      });
    } else if (s.kind === 'ruling') {
      const existing = byId.get(s.id) || { id: s.id, assumption: '', question: '', status: 'open' };
      if (!byId.has(s.id)) order.push(s.id);
      byId.set(s.id, {
        ...existing,
        status: 'ruled',
        decision: fields.decision || '',
        note: fields.note || '',
      });
    }
  }

  return order.map((id) => byId.get(id));
}

/**
 * 尚未裁决的 clarification（review gate 注入用）。
 */
function listOpenClarifications(runDir) {
  return readClarifications(runDir).filter((entry) => entry.status === 'open');
}

module.exports = {
  CLARIFICATIONS_FILE,
  clarificationsPath,
  appendClarifications,
  appendRulings,
  readClarifications,
  listOpenClarifications,
};

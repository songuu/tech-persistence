#!/usr/bin/env node

/**
 * secret-scan-on-demand.js
 *
 * Lightweight, dependency-free secret scanner for manual checks. It is not a
 * pre-commit gate; run it when a security-sensitive change needs a quick sweep.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP_DIRS = new Set([
  '.git',
  '.agent-runs',
  '.worktrees',
  'node_modules',
  'worktrees',
]);

const SKIP_EXTENSIONS = new Set([
  '.7z', '.avif', '.bmp', '.class', '.dll', '.exe', '.gif', '.ico', '.jar',
  '.jpeg', '.jpg', '.pdf', '.png', '.pyc', '.sqlite', '.webp', '.zip',
]);

const SECRET_PATTERNS = [
  {
    id: 'private_key_header',
    regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'aws_access_key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'openai_key',
    regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g,
  },
  {
    id: 'generic_api_key_assignment',
    regex: /["']?\b(api[_-]?key|apikey)\b["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_./+=-]{19,})["']?/gi,
  },
  {
    id: 'token_assignment',
    regex: /["']?\b(access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_./+=-]{19,})["']?/gi,
  },
];

function parseArgs(argv) {
  const args = {
    paths: [],
    includeUntracked: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--include-untracked') {
      args.includeUntracked = true;
    } else if (arg === '--paths') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.paths.push(argv[++i]);
      }
      if (args.paths.length === 0) throw new Error('--paths requires at least one path');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      args.paths.push(arg);
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/secret-scan-on-demand.js',
    '  node scripts/secret-scan-on-demand.js --paths scripts docs user-level plugins .codex',
    '  node scripts/secret-scan-on-demand.js --include-untracked',
    '  node scripts/secret-scan-on-demand.js --json',
    '',
    'Exit codes:',
    '  0 clean',
    '  1 findings',
    '  2 usage/internal error',
  ].join('\n'));
}

function normalizeRel(filePath, cwd = process.cwd()) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function shouldSkipPath(filePath, cwd = process.cwd()) {
  const rel = normalizeRel(filePath, cwd);
  if (!rel || rel.startsWith('..')) return false;
  if (rel === 'docs/archives' || rel.startsWith('docs/archives/')) return true;

  const parts = rel.split('/');
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  return SKIP_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkPath(startPath, cwd = process.cwd(), files = []) {
  if (!fs.existsSync(startPath)) return files;
  if (shouldSkipPath(startPath, cwd)) return files;

  const stat = fs.statSync(startPath);
  if (stat.isFile()) {
    files.push(startPath);
    return files;
  }
  if (!stat.isDirectory()) return files;

  for (const entry of fs.readdirSync(startPath, { withFileTypes: true })) {
    const full = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkPath(full, cwd, files);
    } else if (entry.isFile()) {
      if (!shouldSkipPath(full, cwd)) files.push(full);
    }
  }
  return files;
}

function gitFiles(cwd, includeUntracked) {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean);

  if (!includeUntracked) return tracked;

  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean);

  return [...tracked, ...untracked];
}

function collectCandidateFiles(args, cwd = process.cwd()) {
  const seen = new Set();
  const files = [];
  const add = (filePath) => {
    const full = path.resolve(filePath);
    if (seen.has(full) || shouldSkipPath(full, cwd)) return;
    seen.add(full);
    files.push(full);
  };

  if (args.paths.length > 0) {
    for (const inputPath of args.paths) {
      const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
      walkPath(resolved, cwd).forEach(add);
    }
    return files.sort();
  }

  try {
    gitFiles(cwd, args.includeUntracked).forEach((rel) => add(path.join(cwd, rel)));
  } catch {
    walkPath(cwd, cwd).forEach(add);
  }

  return files.sort();
}

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

function isLikelyExample(line) {
  const lower = line.toLowerCase();
  return ['example', 'placeholder', 'dummy', 'fake', 'redacted', 'sample', 'changeme', 'your_api_key', 'your-token', 'your_token']
    .some((marker) => lower.includes(marker))
    || /x{4,}/i.test(line)
    || line.includes('<REPLACE_ME>')
    || line.includes('...');
}

function redactLine(line) {
  return line
    .replace(/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g, (match) => `${match.slice(0, 7)}[REDACTED]`)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
    .replace(
      /(["']?\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?)([A-Za-z0-9][A-Za-z0-9_./+=-]{7,})(["']?)/gi,
      '$1[REDACTED]$3'
    )
    .replace(/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, '-----BEGIN [REDACTED] PRIVATE KEY-----');
}

function scanContent(content, file, cwd = process.cwd()) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  const rel = normalizeRel(file, cwd);

  lines.forEach((line, index) => {
    if (!line || isLikelyExample(line)) return;

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        findings.push({
          file: rel,
          line: index + 1,
          column: match.index + 1,
          pattern: pattern.id,
          redacted: redactLine(line).trim().slice(0, 260),
        });
      }
    }
  });

  return findings;
}

function scanFiles(files, cwd = process.cwd()) {
  const findings = [];
  const skipped = [];
  let scannedFiles = 0;

  for (const file of files) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch (error) {
      skipped.push({ file: normalizeRel(file, cwd), reason: error.message });
      continue;
    }
    if (isBinaryBuffer(buffer)) {
      skipped.push({ file: normalizeRel(file, cwd), reason: 'binary' });
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanContent(buffer.toString('utf8'), file, cwd));
  }

  return { findings, scannedFiles, skippedFiles: skipped.length, skipped };
}

function formatTextResult(result) {
  if (result.findings.length === 0) {
    return `[secret-scan] clean (${result.scannedFiles} files scanned, ${result.skippedFiles} skipped)`;
  }

  const lines = [
    `[secret-scan] found ${result.findings.length} potential secret(s) in ${result.scannedFiles} scanned file(s):`,
  ];
  result.findings.forEach((finding) => {
    lines.push(`  ${finding.file}:${finding.line}:${finding.column} [${finding.pattern}] ${finding.redacted}`);
  });
  return lines.join('\n');
}

function run(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const files = collectCandidateFiles(args, cwd);
  const result = scanFiles(files, cwd);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTextResult(result));
  }

  return result.findings.length > 0 ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(run());
  } catch (error) {
    console.error(`[secret-scan] ${error.message}`);
    process.exit(2);
  }
}

module.exports = {
  SECRET_PATTERNS,
  collectCandidateFiles,
  formatTextResult,
  isLikelyExample,
  parseArgs,
  redactLine,
  run,
  scanContent,
  scanFiles,
};

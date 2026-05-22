#!/usr/bin/env node

/**
 * figma-fidelity-audit.js
 *
 * Lightweight guard for Figma -> code work. It catches hardcoded visual values
 * that usually indicate a missing design-token mapping.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCANNABLE_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
]);

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const TOKEN_SOURCE_RE = /(^|[\\/])(?:tokens?|design-tokens?|theme|themes|variables|style-dictionary|tailwind\.config)(?:[\\/._-]|$)/i;
const FILE_ALLOW_RE = /figma-fidelity-audit:\s*allow-file/i;
const LINE_ALLOW_RE = /figma-fidelity-allow/i;

function usage() {
  return [
    'Usage: node scripts/figma-fidelity-audit.js --paths <file-or-dir>...',
    '',
    'Options:',
    '  --paths <...>       Files or directories to scan',
    '  --json              Print machine-readable JSON',
    '  --help              Show this help',
    '',
    'Inline allowlist:',
    '  /* figma-fidelity-allow: reason */',
    '  /* figma-fidelity-audit: allow-file */',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { paths: [], json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--paths') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.paths.push(argv[++i]);
      }
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!args.help && args.paths.length === 0) {
    throw new Error('missing --paths');
  }
  return args;
}

function isTokenSource(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return TOKEN_SOURCE_RE.test(normalized);
}

function shouldScanFile(filePath) {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !isTokenSource(filePath);
}

function collectFiles(inputPaths, cwd = process.cwd()) {
  const files = [];
  const skipped = [];

  function visit(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (error) {
      skipped.push({ path: path.relative(cwd, absPath), reason: `not readable: ${error.message}` });
      return;
    }

    if (stat.isDirectory()) {
      const base = path.basename(absPath);
      if (SKIP_DIRS.has(base)) {
        skipped.push({ path: path.relative(cwd, absPath), reason: 'skipped directory' });
        return;
      }
      for (const entry of fs.readdirSync(absPath)) {
        visit(path.join(absPath, entry));
      }
      return;
    }

    if (!stat.isFile()) return;
    if (shouldScanFile(absPath)) {
      files.push(absPath);
    } else {
      skipped.push({ path: path.relative(cwd, absPath), reason: 'not scannable or token source' });
    }
  }

  for (const input of inputPaths) {
    visit(path.resolve(cwd, input));
  }

  return { files: [...new Set(files)].sort(), skipped };
}

function lineColumnFromIndex(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function lineTextAt(text, lineNumber) {
  return text.split(/\r?\n/)[lineNumber - 1] || '';
}

function isAllowedLine(text, lineNumber) {
  const lines = text.split(/\r?\n/);
  const current = lines[lineNumber - 1] || '';
  const previous = lines[lineNumber - 2] || '';
  return LINE_ALLOW_RE.test(current) || LINE_ALLOW_RE.test(previous);
}

function pushFinding(findings, filePath, text, match, kind, message, cwd) {
  const { line, column } = lineColumnFromIndex(text, match.index);
  if (isAllowedLine(text, line)) return;
  findings.push({
    file: path.relative(cwd, filePath).replace(/\\/g, '/'),
    line,
    column,
    kind,
    value: match[0],
    message,
    source: lineTextAt(text, line).trim(),
  });
}

function scanText(filePath, text, cwd = process.cwd()) {
  if (FILE_ALLOW_RE.test(text)) return [];

  const findings = [];
  const hexRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  const colorFnRe = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;
  const pxRe = /(^|[^\w-])-?(\d*\.?\d+)px\b/g;

  let match;
  while ((match = hexRe.exec(text)) !== null) {
    pushFinding(findings, filePath, text, match, 'hardcoded_hex_color', 'Use a design token instead of a hardcoded hex color.', cwd);
  }

  while ((match = colorFnRe.exec(text)) !== null) {
    pushFinding(findings, filePath, text, match, 'hardcoded_color_function', 'Use a design token instead of rgb()/hsl().', cwd);
  }

  while ((match = pxRe.exec(text)) !== null) {
    const numeric = Number(match[2]);
    if (!Number.isFinite(numeric) || numeric <= 1) continue;
    const valueOffset = match[0].lastIndexOf(match[2]);
    const adjusted = { 0: `${match[2]}px`, index: match.index + valueOffset };
    pushFinding(findings, filePath, text, adjusted, 'hardcoded_px', 'Use a spacing/size token or record this value in the Figma fallback map.', cwd);
  }

  return findings;
}

function scanFiles(files, cwd = process.cwd()) {
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    findings.push(...scanText(file, text, cwd));
  }
  return findings;
}

function formatFinding(finding) {
  return `${finding.file}:${finding.line}:${finding.column} [${finding.kind}] ${finding.value} — ${finding.message}\n  ${finding.source}`;
}

function run(argv = process.argv.slice(2), cwd = process.cwd()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[figma-fidelity-audit] ${error.message}`);
    console.error(usage());
    return 2;
  }

  if (args.help) {
    console.log(usage());
    return 0;
  }

  const { files, skipped } = collectFiles(args.paths, cwd);
  const findings = scanFiles(files, cwd);
  const result = {
    scannedFiles: files.map((file) => path.relative(cwd, file).replace(/\\/g, '/')),
    skipped,
    findings,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return findings.length > 0 ? 1 : 0;
  }

  if (findings.length === 0) {
    console.log(`[figma-fidelity-audit] clean (${files.length} file(s) scanned)`);
    return 0;
  }

  console.log(`[figma-fidelity-audit] ${findings.length} finding(s) in ${files.length} file(s)`);
  for (const finding of findings) {
    console.log(formatFinding(finding));
  }
  console.log('');
  console.log('Fix: map values to design tokens, or add `figma-fidelity-allow: reason` for an intentional exception.');
  return 1;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = {
  collectFiles,
  formatFinding,
  isTokenSource,
  parseArgs,
  run,
  scanFiles,
  scanText,
  shouldScanFile,
};

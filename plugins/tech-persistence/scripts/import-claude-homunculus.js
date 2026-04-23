#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homeDir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir(), value.slice(2));
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    from: path.join(homeDir(), '.claude', 'homunculus'),
    to: path.join(homeDir(), '.codex', 'homunculus'),
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from') {
      options.from = expandHome(argv[index + 1]);
      index += 1;
    } else if (arg === '--to') {
      options.to = expandHome(argv[index + 1]);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.from || !options.to) {
    throw new Error('--from and --to require paths');
  }

  options.from = path.resolve(options.from);
  options.to = path.resolve(options.to);
  return options;
}

function showHelp() {
  console.log(`Import Claude homunculus data into Codex.

Usage:
  node plugins/tech-persistence/scripts/import-claude-homunculus.js [options]

Options:
  --from <path>  Source directory. Default: ~/.claude/homunculus
  --to <path>    Target directory. Default: ~/.codex/homunculus
  --dry-run      Report planned copy without writing files
  --force        Replace the target directory if it already exists
  --help         Show this help
`);
}

function isTransient(filePath) {
  const name = path.basename(filePath);
  return name === '.DS_Store'
    || name === 'Thumbs.db'
    || name.startsWith('.write-test-')
    || name.endsWith('.lock')
    || name.endsWith('.tmp')
    || name.endsWith('.temp');
}

function collectEntries(sourceRoot) {
  const entries = [];

  function visit(current) {
    if (isTransient(current)) return;
    const stat = fs.lstatSync(current);
    const relative = path.relative(sourceRoot, current);

    if (relative) {
      entries.push({
        relative,
        directory: stat.isDirectory(),
        size: stat.isFile() ? stat.size : 0,
      });
    }

    if (stat.isDirectory()) {
      fs.readdirSync(current)
        .sort()
        .forEach((name) => visit(path.join(current, name)));
    }
  }

  visit(sourceRoot);
  return entries;
}

function copyEntries(sourceRoot, targetRoot, entries) {
  entries
    .filter((entry) => entry.directory)
    .forEach((entry) => {
      fs.mkdirSync(path.join(targetRoot, entry.relative), { recursive: true });
    });

  entries
    .filter((entry) => !entry.directory)
    .forEach((entry) => {
      const source = path.join(sourceRoot, entry.relative);
      const target = path.join(targetRoot, entry.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showHelp();
    return;
  }

  if (!fs.existsSync(options.from)) {
    console.log(`[WARN] source missing: ${options.from}`);
    if (options.dryRun) return;
    process.exit(1);
  }

  if (!fs.lstatSync(options.from).isDirectory()) {
    throw new Error(`Source is not a directory: ${options.from}`);
  }

  const targetExists = fs.existsSync(options.to);
  if (targetExists && !options.force && !options.dryRun) {
    throw new Error(`Target exists. Use --force to replace: ${options.to}`);
  }

  const entries = collectEntries(options.from);
  const fileCount = entries.filter((entry) => !entry.directory).length;
  const dirCount = entries.filter((entry) => entry.directory).length;
  const byteCount = entries.reduce((total, entry) => total + entry.size, 0);

  if (options.dryRun) {
    console.log(`[DRY-RUN] from: ${options.from}`);
    console.log(`[DRY-RUN] to: ${options.to}`);
    console.log(`[DRY-RUN] would copy ${fileCount} files, ${dirCount} directories, ${byteCount} bytes`);
    if (targetExists && !options.force) {
      console.log('[DRY-RUN] target exists; real import would require --force');
    }
    return;
  }

  if (targetExists && options.force) {
    fs.rmSync(options.to, { recursive: true, force: true });
  }

  fs.mkdirSync(options.to, { recursive: true });
  copyEntries(options.from, options.to, entries);
  console.log(`[OK] imported ${fileCount} files and ${dirCount} directories`);
  console.log(`[OK] target: ${options.to}`);
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}

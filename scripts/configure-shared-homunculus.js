#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE;
}

function expandHome(value) {
  if (!value) return value;
  const home = homeDir();
  if (!home) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function resolveUserPath(value) {
  return path.resolve(expandHome(value));
}

function defaultConfigPath() {
  return path.join(homeDir(), '.tech-persistence', 'config.json');
}

function showHelp() {
  console.log(`Configure a shared Tech Persistence homunculus directory.

Usage:
  node scripts/configure-shared-homunculus.js --path <homunculus-vault> [options]

Options:
  --path <dir>            Shared homunculus or Obsidian vault directory.
  --vault-path <dir>      Alias for --path.
  --homunculus-home <dir> Alias for --path.
  --config <file>         Config file path. Default: ~/.tech-persistence/config.json
  --dry-run               Print planned changes without writing.
  --force                 Replace an existing config that points elsewhere.
  --allow-outside-home    Allow the shared directory outside the user home.
  --help                  Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    configPath: process.env.TECH_PERSISTENCE_CONFIG
      ? resolveUserPath(process.env.TECH_PERSISTENCE_CONFIG)
      : defaultConfigPath(),
    dryRun: false,
    force: false,
    allowOutsideHome: false,
    help: false,
    target: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path' || arg === '--vault-path' || arg === '--homunculus-home') {
      options.target = argv[index + 1];
      index += 1;
    } else if (arg === '--config') {
      options.configPath = resolveUserPath(argv[index + 1]);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--allow-outside-home') {
      options.allowOutsideHome = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('-') && !options.target) {
      options.target = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.target) throw new Error('--path is required');
  options.target = resolveUserPath(options.target);
  return options;
}

function assertPathAllowed(target, allowOutsideHome) {
  if (allowOutsideHome) return;
  const home = path.resolve(homeDir());
  const relative = path.relative(home, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Shared homunculus must be inside the user home: ${home}`);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function initializeHomunculus(target, dryRun) {
  const dirs = [
    'instincts/personal',
    'instincts/inherited',
    'evolved/skills',
    'evolved/commands',
    'evolved/agents',
    'projects',
    'skill-signals',
    'skill-evals',
    'skill-changelog',
  ];

  const planned = dirs.map((dir) => path.join(target, dir));
  if (dryRun) return planned;

  planned.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

  const configTarget = path.join(target, 'config.json');
  if (!fs.existsSync(configTarget)) {
    const configSource = path.join(repoRoot, 'user-level', 'homunculus', 'config.json');
    if (fs.existsSync(configSource)) {
      fs.copyFileSync(configSource, configTarget);
    }
  }

  const registryTarget = path.join(target, 'projects.json');
  if (!fs.existsSync(registryTarget)) {
    fs.writeFileSync(registryTarget, '{}\n');
  }

  return planned;
}

function configureSharedHomunculus(options) {
  assertPathAllowed(options.target, options.allowOutsideHome);

  const existingConfig = readJson(options.configPath);
  const existingHome = existingConfig
    && (existingConfig.homunculusHome || existingConfig.homunculusDir || existingConfig.vaultPath);

  if (
    existingHome
    && path.resolve(expandHome(existingHome)) !== options.target
    && !options.force
  ) {
    throw new Error(
      `Config already points to ${existingHome}. Re-run with --force to replace it.`
    );
  }

  const initializedDirs = initializeHomunculus(options.target, options.dryRun);
  const now = new Date().toISOString();
  const nextConfig = {
    ...(existingConfig || {}),
    mode: 'shared',
    homunculusHome: options.target,
    updatedAt: now,
  };
  if (!nextConfig.createdAt) nextConfig.createdAt = now;

  if (!options.dryRun) {
    if (
      existingConfig
      && JSON.stringify(existingConfig, null, 2) !== JSON.stringify(nextConfig, null, 2)
    ) {
      fs.copyFileSync(options.configPath, `${options.configPath}.bak.${Date.now()}`);
    }
    writeJson(options.configPath, nextConfig);
  }

  return { initializedDirs, config: nextConfig };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showHelp();
    return;
  }

  const result = configureSharedHomunculus(options);
  const prefix = options.dryRun ? '[DRY-RUN]' : '[OK]';
  console.log(`${prefix} shared homunculus: ${options.target}`);
  console.log(`${prefix} config file: ${options.configPath}`);
  console.log(`${prefix} initialized directories: ${result.initializedDirs.length}`);
  console.log('');
  console.log('Both Claude Code and Codex will use this path automatically via config.');
  console.log('Temporary override examples:');
  console.log(`  PowerShell: $env:TECH_PERSISTENCE_HOME='${options.target}'`);
  console.log(`  Bash: export TECH_PERSISTENCE_HOME='${options.target.replace(/\\/g, '/')}'`);
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
}

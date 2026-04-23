#!/usr/bin/env node

const path = require('path');

const [, , scriptName, ...scriptArgs] = process.argv;

if (!scriptName) {
  process.exit(0);
}

process.env.TECH_PERSISTENCE_RUNTIME = 'codex';

const scriptPath = path.join(__dirname, scriptName);
process.argv = [process.argv[0], scriptPath, ...scriptArgs];
require(scriptPath);

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENV_BYTES = 64 * 1024;

function parsePrivateEnv(content) {
  const env = {};
  for (const line of String(content).split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('Acceptance PostgreSQL private environment contains an invalid line');
    if (Object.prototype.hasOwnProperty.call(env, match[1])) {
      throw new Error(`Acceptance PostgreSQL private environment duplicates ${match[1]}`);
    }
    env[match[1]] = match[2];
  }
  return env;
}

function readPrivateEnvFile(file) {
  const resolved = path.resolve(file);
  let descriptor;
  try {
    const pathBefore = fs.lstatSync(resolved);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new Error('Acceptance PostgreSQL private environment must be a regular non-link file');
    }
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
        || before.size <= 0 || before.size > MAX_ENV_BYTES) {
      throw new Error('Acceptance PostgreSQL private environment must be a bounded regular file');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(resolved);
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Acceptance PostgreSQL private environment changed while it was read');
    }
    if (pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error('Acceptance PostgreSQL private environment path changed while it was read');
    }
    return parsePrivateEnv(content.toString('utf8'));
  } catch (error) {
    if (error && /^Acceptance PostgreSQL private environment/.test(error.message || '')) {
      throw error;
    }
    throw new Error('Acceptance PostgreSQL private environment could not be read safely');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

module.exports = { MAX_ENV_BYTES, parsePrivateEnv, readPrivateEnvFile };

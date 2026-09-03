'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableHash } = require('./runtime-capabilities');
const governance = require('./external-runtime-governance');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function protectedPath(file, workdir, directory = false) {
  if (!path.isAbsolute(file)) throw new Error('authority path must be absolute');
  if (workdir && within(workdir, file)) throw new Error('authority path must be outside provider workspace');
  const target = path.resolve(file);
  for (let current = target; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('authority path must not contain links');
    if (current === target && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('invalid authority path type');
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o022) !== 0 || ![0, process.getuid()].includes(stat.uid)) {
        // /tmp is never an authority root in production.
        throw new Error('authority path ownership or write permissions are unsafe');
      }
    }
    if (path.dirname(current) === current) break;
  }
  return target;
}
function readProtectedJson(file, workdir) {
  const target = protectedPath(file, workdir);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (before.size > 256 * 1024) throw new Error('authority JSON exceeds size limit');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('authority JSON changed while reading');
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function validateEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('external endpoint must be a literal 127.0.0.1 HTTP(S) origin');
  }
  return url.origin;
}
function loadExternalConfig(file, workdir) {
  const input = readProtectedJson(file, workdir);
  const allowed = ['version', 'descriptorId', 'baseUrl', 'model', 'promotionFile', 'canaryFile', 'spoolRoot', 'timeoutMs', 'maxTokens', 'contextFiles'];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || input.version !== 'external-runtime-config-v1'
      || input.descriptorId !== 'openai-compatible-chat-v1') throw new Error('invalid external runtime config');
  const baseUrl = validateEndpoint(input.baseUrl);
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw new Error('external model is required');
  const canary = readProtectedJson(input.canaryFile, workdir);
  const promotion = readProtectedJson(input.promotionFile, workdir);
  const expected = governance.promotionDecision({ descriptorId: input.descriptorId, registered: true,
    observedCapability: true, explicitPromotion: true, environmentKeys: [], canary });
  if (!expected.eligible || promotion.receiptHash !== stableHash((({ receiptHash, ...core }) => core)(promotion))
      || promotion.descriptorHash !== expected.descriptorHash || promotion.canaryReceiptHash !== canary.receiptHash
      || promotion.route !== 'read-only' || promotion.writerEligible !== false || promotion.eligible !== true
      || stableHash(promotion.checks) !== stableHash(expected.checks)) throw new Error('external promotion/canary binding is invalid');
  if (canary.endpointHash !== sha256(baseUrl) || canary.modelHash !== sha256(input.model)) throw new Error('external endpoint/model differs from canary');
  protectedPath(input.spoolRoot, workdir, true);
  const timeoutMs = input.timeoutMs ?? 30000;
  const maxTokens = input.maxTokens ?? 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000
      || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('external resource limits are invalid');
  const contextFiles = input.contextFiles || [];
  if (!Array.isArray(contextFiles) || contextFiles.length > 16 || contextFiles.some((item) => typeof item !== 'string' || path.isAbsolute(item) || /(^|[\\/])\.\.([\\/]|$)/.test(item))) throw new Error('external contextFiles must be bounded relative paths');
  const config = { ...input, baseUrl, timeoutMs, maxTokens, contextFiles, promotion, canary };
  return { ...config, configHash: stableHash(config) };
}
function stages(options = {}) {
  const value = options['external-stages'];
  const selected = value === undefined ? [] : String(value).split(',');
  if (selected.some((stage) => !['spec', 'review'].includes(stage)) || new Set(selected).size !== selected.length) throw new Error('external-stages allows only spec,review; never implementation');
  return selected;
}
function configured(options = {}, workdir) {
  const selected = stages(options);
  if (!selected.length) return null;
  if (!options['external-runtime-config']) throw new Error('external-runtime-config is required');
  const config = loadExternalConfig(String(options['external-runtime-config']), workdir || options.workdir || process.cwd());
  if (options.externalConfigHash && options.externalConfigHash !== config.configHash) throw new Error('external runtime configuration drift');
  return config;
}
module.exports = { sha256, within, protectedPath, readProtectedJson, validateEndpoint, loadExternalConfig, stages, configured };

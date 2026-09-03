'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readProtectedJson } = require('../agent-orchestrator/external-runtime-config');
function databaseConfig(value, purpose) {
  if (!['runtime', 'admin', 'tasks', 'transcripts'].includes(purpose)) throw new Error('invalid database purpose');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid auth database configuration'); }
  const expectedUser = { runtime: 'tp_web_auth', admin: 'tp_web_account_admin', tasks: 'tp_web_tasks', transcripts: 'transcript_reader' }[purpose];
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || url.pathname !== '/tech_persistence' || decodeURIComponent(url.username) !== expectedUser
      || !url.password || url.search || url.hash || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new Error('auth database must use its dedicated role and loopback database');
  }
  return { host: '127.0.0.1', port: Number(url.port), database: 'tech_persistence',
    user: expectedUser, password: decodeURIComponent(url.password), ssl: false,
    max: 4, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000,
    statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000,
    application_name: { runtime: 'tp-web-auth', admin: 'tp-web-account-admin', tasks: 'tp-web-tasks', transcripts: 'tp-web-transcript-reader' }[purpose] };
}
function loadTaskConfig(file) {
  const input = readProtectedJson(file, path.resolve(__dirname, '../..'));
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) throw new Error('task config must be owner-readable only');
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['version', 'databaseUrl', 'transcriptDatabaseUrl'].includes(key))
      || input.version !== 'harness-web-task-config-v1') throw new Error('invalid task configuration');
  return { database: databaseConfig(input.databaseUrl, 'tasks'), transcriptDatabase: databaseConfig(input.transcriptDatabaseUrl, 'transcripts') };
}
function loadAuthConfig(file, purpose = 'runtime') {
  const input = readProtectedJson(file, path.resolve(__dirname, '../..'));
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) throw new Error('auth config must be owner-readable only');
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['version', 'databaseUrl', 'publicOrigin', 'port'].includes(key))
      || input.version !== 'harness-web-auth-config-v1') throw new Error('invalid auth configuration');
  const database = databaseConfig(input.databaseUrl, purpose);
  const port = input.port ?? 5183;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid auth port');
  if (purpose === 'runtime' && input.publicOrigin !== 'https://songuu.top') throw new Error('auth public origin must be https://songuu.top');
  return { database, publicOrigin: input.publicOrigin, port };
}
function openPool(config) {
  const { Pool } = require('pg');
  const pool = new Pool(config);
  pool.on('error', () => { process.stderr.write('auth database connection unavailable\n'); });
  return pool;
}
module.exports = { loadAuthConfig, loadTaskConfig, databaseConfig, openPool };

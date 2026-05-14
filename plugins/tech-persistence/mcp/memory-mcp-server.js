#!/usr/bin/env node

/**
 * memory-mcp-server.js — Tech Persistence Memory MCP stdio server
 *
 * 实现最小 MCP 2024-11-05 JSON-RPC over stdio：
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - notifications/initialized (ignore)
 *
 * 工具实现在 ./lib/memory-tools.js（共用代码，便于未来 CLI / skill 复用）。
 * 不主动写 stderr，只在解析错误时回错误响应；任何未捕获异常静默 (exit 0)。
 */

const readline = require('readline');
const { listToolsForMcp, callTool } = require('./lib/memory-tools');

const SERVER_INFO = {
  name: 'tech-persistence-memory',
  version: '0.1.0',
};

const PROTOCOL_VERSION = '2024-11-05';

function writeResponse(obj) {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {}
}

function makeError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

function makeResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function handleInitialize(id) {
  return makeResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: {
      tools: { listChanged: false },
    },
  });
}

function handleToolsList(id) {
  return makeResult(id, { tools: listToolsForMcp() });
}

function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!name) {
    return makeError(id, -32602, 'tools/call missing name');
  }
  const result = callTool(name, args);
  return makeResult(id, result);
}

function dispatch(req) {
  if (!req || typeof req !== 'object') return null;
  const { id, method, params } = req;

  if (method === 'initialize') return handleInitialize(id);
  if (method === 'tools/list') return handleToolsList(id);
  if (method === 'tools/call') return handleToolsCall(id, params || {});
  if (method === 'notifications/initialized') return null;
  if (method && method.startsWith('notifications/')) return null;
  if (id == null) return null;

  return makeError(id, -32601, `Method not found: ${method}`);
}

function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      writeResponse(makeError(null, -32700, 'Parse error'));
      return;
    }
    let response;
    try {
      response = dispatch(req);
    } catch (err) {
      response = makeError(req.id ?? null, -32603, `Internal error: ${err.message || err}`);
    }
    if (response) writeResponse(response);
  });

  rl.on('close', () => process.exit(0));
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { dispatch };

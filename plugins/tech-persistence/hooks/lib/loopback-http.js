'use strict';
const http = require('node:http');
const https = require('node:https');

function abortError() { const error = new Error('loopback request timed out'); error.name = 'AbortError'; return error; }
function requestText(url, options = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1') throw new Error('loopback URL is invalid');
  const timeoutMs = options.timeoutMs; const maxBytes = options.maxBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('loopback limits are invalid');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value); };
    if (options.socketPath && (parsed.protocol !== 'http:'
        || !String(options.socketPath).startsWith('/run/tech-persistence-provider-broker/'))) {
      done(new Error('loopback socket path is invalid')); return;
    }
    const target = options.socketPath
      ? { socketPath: String(options.socketPath), path: `${parsed.pathname}${parsed.search}` }
      : { protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || undefined, path: `${parsed.pathname}${parsed.search}` };
    const request = (parsed.protocol === 'https:' ? https : http).request({ ...target,
      method: options.method || 'GET', headers: options.headers || {}, agent: false
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { request.destroy(); done(new Error('loopback response exceeds size limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', error => done(error));
    });
    request.on('error', error => done(error));
    request.setTimeout(timeoutMs, () => { const error = abortError(); request.destroy(error); done(error); });
    if (options.body) request.write(options.body);
    request.end();
  });
}
module.exports = { requestText };

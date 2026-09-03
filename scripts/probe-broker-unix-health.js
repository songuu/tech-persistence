'use strict';
const http = require('node:http');
const path = require('node:path');

if (process.platform !== 'linux' || process.argv.length !== 3) throw new Error('expected one Linux socket path');
const socketPath = path.resolve(process.argv[2]);
if (!socketPath.startsWith('/run/tech-persistence-provider-broker/')) throw new Error('invalid broker socket path');
const request = http.request({ socketPath, path: '/health', method: 'GET', timeout: 2000 }, response => {
  response.resume();
  response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 3));
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(4));
request.end();

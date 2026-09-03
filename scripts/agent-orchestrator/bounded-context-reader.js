'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { within } = require('./external-runtime-config');

function readBoundedContext(root, relative, maxBytes = 128 * 1024) {
  const base = path.resolve(root), file = path.resolve(base, relative);
  if (path.isAbsolute(relative) || !within(base, file) || file === base) throw new Error('context path escapes allowed root');
  // Linux descriptor paths bind the opened inode, including when a provider races path checks.
  // Windows lacks this primitive here; never downgrade the authority file boundary silently.
  if (process.platform !== 'linux') throw new Error('external file context requires the controlled Linux host');
  if (fs.realpathSync(base) !== base) throw new Error('context root must not be a link');
  for (let current = file; current !== base; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('context must not contain links');
  }
  const expected = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    const actualPath = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev
        || !within(base, actualPath) || before.size > maxBytes) throw new Error('context file identity or size is unsafe');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, length))) length += count;
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('context changed during bounded read');
    return bytes.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
module.exports = { readBoundedContext };

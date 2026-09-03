'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const PARAMETERS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const RECORD = /^scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
// Unknown users incur the same expensive operation, without an actual fallback account.
const DUMMY_RECORD = `scrypt-v1$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 15 && [...value].length <= 128
    && Buffer.byteLength(value, 'utf8') <= 512;
}
function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('invalid username');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(username)) throw new Error('invalid username');
  return username;
}
async function hashPassword(password) {
  if (!validPassword(password)) throw new Error('password must contain 15 to 128 characters and at most 512 bytes');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, PARAMETERS);
  return `scrypt-v1$131072$8$1$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, record) {
  const match = typeof record === 'string' && RECORD.exec(record);
  if (!match) throw new Error('invalid password record');
  if (!validPassword(password)) return false;
  const hash = await scrypt(password, Buffer.from(match[1], 'hex'), 64, PARAMETERS);
  return crypto.timingSafeEqual(hash, Buffer.from(match[2], 'hex'));
}
module.exports = { validPassword, normalizeUsername, hashPassword, verifyPassword, DUMMY_RECORD };

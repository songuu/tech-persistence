'use strict';
const { loadAuthConfig, openPool } = require('./harness-web/config');
const { manageAccount, readAdminInput } = require('./harness-web/account-admin');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--action'
      || !['create', 'disable', 'reset-password'].includes(args[3])) throw new Error('invalid account command');
  const config = loadAuthConfig(args[1], 'admin');
  const input = await readAdminInput(process.stdin);
  const pool = openPool(config.database);
  try { process.stdout.write(`${JSON.stringify(await manageAccount(pool, args[3], input))}\n`); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('TP account operation failed; input and database details are not logged\n'); process.exitCode = 1; });
module.exports = { main };

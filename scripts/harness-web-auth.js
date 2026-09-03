'use strict';
const { loadAuthConfig, openPool } = require('./harness-web/config');
const { createPgAuthStore } = require('./harness-web/auth-store');
const { createAuthService } = require('./harness-web/auth');
const { createAuthServer } = require('./harness-web/auth-server');
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('use --config with a protected file');
  const config = loadAuthConfig(process.argv[3]);
  const pool = openPool(config.database);
  try {
    await pool.query('SELECT id FROM harness_web.accounts LIMIT 0');
    const server = createAuthServer({ service: createAuthService(createPgAuthStore(pool)), publicOrigin: config.publicOrigin });
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve);
    });
    process.stdout.write('TP authentication service listening on loopback\n');
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      // Keep the deadline referenced: an unresolved close must not become a clean process exit.
      const deadline = setTimeout(() => process.exit(1), 5000);
      server.close(async () => {
        try { await pool.end(); process.exitCode = 0; }
        catch { process.exitCode = 1; process.stderr.write('TP authentication service shutdown failed\n'); }
        finally { clearTimeout(deadline); }
      });
      server.closeIdleConnections();
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { await pool.end(); throw error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('TP authentication service failed to start; check protected configuration and database availability\n'); process.exitCode = 1; });
module.exports = { main };

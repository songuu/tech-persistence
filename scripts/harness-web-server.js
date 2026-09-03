'use strict';
const { loadAuthConfig, loadTaskConfig, openPool } = require('./harness-web/config');
const { createPgAuthStore } = require('./harness-web/auth-store');
const { createAuthService } = require('./harness-web/auth');
const { createPgTaskStore } = require('./harness-web/task-store');
const { createTaskService } = require('./harness-web/task-service');
const { createAuthServer } = require('./harness-web/auth-server');

async function main() {
  if (process.argv.length !== 6 || process.argv[2] !== '--auth-config' || process.argv[4] !== '--task-config') {
    throw new Error('use --auth-config and --task-config with protected files');
  }
  const authConfig = loadAuthConfig(process.argv[3]); const taskConfig = loadTaskConfig(process.argv[5]);
  const authPool = openPool(authConfig.database); const taskPool = openPool(taskConfig.database);
  const transcriptPool = openPool(taskConfig.transcriptDatabase);
  try {
    await authPool.query('SELECT id FROM harness_web.accounts LIMIT 0');
    await transcriptPool.query('SELECT transcript_id FROM public.transcripts LIMIT 0');
    await taskPool.query('SELECT harness_tasks.list_projects($1) LIMIT 0', ['0'.repeat(64)]).catch(error => {
      if (error.code !== 'P0401') throw error;
    });
    const server = createAuthServer({ service: createAuthService(createPgAuthStore(authPool)),
      taskService: createTaskService(createPgTaskStore(taskPool, transcriptPool)), publicOrigin: authConfig.publicOrigin });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(authConfig.port, '127.0.0.1', resolve); });
    process.stdout.write('TP Harness web service listening on loopback\n');
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      const deadline = setTimeout(() => process.exit(1), 5000);
      server.close(async () => {
        try { await Promise.all([authPool.end(), taskPool.end(), transcriptPool.end()]); process.exitCode = 0; }
        catch { process.exitCode = 1; process.stderr.write('TP Harness web service shutdown failed\n'); }
        finally { clearTimeout(deadline); }
      });
      server.closeIdleConnections();
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { await Promise.allSettled([authPool.end(), taskPool.end(), transcriptPool.end()]); throw error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('TP Harness web service failed to start; check protected configuration and database availability\n'); process.exitCode = 1; });
module.exports = { main };

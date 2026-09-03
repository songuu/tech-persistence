'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'linux' || process.getuid() !== 0) {
  console.log('SKIP real worker sandbox test: requires root on the controlled Linux host');
  process.exit(0);
}
const sharedRoot = '/var/lib/tech-persistence/workspace';
const fixtureRoot = path.join(sharedRoot, `a3-worker-e2e-${process.pid}`);
assert.equal(path.dirname(fixtureRoot), sharedRoot);
const authorityUid = Number(execFileSync('/usr/bin/id', ['-u', 'tp-authority'], { encoding: 'utf8' }).trim());
const authorityGid = Number(execFileSync('/usr/bin/id', ['-g', 'tp-authority'], { encoding: 'utf8' }).trim());
const providerGid = Number(execFileSync('/usr/bin/id', ['-g', 'tp-provider'], { encoding: 'utf8' }).trim());
const launcherPath = process.env.TP_TEST_PROVIDER_LAUNCHER || '/usr/local/libexec/tech-persistence/provider-identity-launcher';
assert.ok(path.isAbsolute(launcherPath));
const runtimeRoot = path.join(fixtureRoot, 'runtime'); const sourceRoot = path.join(fixtureRoot, 'source');
const codexRoot = path.join(fixtureRoot, 'codex'); const brokerSocketRoot = path.join(fixtureRoot, 'broker');
const taskRuntimeConfigRoot = path.join(fixtureRoot, 'task-runtime-config');
const gitConfigPath = path.join(fixtureRoot, 'git-system.config');
const sandboxRoot = path.join(fixtureRoot, 'sandboxes'); const siblingRoot = path.join(fixtureRoot, 'other-task');
function chownTree(target, uid, gid) {
  const stat = fs.lstatSync(target); fs.chownSync(target, uid, gid);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) chownTree(path.join(target, entry), uid, gid);
}
function write(file, value, mode = 0o640) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); }
try {
  fs.mkdirSync(fixtureRoot, { mode: 0o750 }); fs.chownSync(fixtureRoot, authorityUid, providerGid);
  fs.mkdirSync(sourceRoot); write(path.join(sourceRoot, 'deleted-secret.txt'), 'MUST_NOT_REACH_SHALLOW_CLONE\n');
  execFileSync('/usr/bin/git', ['-C', sourceRoot, 'init', '-q']);
  execFileSync('/usr/bin/git', ['-C', sourceRoot, 'config', 'user.name', 'A3 Fixture']);
  execFileSync('/usr/bin/git', ['-C', sourceRoot, 'config', 'user.email', 'fixture@invalid']);
  execFileSync('/usr/bin/git', ['-C', sourceRoot, 'add', 'deleted-secret.txt']); execFileSync('/usr/bin/git', ['-C', sourceRoot, 'commit', '-qm', 'old secret fixture']);
  fs.unlinkSync(path.join(sourceRoot, 'deleted-secret.txt')); write(path.join(sourceRoot, 'tracked.txt'), 'tracked fixture\n');
  execFileSync('/usr/bin/git', ['-C', sourceRoot, 'add', '-A']); execFileSync('/usr/bin/git', ['-C', sourceRoot, 'commit', '-qm', 'safe fixture']);
  write(path.join(sourceRoot, '.env'), 'MUST_NOT_BE_STAGED\n', 0o640);
  write(gitConfigPath, `[safe]\n\tdirectory = "${sourceRoot}"\n\tdirectory = "${sourceRoot}/.git"\n`, 0o440);
  fs.chownSync(gitConfigPath, 0, 0); fs.chmodSync(gitConfigPath, 0o444);
  fs.mkdirSync(runtimeRoot);
  for (const directory of [codexRoot, brokerSocketRoot, taskRuntimeConfigRoot]) fs.mkdirSync(directory);
  const providerUid = Number(execFileSync('/usr/bin/id', ['-u', 'tp-provider'], { encoding: 'utf8' }).trim());
  const providerFixturePath = path.join(runtimeRoot, 'provider-fixture.js');
  const providerFixture = `'use strict';\nconst fs=require('node:fs');\nconst workspace=process.argv[2];\nconst sibling=process.argv[3];\nif(fs.readFileSync(workspace+'/tracked.txt','utf8')!=='tracked fixture\\n')process.exit(35);\nif(fs.existsSync(workspace+'/.env'))process.exit(32);\nif(fs.existsSync('/var/lib/tech-persistence/authority/acceptance.env'))process.exit(33);\nif(fs.existsSync(sibling))process.exit(34);\nfs.writeFileSync(workspace+'/result.txt',JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()}));\nprocess.stdout.write('sandbox-ok');\n`;
  write(providerFixturePath, providerFixture, 0o440);
  const fakeHarness = `'use strict';\nconst fs=require('node:fs');\nconst {spawnSync}=require('node:child_process');\nconst value=name=>process.argv[process.argv.indexOf(name)+1];\nconst requirement=fs.readFileSync(value('--requirement-file'),'utf8');\nif(requirement!=='sandbox e2e')process.exit(31);\nconst workspace=value('--workdir');\nconst sandbox=['--die-with-parent','--unshare-all','--unshare-user','--uid','0','--gid','0','--cap-drop','ALL','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind-try','/lib','/lib','--ro-bind-try','/lib64','/lib64','--ro-bind',${JSON.stringify(providerFixturePath)},'/provider-fixture.js','--bind',workspace,'/workspace','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/workspace','/usr/bin/node','/provider-fixture.js','/workspace',${JSON.stringify(path.join(siblingRoot, 'sentinel'))}];\nconst child=spawnSync(${JSON.stringify(launcherPath)},['--reuid',${providerUid},'--regid',${providerGid},'--clear-groups','--','/usr/bin/bwrap',...sandbox],{encoding:'utf8'});\nif(child.status!==0)process.exit(child.status||36);\nconst runRoot=value('--runs-dir')+'/'+value('--run-id');\nfs.mkdirSync(runRoot,{recursive:true});\nfs.writeFileSync(runRoot+'/state.json',JSON.stringify({status:'spec-ready'}));\nprocess.stdout.write(child.stdout);\n`;
  write(path.join(runtimeRoot, 'scripts', 'agent-orchestrator.js'), fakeHarness, 0o440);
  write(path.join(runtimeRoot, 'scripts', 'harness-task-runtime-entrypoint.sh'), '#!/bin/sh\nexec "$@"\n', 0o550);
  const stubborn = `'use strict';\nconst {spawn}=require('node:child_process');\nprocess.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})+'\\n');setInterval(()=>{},1000);\n`;
  write(path.join(runtimeRoot, 'stubborn.js'), stubborn, 0o440);
  const workerPrivate = path.join(fixtureRoot, 'harness-task-worker.js'); fs.copyFileSync(path.join(__dirname, 'harness-task-worker.js'), workerPrivate);
  const driverPath = path.join(fixtureRoot, 'driver.js');
  const driver = `'use strict';\nconst fs=require('node:fs');\nconst {runClaim,runBoundedProcess,launcherArgs,validateWorkerConfig,validateGitConfigFile}=require(${JSON.stringify(workerPrivate)});\nconst config=${JSON.stringify({ version: 'harness-task-worker-v1', workerId: 'authority-e2e', sandboxRoot,
    runtimeRoot, externalRuntimeConfigPath: path.join(taskRuntimeConfigRoot, 'external-runtime.json'),
    runtimeCapabilityEvidencePath: path.join(taskRuntimeConfigRoot, 'runtime-capability-evidence.json'),
    codexCommandPath: path.join(runtimeRoot, 'scripts', 'codex-task-provider.sh'),
    launcherPath, gitPath: '/usr/bin/git', gitConfigPath, duPath: '/usr/bin/du', mkdirPath: '/usr/bin/mkdir', chmodPath: '/usr/bin/chmod',
    providerUid, providerGid, maxLogBytes: 65536, maxWorkspaceBytes: 67108864, minimumFreeBytes: 16777216, idleMs: 1000, nodePath: '/usr/bin/node',
    orchestratorPath: path.join(runtimeRoot, 'scripts/agent-orchestrator.js'), heartbeatMs: 1000,
    projects: { 'fixture-project': { sourceRoot, timeoutMs: 30000 } } })};\nconst events=[];\nconst store={heartbeat:async()=>({owned:true,cancel:false}),start:async()=>{events.push('start');return true},releaseBeforeDispatch:async()=>true,failBeforeDispatch:async()=>false,finish:async x=>{events.push(x);return true}};\nconst claim={taskId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',claimToken:'11111111-2222-4333-8444-555555555555',ownerId:'99999999-aaaa-4bbb-8ccc-dddddddddddd',projectId:'fixture-project',requirement:'sandbox e2e'};\n(async()=>{const result=await runClaim(store,config,claim);const attempt=config.sandboxRoot+'/'+claim.taskId+'/'+claim.claimToken;if(result.outcome!=='needs_coordination'||events[0]!=='start'||events[1].code!=='qualification_pending')process.exit(41);if(fs.readFileSync(attempt+'/evidence/stdout.log','utf8')!=='sandbox-ok')process.exit(42);const killed=await runBoundedProcess(config.launcherPath,launcherArgs(config,config.nodePath,[${JSON.stringify(path.join(runtimeRoot, 'stubborn.js'))}]),{timeoutMs:100,heartbeatMs:50,maxLogBytes:65536,killGraceMs:2000,env:{PATH:'/usr/bin:/bin'}});if(killed.reason!=='timeout')process.exit(45);const pids=JSON.parse(killed.stdout.toString().trim());await new Promise(r=>setTimeout(r,100));for(const pid of [pids.parent,pids.child]){try{process.kill(pid,0);process.exit(46)}catch(e){if(e.code!=='ESRCH')process.exit(47)}}process.stdout.write(JSON.stringify({sandbox:true,stagedTrackedOnly:true,authoritySecretVisible:false,crossTaskVisible:false,processTreeKilled:true,outcome:result.outcome}));})().catch(()=>process.exit(44));\n`;
  const instrumentedDriver = driver
    .replace("events[1].code!=='qualification_pending'", "events[1].code!=='harness_spec_ready'")
    .replace('\nconst events=[];',
    "\nconfig.projects['fixture-project'].validationCommands=['node test.js'];\nvalidateGitConfigFile(validateWorkerConfig(config));\nconst events=[];")
    .replace('.catch(()=>process.exit(44))', '.catch(error=>{process.stderr.write(String(error.message));process.exit(44)})');
  write(driverPath, instrumentedDriver, 0o400);
  fs.chownSync(workerPrivate, authorityUid, authorityGid); fs.chmodSync(workerPrivate, 0o400); fs.chownSync(driverPath, authorityUid, authorityGid);
  fs.mkdirSync(sandboxRoot); fs.chownSync(sandboxRoot, authorityUid, providerGid); fs.chmodSync(sandboxRoot, 0o2710);
  fs.mkdirSync(siblingRoot); write(path.join(siblingRoot, 'sentinel'), 'private');
  chownTree(sourceRoot, 0, providerGid); chownTree(runtimeRoot, 0, providerGid); chownTree(siblingRoot, authorityUid, providerGid);
  for (const directory of [codexRoot, brokerSocketRoot, taskRuntimeConfigRoot]) chownTree(directory, 0, providerGid);
  for (const directory of [sourceRoot, runtimeRoot, siblingRoot, codexRoot, brokerSocketRoot, taskRuntimeConfigRoot]) fs.chmodSync(directory, 0o750);
  // Mirror the production unit: the authority keeps its primary group and gets
  // only the provider group needed for setgid task-directory inheritance.
  const output = execFileSync('/usr/sbin/runuser', ['-u', 'tp-authority', '-g', 'tp-authority', '-G', 'tp-provider', '--', '/usr/bin/node', driverPath],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin' } });
  const result = JSON.parse(output); assert.deepEqual(result, { sandbox: true, stagedTrackedOnly: true,
    authoritySecretVisible: false, crossTaskVisible: false, processTreeKilled: true, outcome: 'needs_coordination' });
  const workspace = path.join(sandboxRoot, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '11111111-2222-4333-8444-555555555555', 'output', 'workspace');
  assert.equal(fs.existsSync(path.join(workspace, '.env')), false); assert.equal(fs.existsSync(path.join(workspace, 'deleted-secret.txt')), false);
  const objects = execFileSync('/usr/sbin/runuser', ['-u', 'tp-authority', '-g', 'tp-authority', '-G', 'tp-provider', '--', '/usr/bin/git', '-C', workspace,
    'rev-list', '--objects', '--all'], { encoding: 'utf8' }); assert.ok(!objects.includes('deleted-secret.txt'));
  const identity = JSON.parse(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8'));
  assert.equal(identity.uid, 0); assert.equal(identity.gid, 0); assert.ok(identity.groups.every(value => value === 0));
  const resultOwner = fs.statSync(path.join(workspace, 'result.txt'));
  assert.equal(resultOwner.uid, providerUid); assert.equal(resultOwner.gid, providerGid);
  console.log(JSON.stringify({ controlledLinuxSandbox: true, providerGid, ...result }));
} finally {
  assert.equal(path.dirname(fixtureRoot), sharedRoot);
  if (process.env.TP_PRESERVE_FAILED_FIXTURE === '1') console.error(`preserved fixture: ${fixtureRoot}`);
  else fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (process.env.TP_PRESERVE_FAILED_FIXTURE !== '1') assert.equal(fs.existsSync(fixtureRoot), false);
}

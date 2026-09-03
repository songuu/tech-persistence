'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');
const { assertStructuredOutput } = require('./agent-orchestrator/structured-output');

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 4) {
  throw new Error('root Linux invocation with evidence directory and release command required');
}
const evidenceRoot = '/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t';
const evidenceDir = fs.realpathSync(process.argv[2]);
if (path.dirname(evidenceDir) !== evidenceRoot || !path.basename(evidenceDir).startsWith('native-writer-evidence.')) throw new Error('invalid writer evidence directory');
const evidenceFile = path.join(evidenceDir, 'codex.jsonl');
const hashFile = file => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const qualifiedCommandPath = '/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3/scripts/codex-task-provider.sh';
const commandPath = fs.realpathSync(process.argv[3]);
const commandStat = fs.lstatSync(commandPath);
if (!commandPath.startsWith('/opt/tech-persistence-harness/releases/') || !commandPath.endsWith('/scripts/codex-task-provider.sh')
    || !commandStat.isFile() || commandStat.isSymbolicLink() || commandStat.uid !== 0 || (commandStat.mode & 0o022) !== 0
    || hashFile(commandPath) !== hashFile(qualifiedCommandPath)) {
  throw new Error('release command does not match the qualified writer');
}
const modelFile = '/etc/tech-persistence/provider-model';
const output = '/var/lib/tech-persistence/task-runtime/runtime-capability-evidence.json';
const proof = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'workspace-proof.json'), 'utf8'));
const workspaceStat = fs.lstatSync(proof.workspacePath);
const expectedWorkspaceHash = `sha256:${crypto.createHash('sha256').update('HARNESS_NATIVE_WRITER_OK\n').digest('hex')}`;
if (!workspaceStat.isFile() || workspaceStat.isSymbolicLink() || workspaceStat.uid !== 986 || proof.uid !== 986
    || proof.contentHash !== expectedWorkspaceHash || proof.contentHash !== hashFile(proof.workspacePath)) throw new Error('native writer workspace proof is invalid');
const events = fs.readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const handoffFile = path.join(evidenceDir, 'handoff.json');
const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
assertStructuredOutput(handoff, { schemaRoot: path.join(__dirname, '..', 'schemas', 'agent-loop'),
  schemaName: 'agent-handoff.schema.json', label: 'writer capability handoff' });
const completedCommands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution'
  && event.item.status === 'completed' && event.item.exit_code === 0);
if (!events.some(event => event.type === 'turn.completed') || !events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
    || completedCommands.length < 1 || !completedCommands.some(event => String(event.item.command).includes('/workspace/qualification.txt'))) {
  throw new Error('native writer evidence is incomplete');
}
const core = { schemaVersion: 'runtime-capability-evidence-v1',
  binding: { commandPath, commandHash: hashFile(commandPath), modelPath: modelFile, modelHash: hashFile(modelFile) },
  providers: { implementation: { source: 'authority-native-writer-probe',
    observedAt: fs.statSync(evidenceFile).mtime.toISOString(), evidenceHash: stableHash({ eventsHash: hashFile(evidenceFile),
      handoffHash: hashFile(handoffFile), workspaceHash: proof.contentHash }),
    runtimeObserved: { stdin: true, 'structured-output': true, 'repo-read': true, 'workspace-write': true } } } };
const receipt = { ...core, receiptHash: stableHash(core) };
const temporary = `${output}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o440 });
fs.chownSync(temporary, 0, fs.statSync(path.dirname(output)).gid);
fs.renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({ receiptHash: receipt.receiptHash, evidenceHash: receipt.providers.implementation.evidenceHash })}\n`);

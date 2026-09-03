'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { stableHash } = require('./agent-orchestrator/runtime-capabilities');
const configApi = require('./agent-orchestrator/external-runtime-config');
const governance = require('./agent-orchestrator/external-runtime-governance');
const native = require('./agent-orchestrator/native-execution-control');
const profiles = require('./agent-orchestrator/provider-profiles');
const invocation = require('./agent-orchestrator/external-runtime-invocation');
const capabilityEvidence = require('./agent-orchestrator/runtime-capability-evidence');
const { execute } = require('./external-runtime-transport');
const { captureInvocation } = require('./lib/runtime-transcript-spool');
const adapter = require('./lib/transcript-source-adapters').sourceAdapter('harness-events-jsonl-v1');
const orchestrator = require('./agent-orchestrator');

function fixture(root, baseUrl = 'http://127.0.0.1:5190') {
  const workdir = path.join(root, 'work'); const authority = path.join(root, 'authority');
  const spoolRoot = path.join(authority, 'spool');
  for (const dir of [workdir, authority, spoolRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canary = { version: 'native-runtime-canary-v1', status: 'passed', workspaceEffects: 0,
    externalEffects: 0, identityMismatch: 0, endpointHash: configApi.sha256(baseUrl), modelHash: configApi.sha256('test-model'),
    finishedAt: new Date().toISOString(), cases: require('./agent-orchestrator/native-runtime-canary').CASES.map(id => ({ id, status: 'passed' })) };
  canary.receiptHash = stableHash(canary);
  const promotion = governance.promotionDecision({ descriptorId: 'openai-compatible-chat-v1', registered: true,
    observedCapability: true, explicitPromotion: true, canary, environmentKeys: [] });
  const config = { version: 'external-runtime-config-v1', descriptorId: promotion.descriptorId, baseUrl,
    model: 'test-model', canaryFile: path.join(authority, 'canary.json'), promotionFile: path.join(authority, 'promotion.json'), spoolRoot };
  const configFile = path.join(authority, 'config.json');
  for (const [file, value] of [[config.canaryFile, canary], [config.promotionFile, promotion], [configFile, config]]) fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { workdir, authority, spoolRoot, config, configFile, canary, promotion,
    options: { workdir, 'external-stages': 'spec,review', 'external-runtime-config': configFile, 'capability-router': 'enforce' } };
}

async function main() {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.runtime-wiring-test-'));
  let server;
  try {
    const providerWrapper = fs.readFileSync(path.join(__dirname, 'codex-task-provider.sh'), 'utf8');
    const providerEntrypoint = fs.readFileSync(path.join(__dirname, 'codex-task-bwrap-entrypoint.sh'), 'utf8');
    assert.match(providerWrapper, /--unshare-all --unshare-user --uid 0 --gid 0/);
    assert.match(providerWrapper, /--cap-drop ALL --cap-add CAP_NET_ADMIN --cap-add CAP_SETPCAP/);
    assert.doesNotMatch(providerWrapper, /--share-net/);
    assert.match(providerEntrypoint, /ip link set lo up/);
    assert.match(providerEntrypoint, /TCP-LISTEN:8080,bind=127\.0\.0\.1,reuseaddr,fork/);
    assert.match(providerEntrypoint, /CapEff:\[\[:space:\]\]\*0\+/);
    for (const deployScript of ['install-production-linux.sh', 'complete-production-linux.sh']) {
      const deployment = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'harness-web', deployScript), 'utf8');
      assert.match(deployment, /tech-persistence-harness-transcripts\.service/);
      assert.match(deployment, /tech-persistence-harness-transcripts\.timer/);
      assert.match(deployment, /task-runtime\/transcript-spool/);
      assert.match(deployment, /sync-runtime-transcripts\.js --outbox/);
      assert.match(deployment, /systemctl enable --now[^\n]*tech-persistence-harness-transcripts\.timer/);
    }
    const writerQualification = fs.readFileSync(path.join(__dirname, 'qualify-codex-writer-linux.sh'), 'utf8');
    const capabilityEvidenceGenerator = fs.readFileSync(path.join(__dirname, 'create-runtime-capability-evidence-linux.js'), 'utf8');
    const orchestratorSource = fs.readFileSync(path.join(__dirname, 'agent-orchestrator.js'), 'utf8');
    assert.match(writerQualification, /sha256sum \"\$workspace\/qualification\.txt\"/);
    assert.match(capabilityEvidenceGenerator, /HARNESS_NATIVE_WRITER_OK\\n/);
    assert.match(capabilityEvidenceGenerator, /chownSync\(temporary, 0, fs\.statSync\(path\.dirname\(output\)\)\.gid\)/);
    assert.match(orchestratorSource, /Do not wrap the response in a handoff, result, data, or markdown object/);
    assert.match(orchestratorSource, /Every validation entry is a string/);
    assert.doesNotMatch(orchestratorSource, /handoff\.clarifications\[\]/);
    assert.match(orchestratorSource, /union of all task criterionIds equals the complete set/);
    assert.match(orchestratorSource, /without a command: prefix/);
    assert.match(orchestratorSource, /artifact exists, is fresh, and matches its sealed digest/);
    assert.match(writerQualification, /assertStructuredOutput/);
    assert.match(writerQualification, /with no prose or Markdown/);
    assert.match(capabilityEvidenceGenerator, /handoffHash/);
    const requirementSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'agent-loop', 'requirement-spec.schema.json'), 'utf8'));
    const taskSchema = requirementSchema.properties.taskBreakdown.items;
    assert.ok(taskSchema.required.includes('criterionIds'));
    assert.equal(taskSchema.properties.criterionIds.minItems, 1);
    const semanticSpec = {
      requirementSpec: { acceptanceCriteria: ['exact criterion'] },
      acceptanceContract: { criteria: [{ id: 'ac-exact', statement: 'exact criterion', sourceRefs: ['spec.json#/requirementSpec/acceptanceCriteria/0'] }] },
      technicalDesign: {},
      taskBreakdown: [{ id: 'task-1', criterionIds: ['ac-exact'] }],
    };
    assert.deepStrictEqual(orchestrator.validateSpec(semanticSpec), []);
    assert.match(orchestrator.validateSpec({
      ...semanticSpec,
      acceptanceContract: { criteria: [{ ...semanticSpec.acceptanceContract.criteria[0], statement: 'rewritten criterion' }] },
    }).join('; '), /byte-identical/);
    const commandSpec = {
      ...semanticSpec,
      acceptanceContract: { criteria: [{ ...semanticSpec.acceptanceContract.criteria[0], oracle: { type: 'command', procedure: 'git status --porcelain', expected: 'exit code is zero' } }] },
    };
    assert.match(orchestrator.validateSpec(commandSpec, { 'validation-command': 'node test.js' }).join('; '), /unavailable validation command/);
    const f = fixture(root);
    const codexCommand = path.join(f.authority, 'codex-command.js');
    fs.writeFileSync(codexCommand, 'fixed-command\n', { mode: 0o700 });
    const evidenceCore = { schemaVersion: 'runtime-capability-evidence-v1',
      binding: { commandPath: codexCommand, commandHash: capabilityEvidence.sha256File(codexCommand) },
      providers: { implementation: { source: 'authority-native-writer-probe', observedAt: new Date().toISOString(),
        evidenceHash: `sha256:${'a'.repeat(64)}`, runtimeObserved: Object.fromEntries(capabilityEvidence.CAPABILITIES.map(name => [name, true])) } } };
    const evidenceFile = path.join(f.authority, 'runtime-capability-evidence.json');
    fs.writeFileSync(evidenceFile, JSON.stringify({ ...evidenceCore, receiptHash: stableHash(evidenceCore) }), { mode: 0o440 });
    assert.equal(capabilityEvidence.load(evidenceFile, codexCommand).implementation.runtimeObserved['workspace-write'], true);
    assert.throws(() => capabilityEvidence.load(evidenceFile, path.join(f.authority, 'wrong-command')), /Codex command/);
    const loadedCapabilityEvidence = capabilityEvidence.load(evidenceFile, codexCommand);
    assert.equal(orchestrator.providerCapabilityEvidence({ runtimeCapabilityEvidence: loadedCapabilityEvidence },
      { providerKey: 'implementation' }).runtimeObserved['repo-read'], true);
    assert.equal(profiles.profile(f.options, 'spec').runtime, 'openai-compatible');
    assert.equal(profiles.profileId(f.options, 'spec'), 'external-readonly-spec-v1');
    assert.equal(profiles.profile(f.options, 'implementation').runtime, 'codex');
    assert.throws(() => configApi.stages({ 'external-stages': 'implementation' }), /never implementation/);
    assert.throws(() => configApi.stages({ 'external-stages': 'spec,spec' }), /only/);
    for (const url of ['http://localhost:1', 'https://example.com', 'http://127.0.0.1/path', 'http://x:y@127.0.0.1']) assert.throws(() => configApi.validateEndpoint(url));
    assert.throws(() => configApi.loadExternalConfig(f.configFile, root), /outside/);
    const loaded = configApi.loadExternalConfig(f.configFile, f.workdir);
    assert.equal(loaded.promotion.route, 'read-only');
    const schemaPath = path.join(f.authority, 'spec.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify({ type: 'object' }), { mode: 0o600 });
    const specInvocation = invocation.buildInvocation(f.options, 'spec', f.authority, 'explicit requirement', schemaPath, f.workdir);
    assert.match(JSON.parse(specInvocation.stdin).prompt, /Every taskBreakdown item MUST have a non-empty criterionIds array/);
    assert.match(JSON.parse(specInvocation.stdin).prompt, /criterion\.statement MUST be byte-for-byte identical/);
    assert.throws(() => configApi.configured({ ...f.options, externalConfigHash: 'bad' }), /drift/);
    const stage = native.buildStageControl({ options: f.options, runId: 'test', stage: 'spec', providerKey: 'spec', intent: 'read-only' });
    assert.equal(stage.route.primary.runtime, 'openai-compatible');
    assert.equal(stage.route.writer, null);
    assert.throws(() => native.buildStageControl({ options: f.options, providerKey: 'spec', intent: 'write' }), /writer/);
    assert.deepEqual(native.resolveExecutionPolicyOptions({ workdir: f.workdir }, native.executionPolicy(f.options))['external-stages'], 'spec,review');
    const incomplete = { ...f.promotion, checks: {} }; delete incomplete.receiptHash; incomplete.receiptHash = stableHash(incomplete);
    assert.throws(() => native.resolveExternalRuntime(incomplete), /invalid/);
    const source = captureInvocation(f.spoolRoot, { sessionId: 'a'.repeat(64), requestId: 'one', taskHash: stage.task.hash,
      routeHash: stage.route.decisionHash, modelHash: configApi.sha256('test-model'), requestBytes: 'secret-request', responseBytes: 'secret-response',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), succeeded: true });
    assert.ok(source.jobHash);
    const file = path.join(f.spoolRoot, 'sources', `${'a'.repeat(64)}.jsonl`);
    const events = []; const first = await adapter.stream(file, { onEvents: batch => events.push(...batch) });
    assert.equal(first.eventCount, 2); assert.deepEqual(events.map(e => e.outerType), ['request', 'response']);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
    captureInvocation(f.spoolRoot, { sessionId: 'a'.repeat(64), requestId: 'two', taskHash: stage.task.hash, routeHash: stage.route.decisionHash,
      modelHash: configApi.sha256('test-model'), requestBytes: 'a', responseBytes: 'b', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), succeeded: false });
    const second = await adapter.stream(file, { startLine: first.nextLineNo });
    assert.equal(second.fileIdentityHash, first.fileIdentityHash); assert.equal(second.eventCount, 4); assert.equal(second.emittedEventCount, 2);
    assert.equal(second.checkpoint.eventChainSha256, first.eventChainSha256);
    await assert.rejects(adapter.stream(file, { startLine: 0 }), /startLine/);
    const invalid = path.join(f.spoolRoot, 'invalid.jsonl');
    fs.writeFileSync(invalid, JSON.stringify({ ...events[0].eventJson, status: 'failed' }) + '\n');
    await assert.rejects(adapter.stream(invalid), /invalid/);
    const response = { id: 'chat-1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }] };
    let mode = 'ok'; let captured;
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk; captured = JSON.parse(body);
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.com' }); res.end(); return; }
      if (mode === 'bad-json') { res.end('private token invalid json'); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const input = { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test-model', prompt: 'hello', schema: { type: 'object' },
      sessionId: 'b'.repeat(64), requestId: 'test', maxTokens: 16, timeoutMs: 1000 };
    const result = await execute(input); assert.equal(result.payload.ok, true); assert.equal(captured.stream, false);
    assert.equal(invocation.runtimeRefs(result).externalSession, input.sessionId);
    response.choices[0].finish_reason = 'length'; await assert.rejects(execute(input), /completed/);
    response.choices[0].finish_reason = 'stop'; response.choices[0].message.tool_calls = [{}]; await assert.rejects(execute(input), /completed/);
    delete response.choices[0].message.tool_calls;
    mode = 'bad-json'; await assert.rejects(execute(input), error => !error.message.includes('private token'));
    mode = 'redirect'; await assert.rejects(execute(input));
    console.log('Harness runtime wiring: 30+ safety and transport checks passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture };

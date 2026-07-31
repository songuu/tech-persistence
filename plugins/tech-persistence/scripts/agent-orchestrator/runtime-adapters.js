'use strict';

function managedRunEnv(runtime, overrides = {}) {
  return {
    TECH_PERSISTENCE_MANAGED_RUN: '1',
    TECH_PERSISTENCE_RUNTIME: runtime,
    TECH_PERSISTENCE_MEMORY_WRITE_OWNER: 'control',
    ...overrides,
  };
}

function normalizeLaunch(launch, label) {
  if (!launch || typeof launch !== 'object' || !launch.command) {
    throw new Error(`${label} launch.command is required`);
  }
  return launch;
}

function toArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function buildClaudeInvocation(options = {}) {
  const launch = normalizeLaunch(options.launch, 'Claude');
  const mode = options.mode || 'print';
  if (!['print', 'bare'].includes(mode)) {
    throw new Error(`Unsupported Claude adapter mode: ${mode}`);
  }
  if (!options.cwd) throw new Error('Claude invocation cwd is required');

  const args = [];
  if (mode === 'bare') args.push('--bare');
  args.push(
    '-p',
    '--input-format', 'text',
    '--output-format', options.includeHookEvents ? 'stream-json' : 'json'
  );
  if (options.schemaJson) args.push('--json-schema', options.schemaJson);
  for (const pluginDir of toArray(options.pluginDir)) {
    args.push('--plugin-dir', String(pluginDir));
  }
  if (options.settings) args.push('--settings', String(options.settings));
  if (options.sessionId) args.push('--resume', String(options.sessionId));
  if (options.forkSession) args.push('--fork-session');
  if (options.includeHookEvents) {
    args.push('--include-hook-events');
  }

  return {
    runtime: 'claude',
    adapter: mode === 'bare' ? 'claude-bare' : 'claude-print',
    launch,
    args,
    cwd: options.cwd,
    stdin: options.prompt || '',
    env: managedRunEnv('claude', options.env),
    schemaPath: options.schemaPath || null,
  };
}

function buildCodexInvocation(options = {}) {
  const launch = normalizeLaunch(options.launch, 'Codex');
  const mode = options.mode || 'exec';
  if (!['exec', 'app-server'].includes(mode)) {
    throw new Error(`Unsupported Codex adapter mode: ${mode}`);
  }
  if (!options.cwd) throw new Error('Codex invocation cwd is required');

  if (mode === 'app-server') {
    if (!options.allowExperimental) {
      throw new Error('Codex App Server requires explicit opt-in while the CLI surface is experimental');
    }
    return {
      runtime: 'codex',
      adapter: 'codex-app-server',
      protocol: 'stdio-jsonrpc-v2',
      launch,
      args: ['app-server', '--stdio'],
      cwd: options.cwd,
      stdin: null,
      env: managedRunEnv('codex', options.env),
      schemaPath: options.schemaPath || null,
    };
  }

  const args = ['exec', '-C', options.cwd, '--json'];
  if (options.lastMessageFile) {
    args.push('--output-last-message', options.lastMessageFile);
  }
  if (options.sandbox) args.push('--sandbox', options.sandbox);
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.schemaPath) args.push('--output-schema', options.schemaPath);
  if (options.resumeThreadId) {
    args.push('resume', String(options.resumeThreadId));
  }
  args.push('-');

  return {
    runtime: 'codex',
    adapter: 'codex-exec',
    launch,
    args,
    cwd: options.cwd,
    stdin: options.prompt || '',
    env: managedRunEnv('codex', options.env),
    schemaPath: options.schemaPath || null,
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parsePayload(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

function parseOpaqueEvents(value) {
  if (!value) return [];
  if (typeof value === 'object') return [value];
  const text = String(value).trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch (_) {
    return parseJsonLines(text).filter((entry) => entry.type !== 'unparsed');
  }
}

function extractRecoveryRuntimeRefs(runtime, input = {}) {
  const normalized = input && typeof input === 'object' ? input : { stdout: input };
  const direct = (normalized.runtimeOutput && normalized.runtimeOutput.runtimeRefs)
    || (normalized.runtimeResult && normalized.runtimeResult.runtimeRefs)
    || normalized.runtimeRefs
    || {};
  const rawValues = [
    normalized.raw,
    normalized.stdout,
    normalized.stderr,
    normalized.lastMessage,
    normalized.result && normalized.result.stdout,
    normalized.result && normalized.result.stderr,
  ];
  const events = rawValues.flatMap(parseOpaqueEvents);
  if (runtime === 'claude') {
    const sessionId = direct.sessionId
      || direct.claudeSession
      || events.map((entry) => (
        entry && (entry.session_id || entry.sessionId)
      ))
        .find(Boolean)
      || null;
    return sessionId ? { sessionId: String(sessionId) } : {};
  }
  if (runtime === 'codex') {
    const threadId = direct.threadId
      || direct.codexThread
      || events.filter((entry) => isCodexThreadLifecycleEvent(eventName(entry)))
        .map((entry) => readRef(entry, 'thread_id', 'threadId', 'thread'))
        .find(Boolean)
      || null;
    const turnId = direct.turnId
      || direct.codexTurn
      || events.filter((entry) => isCodexTurnLifecycleEvent(eventName(entry)))
        .map((entry) => readRef(entry, 'turn_id', 'turnId', 'turn'))
        .find(Boolean)
      || null;
    return {
      ...(threadId ? { threadId: String(threadId) } : {}),
      ...(turnId ? { turnId: String(turnId) } : {}),
    };
  }
  return {};
}

function normalizeClaudeOutput(input) {
  const normalizedInput = input && typeof input === 'object'
    ? input
    : { stdout: input };
  const adapter = normalizedInput.adapter || 'claude-print';
  let envelope;
  try {
    envelope = parseJson(normalizedInput.stdout, 'Claude result');
  } catch (error) {
    error.runtimeResult = {
      runtime: 'claude',
      adapter,
      status: 'failed',
      accepted: false,
      nativeAccepted: false,
      terminalEvidence: { observed: false, event: null, status: null },
      nativeAcceptanceErrors: ['claude result envelope is invalid JSON'],
      runtimeRefs: extractRecoveryRuntimeRefs('claude', normalizedInput),
      raw: normalizedInput.stdout,
    };
    throw error;
  }
  const sessionId = envelope.session_id || envelope.sessionId || null;
  const terminalObserved = envelope.type === 'result';
  const terminalStatus = terminalObserved
    ? String(envelope.subtype || '').toLowerCase()
    : null;
  const nativeAcceptanceErrors = [];
  if (!terminalObserved) {
    nativeAcceptanceErrors.push('claude terminal result event is missing');
  } else if (terminalStatus !== 'success') {
    nativeAcceptanceErrors.push('claude terminal result status is not success');
  }
  if (!sessionId) nativeAcceptanceErrors.push('claude session ref is missing');
  const nativeAccepted = nativeAcceptanceErrors.length === 0;
  const terminalEvidence = {
    observed: terminalObserved,
    event: terminalObserved ? 'result' : null,
    status: terminalStatus,
  };
  if (envelope.is_error === true || /error|failed/i.test(String(envelope.subtype || ''))) {
    const message = typeof envelope.result === 'string'
      ? envelope.result
      : (envelope.error && (envelope.error.message || envelope.error)) || 'Claude provider failed';
    const error = new Error(String(message));
    error.runtimeResult = {
      runtime: 'claude',
      adapter,
      status: 'failed',
      accepted: nativeAccepted,
      nativeAccepted,
      terminalEvidence,
      nativeAcceptanceErrors,
      runtimeRefs: {
        sessionId,
      },
      raw: envelope,
    };
    throw error;
  }
  const payload = envelope.structured_output !== undefined
    ? envelope.structured_output
    : parsePayload(envelope.result);
  return {
    runtime: 'claude',
    adapter,
    status: 'succeeded',
    accepted: nativeAccepted,
    nativeAccepted,
    terminalEvidence,
    nativeAcceptanceErrors,
    payload,
    runtimeRefs: {
      sessionId,
    },
    usage: envelope.usage || null,
    cost: envelope.total_cost_usd ?? null,
    raw: envelope,
  };
}

function readRef(event, snakeKey, camelKey, nestedKey) {
  if (!event || typeof event !== 'object') return null;
  if (event[snakeKey]) return String(event[snakeKey]);
  if (event[camelKey]) return String(event[camelKey]);
  if (event[nestedKey] && event[nestedKey].id) return String(event[nestedKey].id);
  const params = event.params;
  if (params && typeof params === 'object') {
    if (params[snakeKey]) return String(params[snakeKey]);
    if (params[camelKey]) return String(params[camelKey]);
    if (params[nestedKey] && params[nestedKey].id) return String(params[nestedKey].id);
  }
  return null;
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      events.push({ type: 'unparsed', text: line });
    }
  }
  return events;
}

function eventName(event) {
  return String(event && (event.type || event.method || event.event) || '');
}

function isCodexTerminalEvent(name) {
  return ['turn.completed', 'turn/completed', 'turn_completed']
    .includes(String(name || '').toLowerCase());
}

function isCodexThreadLifecycleEvent(name) {
  return [
    'thread.started', 'thread/started', 'thread_started',
    'thread.resumed', 'thread/resumed', 'thread_resumed',
    'thread.created', 'thread/created', 'thread_created',
  ].includes(String(name || '').toLowerCase());
}

function isCodexTurnLifecycleEvent(name) {
  return [
    'turn.started', 'turn/started', 'turn_started',
    'turn.completed', 'turn/completed', 'turn_completed',
    'turn.failed', 'turn/failed', 'turn_failed',
  ].includes(String(name || '').toLowerCase());
}

function normalizeCodexOutput(input = {}) {
  const events = parseJsonLines(input.stdout);
  let threadId = null;
  let turnId = null;
  let usage = null;
  let failed = false;
  let terminalEvent = null;
  for (const event of events) {
    const name = eventName(event);
    if (isCodexThreadLifecycleEvent(name)) {
      threadId = threadId || readRef(event, 'thread_id', 'threadId', 'thread');
    }
    if (isCodexTurnLifecycleEvent(name)) {
      turnId = turnId || readRef(event, 'turn_id', 'turnId', 'turn');
    }
    if (event.usage) usage = event.usage;
    if (event.params && event.params.usage) usage = event.params.usage;
    if (/error|failed/i.test(name)) failed = true;
    if (!terminalEvent && isCodexTerminalEvent(name)) terminalEvent = name;
  }
  const nativeAcceptanceErrors = [];
  if (!terminalEvent) {
    nativeAcceptanceErrors.push('codex terminal turn event is missing');
  }
  if (!threadId) nativeAcceptanceErrors.push('codex thread ref is missing');
  if (failed) nativeAcceptanceErrors.push('codex runtime reported failure');
  const nativeAccepted = nativeAcceptanceErrors.length === 0;
  const normalizedResult = {
    runtime: 'codex',
    adapter: input.adapter || 'codex-exec',
    status: failed ? 'failed' : 'succeeded',
    accepted: nativeAccepted,
    nativeAccepted,
    terminalEvidence: {
      observed: Boolean(terminalEvent),
      event: terminalEvent,
      status: terminalEvent ? 'completed' : null,
    },
    nativeAcceptanceErrors,
    runtimeRefs: { threadId, turnId },
    usage,
    events,
  };
  try {
    normalizedResult.payload = input.lastMessage && String(input.lastMessage).trim()
      ? parseJson(input.lastMessage, 'Codex last message')
      : null;
  } catch (error) {
    error.runtimeResult = normalizedResult;
    throw error;
  }
  return normalizedResult;
}

function canSafelyFallback(result = {}) {
  if (result.accepted) return false;
  const effects = result.effects || {};
  const changedFiles = Array.isArray(effects.changedFiles) ? effects.changedFiles : [];
  const externalEffects = Array.isArray(effects.externalEffects) ? effects.externalEffects : [];
  return changedFiles.length === 0 && externalEffects.length === 0;
}

module.exports = {
  managedRunEnv,
  buildClaudeInvocation,
  buildCodexInvocation,
  normalizeClaudeOutput,
  normalizeCodexOutput,
  extractRecoveryRuntimeRefs,
  parseJsonLines,
  canSafelyFallback,
};

'use strict';

const {
  assertExactKeys,
  canonicalStringify,
  hashObject,
  normalizeTimestamp,
  validateHash,
  validateIdentifier,
} = require('./self-learning-canonical');
const {
  ASSURANCES,
  BEHAVIOR_EVENT_SCHEMA_VERSION,
  EVENT_STATUSES,
  EVENT_TYPES,
  FINAL_DISPOSITIONS,
  SIGNAL_STRENGTHS,
  SOURCES,
  journalActorForEvent,
  normalizeBehaviorEvent,
} = require('./behavior-events');

const BEHAVIOR_EPISODE_SCHEMA_VERSION = 'self-learning-behavior-episode-v1';
const VERIFICATION_STATUSES = new Set(['verified', 'failed', 'not_run', 'unknown']);
const COMPLETENESS_VALUES = new Set(['complete', 'incomplete', 'unassigned']);
const EPISODE_STATUSES = new Set(['open', 'closed', 'needs_review']);

const EPISODE_KEYS = Object.freeze([
  'schema_version', 'episode_id', 'revision', 'project_id', 'session_id',
  'task_ref', 'event_refs', 'event_set_hash', 'goals', 'actions', 'results',
  'explicit_feedback', 'weak_signals', 'counterexamples', 'evidence_refs',
  'final_disposition', 'verification_status', 'completeness', 'status', 'created_at',
]);
const EVENT_REF_KEYS = Object.freeze([
  'event_id', 'event_hash', 'event_type', 'signal_strength', 'source',
  'source_assurance', 'status', 'final_disposition', 'evidence_refs',
  'occurred_at', 'counterexample', 'retry', 'invalid_call', 'verification_status',
]);
const CATEGORY_REF_KEYS = Object.freeze(['event_id', 'event_hash', 'event_type']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeRequiredText(value, label, maximum = 2048) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function normalizeRevision(value) {
  if (!Number.isInteger(value) || value < 1) throw new Error('revision must be an integer >= 1');
  return value;
}

function normalizeBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function normalizeEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is unsupported: ${String(value)}`);
  return value;
}

function normalizeStringIds(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = value.map((item) => validateIdentifier(item, `${label} item`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not contain duplicates`);
  return ids;
}

function eventRefFromEvent(event) {
  return {
    event_id: event.event_id,
    event_hash: hashObject(event),
    event_type: event.event_type,
    signal_strength: event.signal_strength,
    source: event.source,
    source_assurance: event.source_assurance,
    status: event.status,
    final_disposition: event.final_disposition,
    evidence_refs: [...event.evidence_refs],
    occurred_at: event.occurred_at,
    counterexample: event.details.counterexample === true
      || event.event_type === 'user.correction'
      || event.final_disposition === 'reverted',
    retry: event.details.retry === true,
    invalid_call: event.details.invalid_call === true,
    verification_status: ['verified', 'failed', 'not_run', 'unknown'].includes(event.details.verification_status)
      ? event.details.verification_status
      : 'unknown',
  };
}

function normalizeEventRef(value) {
  assertExactKeys(value, EVENT_REF_KEYS, 'episode event_ref');
  const ref = {
    event_id: validateIdentifier(value.event_id, 'event_ref.event_id'),
    event_hash: validateHash(value.event_hash, 'event_ref.event_hash'),
    event_type: normalizeEnum(value.event_type, EVENT_TYPES, 'event_ref.event_type'),
    signal_strength: normalizeEnum(
      value.signal_strength,
      SIGNAL_STRENGTHS,
      'event_ref.signal_strength'
    ),
    source: normalizeEnum(value.source, SOURCES, 'event_ref.source'),
    source_assurance: normalizeEnum(
      value.source_assurance,
      ASSURANCES,
      'event_ref.source_assurance'
    ),
    status: normalizeEnum(value.status, EVENT_STATUSES, 'event_ref.status'),
    final_disposition: normalizeEnum(
      value.final_disposition,
      FINAL_DISPOSITIONS,
      'event_ref.final_disposition'
    ),
    evidence_refs: normalizeStringIds(value.evidence_refs, 'event_ref.evidence_refs').sort(),
    occurred_at: normalizeTimestamp(value.occurred_at, 'event_ref.occurred_at'),
    counterexample: normalizeBoolean(value.counterexample, 'event_ref.counterexample'),
    retry: normalizeBoolean(value.retry, 'event_ref.retry'),
    invalid_call: normalizeBoolean(value.invalid_call, 'event_ref.invalid_call'),
    verification_status: normalizeRequiredText(
      value.verification_status,
      'event_ref.verification_status',
      32
    ),
  };
  if (!VERIFICATION_STATUSES.has(ref.verification_status)) {
    throw new Error(`event_ref.verification_status is unsupported: ${ref.verification_status}`);
  }
  return ref;
}

function categoryRef(ref) {
  return { event_id: ref.event_id, event_hash: ref.event_hash, event_type: ref.event_type };
}

function normalizeCategoryRefs(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => {
    assertExactKeys(item, CATEGORY_REF_KEYS, `${label} item`);
    return {
      event_id: validateIdentifier(item.event_id, `${label}.event_id`),
      event_hash: validateHash(item.event_hash, `${label}.event_hash`),
      event_type: normalizeRequiredText(item.event_type, `${label}.event_type`, 64),
    };
  });
}

function compareEventRefs(left, right) {
  return left.occurred_at.localeCompare(right.occurred_at)
    || left.event_id.localeCompare(right.event_id);
}

function dedupeAndSortEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('BehaviorEpisode requires at least one BehaviorEvent');
  }
  const byId = new Map();
  events.forEach((input) => {
    const event = input && input.schema_version === BEHAVIOR_EVENT_SCHEMA_VERSION
      ? normalizeBehaviorEvent(input)
      : input;
    if (!event || event.schema_version !== BEHAVIOR_EVENT_SCHEMA_VERSION) {
      throw new Error('BehaviorEpisode input contains an invalid BehaviorEvent');
    }
    const eventHash = hashObject(event);
    const prior = byId.get(event.event_id);
    if (prior && prior.hash !== eventHash) {
      throw new Error(`conflicting BehaviorEvent identity: ${event.event_id}`);
    }
    byId.set(event.event_id, { event, hash: eventHash });
  });
  return [...byId.values()].map((entry) => entry.event)
    .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)
      || left.event_id.localeCompare(right.event_id));
}

function assertSameIdentity(events) {
  const first = events[0];
  events.forEach((event) => {
    if (event.project_id !== first.project_id) throw new Error('Episode project identity mismatch');
    if (event.session_id !== first.session_id) throw new Error('Episode session identity mismatch');
    if (event.task_ref !== first.task_ref) throw new Error('Episode task identity mismatch');
  });
  return { project_id: first.project_id, session_id: first.session_id, task_ref: first.task_ref };
}

function episodeIdentity(projectId, sessionId, taskRef) {
  const hex = hashObject({
    schema_version: BEHAVIOR_EPISODE_SCHEMA_VERSION,
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
  }).slice('sha256:'.length);
  return `behavior-episode:${hex}`;
}

function deriveCollections(refs) {
  const goals = refs.filter((ref) => ref.event_type === 'user.prompt').map(categoryRef);
  const actions = refs.filter((ref) => ref.event_type === 'tool.request').map(categoryRef);
  const results = refs.filter((ref) => ['tool.result', 'task.result'].includes(ref.event_type)).map(categoryRef);
  const explicitFeedback = refs
    .filter((ref) => ['user.feedback', 'user.correction', 'user.approval'].includes(ref.event_type)
      && ref.signal_strength === 'explicit')
    .map((ref) => ref.event_id);
  const weakSignals = refs
    .filter((ref) => ref.signal_strength === 'weak' || ref.signal_strength === 'inferred')
    .map((ref) => ref.event_id);
  const counterexamples = refs.filter((ref) => ref.counterexample).map((ref) => ref.event_id);
  const evidenceRefs = [...new Set(refs.flatMap((ref) => ref.evidence_refs))].sort();
  return { goals, actions, results, explicitFeedback, weakSignals, counterexamples, evidenceRefs };
}

function finalRef(refs) {
  const candidates = refs.filter((ref) => (
    ref.event_type === 'task.result'
      || ['user.feedback', 'user.correction', 'user.approval'].includes(ref.event_type)
  ) && ref.final_disposition !== 'unknown');
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function deriveVerification(refs) {
  const taskResults = refs.filter((ref) => ref.event_type === 'task.result');
  if (taskResults.length === 0) return 'unknown';
  const result = taskResults[taskResults.length - 1];
  if (result.verification_status !== 'unknown') return result.verification_status;
  if (result.status === 'failed' || result.status === 'blocked'
      || result.final_disposition === 'rejected' || result.final_disposition === 'reverted') {
    return 'failed';
  }
  if (result.source_assurance === 'verified'
      && result.status === 'succeeded'
      && result.evidence_refs.length > 0) {
    return 'verified';
  }
  return 'unknown';
}

function deriveCompleteness(taskRef, collections, finalDisposition, verificationStatus) {
  if (taskRef === null) return 'unassigned';
  const hasTaskResult = collections.results.some((ref) => ref.event_type === 'task.result');
  return collections.goals.length > 0
    && collections.actions.length > 0
    && hasTaskResult
    && finalDisposition !== 'unknown'
    && ['verified', 'failed'].includes(verificationStatus)
    ? 'complete'
    : 'incomplete';
}

function deriveStatus(completeness, counterexamples) {
  if (completeness === 'complete' && counterexamples.length === 0) return 'closed';
  return 'needs_review';
}

function assembleEpisode({ projectId, sessionId, taskRef, refs, revision, createdAt }) {
  if (createdAt < refs[refs.length - 1].occurred_at) {
    throw new Error('created_at must not precede the latest BehaviorEvent');
  }
  const collections = deriveCollections(refs);
  const terminal = finalRef(refs);
  const finalDisposition = terminal ? terminal.final_disposition : 'unknown';
  const verificationStatus = deriveVerification(refs);
  const completeness = deriveCompleteness(taskRef, collections, finalDisposition, verificationStatus);
  const status = deriveStatus(completeness, collections.counterexamples);
  return {
    schema_version: BEHAVIOR_EPISODE_SCHEMA_VERSION,
    episode_id: episodeIdentity(projectId, sessionId, taskRef),
    revision,
    project_id: projectId,
    session_id: sessionId,
    task_ref: taskRef,
    event_refs: refs,
    event_set_hash: hashObject(refs),
    goals: collections.goals,
    actions: collections.actions,
    results: collections.results,
    explicit_feedback: collections.explicitFeedback,
    weak_signals: collections.weakSignals,
    counterexamples: collections.counterexamples,
    evidence_refs: collections.evidenceRefs,
    final_disposition: finalDisposition,
    verification_status: verificationStatus,
    completeness,
    status,
    created_at: createdAt,
  };
}

function buildBehaviorEpisode(events, options = {}) {
  const normalizedEvents = dedupeAndSortEvents(events);
  const identity = assertSameIdentity(normalizedEvents);
  const refs = normalizedEvents.map(eventRefFromEvent).sort(compareEventRefs);
  const revision = normalizeRevision(options.revision === undefined ? 1 : options.revision);
  const createdAt = normalizeTimestamp(
    options.created_at || refs[refs.length - 1].occurred_at,
    'created_at'
  );
  return assembleEpisode({
    projectId: identity.project_id,
    sessionId: identity.session_id,
    taskRef: identity.task_ref,
    refs,
    revision,
    createdAt,
  });
}

function normalizeBehaviorEpisode(input) {
  assertExactKeys(input, EPISODE_KEYS, 'BehaviorEpisode');
  if (input.schema_version !== BEHAVIOR_EPISODE_SCHEMA_VERSION) {
    throw new Error(`unsupported BehaviorEpisode schema_version: ${input.schema_version}`);
  }
  const projectId = normalizeRequiredText(input.project_id, 'project_id', 256);
  const sessionId = normalizeRequiredText(input.session_id, 'session_id', 256);
  const taskRef = input.task_ref === null ? null : normalizeRequiredText(input.task_ref, 'task_ref', 256);
  const refs = input.event_refs.map(normalizeEventRef).sort(compareEventRefs);
  if (refs.length === 0) throw new Error('BehaviorEpisode event_refs must not be empty');
  const expected = assembleEpisode({
    projectId,
    sessionId,
    taskRef,
    refs,
    revision: normalizeRevision(input.revision),
    createdAt: normalizeTimestamp(input.created_at, 'created_at'),
  });
  if (input.episode_id !== expected.episode_id) throw new Error('episode_id does not match episode identity');
  if (input.event_set_hash !== expected.event_set_hash) throw new Error('event_set_hash does not match event_refs');
  normalizeCategoryRefs(input.goals, 'goals');
  normalizeCategoryRefs(input.actions, 'actions');
  normalizeCategoryRefs(input.results, 'results');
  normalizeStringIds(input.explicit_feedback, 'explicit_feedback');
  normalizeStringIds(input.weak_signals, 'weak_signals');
  normalizeStringIds(input.counterexamples, 'counterexamples');
  normalizeStringIds(input.evidence_refs, 'evidence_refs');
  if (!FINAL_DISPOSITIONS.has(input.final_disposition)) throw new Error('invalid final_disposition');
  if (!VERIFICATION_STATUSES.has(input.verification_status)) throw new Error('invalid verification_status');
  if (!COMPLETENESS_VALUES.has(input.completeness)) throw new Error('invalid completeness');
  if (!EPISODE_STATUSES.has(input.status)) throw new Error('invalid status');
  if (canonicalStringify(input) !== canonicalStringify(expected)) {
    throw new Error('BehaviorEpisode derived fields do not match event_refs');
  }
  return expected;
}

function verifyBehaviorEpisode(input) {
  const errors = [];
  try { normalizeBehaviorEpisode(input); } catch (error) { errors.push(error.message); }
  return { valid: errors.length === 0, errors };
}

function canonicalEqual(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function latestActiveRecords(journal, recordType, tombstonedIds) {
  const latest = new Map();
  journal.records.forEach((record) => {
    if (record.record_type === recordType && !tombstonedIds.has(record.entity_id)) {
      latest.set(record.entity_id, record);
    }
  });
  return latest;
}

/**
 * Rebuild the effective Episode view from the immutable journal. Episode-derived
 * fields are insufficient authority because a referenced Event can later be
 * tombstoned or its journal identity can be corrupt while the Episode JSON stays valid.
 */
function assessEpisodeJournal(journal, options = {}) {
  if (!journal || !Array.isArray(journal.records)) throw new Error('journal view is invalid');
  const tombstonedIds = new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.entity_id));
  const activeEvents = latestActiveRecords(journal, 'behavior_event', tombstonedIds);
  const activeEpisodes = latestActiveRecords(journal, 'behavior_episode', tombstonedIds);
  const episodes = [...activeEpisodes.values()]
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id))
    .map((record) => {
      const errors = [];
      const invalidatedEventIds = [];
      const authoritativeEvents = [];
      let episode = null;
      try {
        episode = normalizeBehaviorEpisode(record.payload);
      } catch (error) {
        errors.push(`BehaviorEpisode ${record.entity_id} is invalid: ${error.message}`);
      }
      if (episode) {
        if (record.entity_id !== episode.episode_id
            || record.record_id !== `${episode.episode_id}:r${episode.revision}`
            || record.occurred_at !== episode.created_at) {
          errors.push(`BehaviorEpisode ${episode.episode_id} journal identity/timestamp mismatch`);
        }
        if (options.project_id && episode.project_id !== options.project_id) {
          errors.push(`BehaviorEpisode ${episode.episode_id} project identity mismatch`);
        }
        for (const eventRef of episode.event_refs) {
          const eventRecord = activeEvents.get(eventRef.event_id);
          if (!eventRecord || tombstonedIds.has(eventRef.event_id)) {
            errors.push(
              `BehaviorEpisode ${episode.episode_id} references missing or tombstoned event ${eventRef.event_id}`
            );
            invalidatedEventIds.push(eventRef.event_id);
            continue;
          }
          try {
            const event = normalizeBehaviorEvent(eventRecord.payload);
            const valid = eventRecord.record_id === event.event_id
              && eventRecord.entity_id === event.event_id
              && eventRecord.occurred_at === event.occurred_at
              && eventRecord.payload_hash === eventRef.event_hash
              && event.project_id === episode.project_id
              && event.session_id === episode.session_id
              && event.task_ref === episode.task_ref
              && canonicalEqual(eventRefFromEvent(event), eventRef)
              && canonicalEqual(eventRecord.actor, journalActorForEvent(event));
            if (!valid) {
              errors.push(
                `BehaviorEpisode ${episode.episode_id} event identity/hash/actor/scope mismatch for ${eventRef.event_id}`
              );
              invalidatedEventIds.push(eventRef.event_id);
              continue;
            }
            authoritativeEvents.push({ event, record: eventRecord });
          } catch (error) {
            errors.push(`BehaviorEpisode ${episode.episode_id} contains invalid event ${eventRef.event_id}`);
            invalidatedEventIds.push(eventRef.event_id);
          }
        }
      }
      const uniqueErrors = [...new Set(errors)];
      const uniqueInvalidated = [...new Set(invalidatedEventIds)].sort();
      return {
        record,
        episode,
        authoritative_events: authoritativeEvents,
        errors: uniqueErrors,
        invalidated_event_ids: uniqueInvalidated,
        effective_status: uniqueErrors.length > 0 ? 'needs_review' : episode.status,
      };
    });
  return {
    episodes,
    errors: episodes.flatMap((item) => item.errors),
    tombstoned_ids: [...tombstonedIds].sort(),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0
    ? { status: 'unknown', value: null, numerator, denominator }
    : { status: 'measured', value: numerator / denominator, numerator, denominator };
}

function buildBehaviorMetrics(episodes, options = {}) {
  if (!Array.isArray(episodes)) throw new Error('episodes must be an array');
  const excludedEpisodeIds = new Set(Array.isArray(options.quality_excluded_episode_ids)
    ? options.quality_excluded_episode_ids.map((id) => validateIdentifier(id, 'quality excluded episode id'))
    : []);
  const latestByEpisode = new Map();
  episodes.map(normalizeBehaviorEpisode).forEach((episode) => {
    const prior = latestByEpisode.get(episode.episode_id);
    if (!prior || episode.revision > prior.revision) {
      latestByEpisode.set(episode.episode_id, episode);
      return;
    }
    if (episode.revision === prior.revision
        && canonicalStringify(episode) !== canonicalStringify(prior)) {
      throw new Error(`conflicting BehaviorEpisode revision: ${episode.episode_id}:r${episode.revision}`);
    }
  });
  const normalized = [...latestByEpisode.values()]
    .sort((left, right) => left.episode_id.localeCompare(right.episode_id));
  const assigned = normalized.filter((episode) => episode.task_ref !== null);
  const qualityAssigned = assigned.filter((episode) => !excludedEpisodeIds.has(episode.episode_id));
  const refs = normalized.flatMap((episode) => episode.event_refs);
  const qualityRefs = qualityAssigned.flatMap((episode) => episode.event_refs);
  const toolResults = refs.filter((ref) => ref.event_type === 'tool.result');
  const qualityToolResults = qualityRefs.filter((ref) => ref.event_type === 'tool.result');
  const verifiedTasks = qualityAssigned.filter((episode) => episode.verification_status === 'verified').length;
  const correctedTasks = qualityAssigned.filter((episode) => episode.counterexamples.length > 0).length;
  const retriedTasks = qualityAssigned.filter((episode) => episode.event_refs.some((ref) => ref.retry)).length;
  const invalidCalls = qualityToolResults.filter((ref) => ref.invalid_call).length;
  const sourceCoverage = {};
  refs.forEach((ref) => { sourceCoverage[ref.source] = (sourceCoverage[ref.source] || 0) + 1; });
  return {
    schema_version: 'self-learning-behavior-metrics-v1',
    usage: {
      episodes_total: normalized.length,
      assigned_episode_count: assigned.length,
      unassigned_episode_count: normalized.length - assigned.length,
      event_count: refs.length,
      tool_call_count: refs.filter((ref) => ref.event_type === 'tool.request').length,
      tool_result_count: toolResults.length,
    },
    quality: {
      excluded_episode_count: assigned.length - qualityAssigned.length,
      task_verification_rate: ratio(verifiedTasks, qualityAssigned.length),
      correction_rate: ratio(correctedTasks, qualityAssigned.length),
      retry_rate: ratio(retriedTasks, qualityAssigned.length),
      invalid_call_rate: ratio(invalidCalls, qualityToolResults.length),
      unknown_outcome_count: qualityAssigned
        .filter((episode) => episode.final_disposition === 'unknown').length,
    },
    signals: {
      explicit_feedback_count: normalized.reduce((sum, episode) => sum + episode.explicit_feedback.length, 0),
      weak_signal_count: normalized.reduce((sum, episode) => sum + episode.weak_signals.length, 0),
    },
    source_coverage: sourceCoverage,
  };
}

function appendBehaviorEpisode(storeDir, input, options = {}) {
  const { appendRecord } = require('./self-learning-store');
  const episode = input && input.schema_version === BEHAVIOR_EPISODE_SCHEMA_VERSION
    ? normalizeBehaviorEpisode(input)
    : buildBehaviorEpisode(input, options);
  const actor = options.actor || {
    kind: 'system', id: 'behavior-episode-builder', runtime: 'unknown', authority_ref: null,
  };
  const appendOptions = {};
  if (Object.prototype.hasOwnProperty.call(options, 'expected_revision')) {
    appendOptions.expected_revision = options.expected_revision;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expected_head_hash')) {
    appendOptions.expected_head_hash = options.expected_head_hash;
  }
  const result = appendRecord(storeDir, {
    record_type: 'behavior_episode',
    record_id: `${episode.episode_id}:r${episode.revision}`,
    entity_id: episode.episode_id,
    actor,
    occurred_at: episode.created_at,
    payload: episode,
  }, appendOptions);
  return { ...result, episode };
}

function closeBehaviorEpisode(storeDir, input) {
  assertExactKeys(
    input,
    ['project_id', 'session_id', 'task_ref', 'created_at', 'actor'],
    'close BehaviorEpisode input'
  );
  const projectId = normalizeRequiredText(input.project_id, 'project_id', 256);
  const sessionId = normalizeRequiredText(input.session_id, 'session_id', 256);
  const taskRef = input.task_ref === null
    ? null
    : normalizeRequiredText(input.task_ref, 'task_ref', 256);
  const createdAt = normalizeTimestamp(input.created_at, 'created_at');
  assertObject(input.actor, 'actor');

  const { readJournal } = require('./self-learning-store');
  const journal = readJournal(storeDir);
  const tombstonedIds = new Set(journal.records
    .filter((record) => record.record_type === 'tombstone')
    .map((record) => record.payload.target_id));
  const eventRecords = journal.records.filter((record) => (
    record.record_type === 'behavior_event' && !tombstonedIds.has(record.entity_id)
  ));
  const events = eventRecords.map((record) => {
    const event = normalizeBehaviorEvent(record.payload);
    if (record.record_id !== event.event_id || record.entity_id !== event.event_id) {
      throw new Error(`behavior_event journal identity mismatch: ${record.record_id}`);
    }
    return event;
  }).filter((event) => event.project_id === projectId
    && event.session_id === sessionId
    && event.task_ref === taskRef);
  if (events.length === 0) {
    throw new Error('no BehaviorEvent records match the requested episode identity');
  }

  const priorEpisodes = journal.records
    .filter((record) => record.record_type === 'behavior_episode'
      && !tombstonedIds.has(record.entity_id))
    .map((record) => {
      const episode = normalizeBehaviorEpisode(record.payload);
      if (record.entity_id !== episode.episode_id
          || record.record_id !== `${episode.episode_id}:r${episode.revision}`) {
        throw new Error(`behavior_episode journal identity mismatch: ${record.record_id}`);
      }
      return episode;
    })
    .filter((episode) => episode.project_id === projectId
      && episode.session_id === sessionId
      && episode.task_ref === taskRef);
  const revision = priorEpisodes.reduce(
    (maximum, episode) => Math.max(maximum, episode.revision),
    0
  ) + 1;
  return appendBehaviorEpisode(storeDir, events, {
    revision,
    created_at: createdAt,
    actor: input.actor,
    expected_revision: journal.revision,
    expected_head_hash: journal.head_hash,
  });
}

module.exports = {
  BEHAVIOR_EPISODE_SCHEMA_VERSION,
  COMPLETENESS_VALUES,
  EPISODE_STATUSES,
  VERIFICATION_STATUSES,
  appendBehaviorEpisode,
  assessEpisodeJournal,
  buildBehaviorEpisode,
  buildBehaviorMetrics,
  closeBehaviorEpisode,
  eventRefFromEvent,
  normalizeBehaviorEpisode,
  verifyBehaviorEpisode,
};

'use strict';

const RUN_STATES = {
  DRAFT: 'draft',
  GLOBAL_CONTRACT_READY: 'global-contract-ready',
  GLOBAL_CONTRACT_FROZEN: 'global-contract-frozen',
  PLANNING_SLICES: 'planning-slices',
  EXECUTING_SLICES: 'executing-slices',
  CONTRACT_CONFLICT: 'contract-conflict',
  INTEGRATION_READY: 'integration-ready',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  DRY_RUN: 'dry-run',
};

const SLICE_STATES = {
  PENDING: 'slice-pending',
  READY: 'slice-ready',
  FROZEN: 'slice-frozen',
  IMPLEMENTING: 'slice-implementing',
  IMPLEMENTED: 'slice-implemented',
  REVIEWED: 'slice-reviewed',
  COMPLETED: 'slice-completed',
  BLOCKED: 'slice-blocked',
  REJECTED: 'slice-rejected',
  ABANDONED: 'slice-abandoned',
};

const RUN_TRANSITIONS = {
  [RUN_STATES.DRAFT]: [RUN_STATES.GLOBAL_CONTRACT_READY, RUN_STATES.DRY_RUN, RUN_STATES.ABANDONED],
  [RUN_STATES.GLOBAL_CONTRACT_READY]: [RUN_STATES.GLOBAL_CONTRACT_FROZEN, RUN_STATES.ABANDONED],
  [RUN_STATES.GLOBAL_CONTRACT_FROZEN]: [RUN_STATES.PLANNING_SLICES, RUN_STATES.ABANDONED],
  [RUN_STATES.PLANNING_SLICES]: [RUN_STATES.EXECUTING_SLICES, RUN_STATES.INTEGRATION_READY, RUN_STATES.ABANDONED],
  [RUN_STATES.EXECUTING_SLICES]: [
    RUN_STATES.EXECUTING_SLICES,
    RUN_STATES.PLANNING_SLICES,
    RUN_STATES.CONTRACT_CONFLICT,
    RUN_STATES.INTEGRATION_READY,
    RUN_STATES.ABANDONED,
  ],
  [RUN_STATES.CONTRACT_CONFLICT]: [RUN_STATES.EXECUTING_SLICES, RUN_STATES.PLANNING_SLICES, RUN_STATES.ABANDONED],
  [RUN_STATES.INTEGRATION_READY]: [RUN_STATES.COMPLETED, RUN_STATES.EXECUTING_SLICES, RUN_STATES.ABANDONED],
  [RUN_STATES.COMPLETED]: [],
  [RUN_STATES.ABANDONED]: [],
  [RUN_STATES.DRY_RUN]: [],
};

const SLICE_TRANSITIONS = {
  [SLICE_STATES.PENDING]: [SLICE_STATES.READY, SLICE_STATES.ABANDONED],
  [SLICE_STATES.READY]: [SLICE_STATES.FROZEN, SLICE_STATES.BLOCKED, SLICE_STATES.ABANDONED, SLICE_STATES.PENDING],
  [SLICE_STATES.FROZEN]: [SLICE_STATES.IMPLEMENTING, SLICE_STATES.REJECTED, SLICE_STATES.ABANDONED],
  [SLICE_STATES.IMPLEMENTING]: [SLICE_STATES.IMPLEMENTED, SLICE_STATES.BLOCKED, SLICE_STATES.REJECTED, SLICE_STATES.ABANDONED],
  [SLICE_STATES.IMPLEMENTED]: [SLICE_STATES.REVIEWED, SLICE_STATES.REJECTED, SLICE_STATES.ABANDONED],
  [SLICE_STATES.REVIEWED]: [SLICE_STATES.COMPLETED, SLICE_STATES.REJECTED, SLICE_STATES.ABANDONED],
  [SLICE_STATES.COMPLETED]: [],
  [SLICE_STATES.BLOCKED]: [SLICE_STATES.READY, SLICE_STATES.PENDING, SLICE_STATES.ABANDONED],
  [SLICE_STATES.REJECTED]: [SLICE_STATES.ABANDONED, SLICE_STATES.PENDING],
  [SLICE_STATES.ABANDONED]: [],
};

function isValidRunTransition(from, to) {
  if (from === to) return true;
  const allowed = RUN_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function isValidSliceTransition(from, to) {
  if (from === to) return true;
  const allowed = SLICE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertRunTransition(from, to) {
  if (!isValidRunTransition(from, to)) {
    throw new Error(`Illegal run-level transition: ${from} -> ${to}`);
  }
}

function assertSliceTransition(from, to) {
  if (!isValidSliceTransition(from, to)) {
    throw new Error(`Illegal slice-level transition: ${from} -> ${to}`);
  }
}

module.exports = {
  RUN_STATES,
  SLICE_STATES,
  RUN_TRANSITIONS,
  SLICE_TRANSITIONS,
  isValidRunTransition,
  isValidSliceTransition,
  assertRunTransition,
  assertSliceTransition,
};

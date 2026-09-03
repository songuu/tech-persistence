'use strict';

const fs = require('fs');
const path = require('path');

const STATUS = {
  CLAIMED: 'claimed',
  COMPLETED_OWNER: 'completed-owner',
  RELEASED: 'released',
};

function nowIso() {
  return new Date().toISOString();
}

function locksPath(runDir) {
  return path.join(runDir, 'locks.json');
}

function emptyLocks() {
  return { files: {}, updatedAt: nowIso() };
}

function loadLocks(runDir) {
  const file = locksPath(runDir);
  if (!fs.existsSync(file)) return emptyLocks();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
    updatedAt: parsed.updatedAt || nowIso(),
  };
}

function saveLocks(runDir, locks) {
  const next = { ...locks, updatedAt: nowIso() };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(locksPath(runDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function describeClaim(locks, filePath) {
  return locks.files[filePath] || null;
}

function classifyClaim(locks, slice) {
  const result = { claimable: [], blockedBy: [], upgradable: [] };
  const dependsOn = Array.isArray(slice.dependsOn) ? slice.dependsOn : [];
  const ownedFiles = Array.isArray(slice.ownedFiles) ? slice.ownedFiles : [];

  for (const file of ownedFiles) {
    const claim = locks.files[file];
    if (!claim || claim.status === STATUS.RELEASED) {
      result.claimable.push(file);
      continue;
    }
    if (claim.sliceId === slice.id) {
      result.claimable.push(file);
      continue;
    }
    if (claim.status === STATUS.CLAIMED) {
      result.blockedBy.push({ file, ownerId: claim.sliceId, reason: 'claimed-by-running-slice' });
      continue;
    }
    if (claim.status === STATUS.COMPLETED_OWNER) {
      if (dependsOn.includes(claim.sliceId)) {
        result.upgradable.push({ file, previousOwner: claim.sliceId });
      } else {
        result.blockedBy.push({ file, ownerId: claim.sliceId, reason: 'completed-owner-not-in-depends-on' });
      }
    }
  }
  return result;
}

function claimAll(locks, slice) {
  const next = { ...locks, files: { ...locks.files } };
  const ownedFiles = Array.isArray(slice.ownedFiles) ? slice.ownedFiles : [];
  for (const file of ownedFiles) {
    const previous = next.files[file];
    const previousOwners = previous && Array.isArray(previous.previousOwners) ? [...previous.previousOwners] : [];
    if (previous && previous.sliceId && previous.sliceId !== slice.id && !previousOwners.includes(previous.sliceId)) {
      previousOwners.push(previous.sliceId);
    }
    next.files[file] = {
      sliceId: slice.id,
      status: STATUS.CLAIMED,
      claimedAt: nowIso(),
      previousOwners,
    };
  }
  return next;
}

function markCompletedOwner(locks, slice) {
  const next = { ...locks, files: { ...locks.files } };
  const ownedFiles = Array.isArray(slice.ownedFiles) ? slice.ownedFiles : [];
  for (const file of ownedFiles) {
    const previous = next.files[file];
    if (!previous || previous.sliceId !== slice.id) continue;
    next.files[file] = {
      ...previous,
      status: STATUS.COMPLETED_OWNER,
      completedAt: nowIso(),
    };
  }
  return next;
}

function releaseSliceLocks(locks, slice) {
  const next = { ...locks, files: { ...locks.files } };
  for (const file of Object.keys(next.files)) {
    if (next.files[file].sliceId === slice.id) {
      next.files[file] = { ...next.files[file], status: STATUS.RELEASED };
    }
  }
  return next;
}

module.exports = {
  STATUS,
  emptyLocks,
  loadLocks,
  saveLocks,
  describeClaim,
  classifyClaim,
  claimAll,
  markCompletedOwner,
  releaseSliceLocks,
};

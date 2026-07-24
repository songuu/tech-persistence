#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  marketplaceExpectationFromRaw,
  publishTextCompareAndSwap,
  transformMarketplaceDocument,
  transformMarketplaceText,
  updateMarketplaceFile,
} = require('./update-codex-marketplace');

const canonicalPlugin = {
  name: 'tech-persistence',
  source: { source: 'local', path: './plugins/tech-persistence' },
  policy: {
    installation: 'INSTALLED_BY_DEFAULT',
    authentication: 'ON_INSTALL',
  },
  category: 'Coding',
};

const unrelatedPlugin = {
  name: 'unrelated',
  source: { source: 'local', path: './plugins/unrelated' },
  customPolicy: {
    futureFlag: true,
    nested: ['byte', 'semantics'],
  },
};

const existing = {
  name: 'old-name',
  interface: { displayName: 'Existing display', futureUiField: 'keep' },
  metadata: {
    owner: 'user-owned',
    futureSchema: { revision: 9, enabled: true },
  },
  extensionField: ['preserve', { nested: 'value' }],
  plugins: [
    unrelatedPlugin,
    { ...canonicalPlugin, category: 'Old category', extra: 'replace target only' },
  ],
};

const transformed = transformMarketplaceDocument(existing, {
  marketplaceName: 'local-plugins',
  marketplaceDisplayName: 'Local Plugins',
});
assert.notStrictEqual(transformed, existing, 'transform must not mutate the caller object');
assert.strictEqual(transformed.name, 'local-plugins');
assert.deepStrictEqual(transformed.interface, existing.interface);
assert.deepStrictEqual(transformed.metadata, existing.metadata);
assert.deepStrictEqual(transformed.extensionField, existing.extensionField);
assert.deepStrictEqual(transformed.plugins, [unrelatedPlugin, canonicalPlugin]);
assert.deepStrictEqual(existing.plugins[1].category, 'Old category');

const rawUnrelatedPlugin = '{"name":"raw-plugin","huge":9007199254740993,"format":[1,  2]}';
const losslessSource = `{"future":9007199254740993,"plugins":[${rawUnrelatedPlugin}]}`;
const losslessResult = transformMarketplaceText(losslessSource, {
  marketplaceName: 'local-plugins',
  marketplaceDisplayName: 'Local Plugins',
});
assert.ok(losslessResult.includes('"future": 9007199254740993'));
assert.ok(losslessResult.includes(rawUnrelatedPlugin));

const bomLosslessSource = `\uFEFF${losslessSource}`;
const bomLosslessResult = transformMarketplaceText(bomLosslessSource, {
  marketplaceName: 'local-plugins',
  marketplaceDisplayName: 'Local Plugins',
});
assert.ok(bomLosslessResult.startsWith('\uFEFF'), 'a valid UTF-8 BOM must survive the transformation');
assert.ok(bomLosslessResult.includes('"future": 9007199254740993'));
assert.ok(bomLosslessResult.includes(rawUnrelatedPlugin));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-marketplace-update-'));
try {
  const marketplacePath = path.join(root, 'marketplace.json');
  const existingText = `${JSON.stringify(existing, null, 2)}\n`;
  fs.writeFileSync(marketplacePath, existingText);
  const result = updateMarketplaceFile({
    marketplacePath,
    marketplaceName: 'local-plugins',
    marketplaceDisplayName: 'Local Plugins',
    expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
  });
  assert.strictEqual(result.backupPath, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(marketplacePath, 'utf8')), transformed);

  const invalidText = '{ invalid json';
  fs.writeFileSync(marketplacePath, invalidText);
  const invalidResult = updateMarketplaceFile({
    marketplacePath,
    marketplaceName: 'local-plugins',
    marketplaceDisplayName: 'Local Plugins',
    expectation: marketplaceExpectationFromRaw(Buffer.from(invalidText)),
  });
  assert.ok(invalidResult.backupPath);
  assert.strictEqual(fs.readFileSync(invalidResult.backupPath, 'utf8'), '{ invalid json');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(marketplacePath, 'utf8')),
    transformMarketplaceDocument(null, {
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
    })
  );

  const concurrentExisting = `${JSON.stringify({
    ...existing,
    metadata: { owner: 'external-final-gap' },
  }, null, 2)}\n`;
  const beforeClaimPath = path.join(root, 'before-claim-conflict.json');
  fs.writeFileSync(beforeClaimPath, existingText);
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: beforeClaimPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
      testHooks: {
        beforeClaim() {
          fs.writeFileSync(beforeClaimPath, concurrentExisting);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(
    fs.readFileSync(beforeClaimPath, 'utf8'),
    concurrentExisting,
    'the external final-gap write must remain at the canonical path'
  );

  const afterClaimPath = path.join(root, 'after-claim-conflict.json');
  fs.writeFileSync(afterClaimPath, existingText);
  const concurrentAfterClaim = `${JSON.stringify({ external: 'after-claim-before-publish' })}\n`;
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: afterClaimPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
      testHooks: {
        beforePublish() {
          fs.writeFileSync(afterClaimPath, concurrentAfterClaim);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(
    fs.readFileSync(afterClaimPath, 'utf8'),
    concurrentAfterClaim,
    'the no-clobber publish must retain a file created after the expected bytes were claimed'
  );

  const absentConflictPath = path.join(root, 'absent-conflict.json');
  const concurrentCreated = `${JSON.stringify({ external: 'created-in-final-gap' })}\n`;
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: absentConflictPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(null),
      testHooks: {
        beforePublish() {
          fs.writeFileSync(absentConflictPath, concurrentCreated);
        },
      },
    }),
    /compare-and-swap|concurrent/i
  );
  assert.strictEqual(
    fs.readFileSync(absentConflictPath, 'utf8'),
    concurrentCreated,
    'an externally created file must never be clobbered by the publish'
  );

  const absentAfterPublishPath = path.join(root, 'absent-after-publish-conflict.json');
  const absentAfterPublishExternal = '{"external":"absent-after-publish"}\n';
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: absentAfterPublishPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(null),
      testHooks: {
        afterPublish() {
          fs.writeFileSync(absentAfterPublishPath, absentAfterPublishExternal);
        },
      },
    }),
    /compare-and-swap|published target.*drift|concurrent/i
  );
  assert.strictEqual(
    fs.readFileSync(absentAfterPublishPath, 'utf8'),
    absentAfterPublishExternal,
    'an absent-target afterPublish drift must remain at the canonical path'
  );

  const existingAfterPublishPath = path.join(root, 'existing-after-publish-conflict.json');
  fs.writeFileSync(existingAfterPublishPath, existingText);
  const existingAfterPublishExternal = '{"external":"existing-after-publish"}\n';
  let existingAfterPublishConflict = null;
  try {
    updateMarketplaceFile({
      marketplacePath: existingAfterPublishPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
      testHooks: {
        afterPublish() {
          fs.writeFileSync(existingAfterPublishPath, existingAfterPublishExternal);
        },
      },
    });
  } catch (error) {
    existingAfterPublishConflict = error;
  }
  assert(existingAfterPublishConflict, 'an existing-target afterPublish drift must fail closed');
  assert.match(existingAfterPublishConflict.message, /compare-and-swap|published target.*drift|concurrent/i);
  assert.strictEqual(
    fs.readFileSync(existingAfterPublishPath, 'utf8'),
    existingAfterPublishExternal,
    'an existing-target afterPublish drift must remain at the canonical path'
  );
  assert(
    existingAfterPublishConflict.preservedPath
      && fs.existsSync(existingAfterPublishConflict.preservedPath),
    'existing-target afterPublish drift must retain the claimed previous bytes'
  );
  assert.strictEqual(
    fs.readFileSync(existingAfterPublishConflict.preservedPath, 'utf8'),
    existingText,
    'the retained previous evidence must contain the original expected bytes'
  );
  const existingAfterPublishJournal = path.join(
    root,
    `.${path.basename(existingAfterPublishPath)}.tech-persistence-cas-recovery.json`
  );
  assert.ok(
    fs.existsSync(existingAfterPublishJournal),
    'existing-target afterPublish drift must retain the recovery journal'
  );

  const previousDriftPath = path.join(root, 'previous-after-publish-conflict.json');
  fs.writeFileSync(previousDriftPath, existingText);
  let previousDriftEvidence = null;
  let previousDriftConflict = null;
  try {
    updateMarketplaceFile({
      marketplacePath: previousDriftPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
      testHooks: {
        afterPublish() {
          const claimDirectory = fs.readdirSync(root)
            .map((name) => path.join(root, name))
            .find((candidate) => path.basename(candidate).startsWith(`.${path.basename(previousDriftPath)}.cas.`)
              && fs.lstatSync(candidate).isDirectory());
          assert(claimDirectory, 'afterPublish must observe the live claim directory');
          previousDriftEvidence = path.join(claimDirectory, path.basename(previousDriftPath));
          const descriptor = fs.openSync(previousDriftEvidence, 'r+');
          try {
            fs.writeFileSync(descriptor, 'external-previous-drift\n');
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
        },
      },
    });
  } catch (error) {
    previousDriftConflict = error;
  }
  assert(previousDriftConflict, 'a previous-file open-handle rewrite must fail closed');
  assert.match(previousDriftConflict.message, /compare-and-swap|previous|claimed.*drift|concurrent/i);
  assert(previousDriftEvidence && fs.existsSync(previousDriftEvidence));
  const retainedPreviousDrift = fs.readFileSync(previousDriftEvidence, 'utf8');
  assert.ok(retainedPreviousDrift.startsWith('external-previous-drift\n'));
  assert.notStrictEqual(retainedPreviousDrift, existingText);
  const previousDriftJournal = path.join(
    root,
    `.${path.basename(previousDriftPath)}.tech-persistence-cas-recovery.json`
  );
  assert.ok(
    fs.existsSync(previousDriftJournal),
    'previous-file drift must retain the recovery journal and claimed evidence'
  );

  const casUpdaterModule = path.resolve(__dirname, 'update-codex-marketplace.js');
  const interruptedPublishScript = [
    "const updater = require(process.argv[1]);",
    "const original = Buffer.from(process.argv[3], 'base64');",
    "const replacement = Buffer.from(process.argv[4], 'base64');",
    "const hooks = {};",
    "hooks[process.argv[5]] = () => process.exit(Number(process.argv[7]));",
    "updater.publishTextCompareAndSwap(process.argv[2], replacement, updater.marketplaceExpectationFromRaw(original), {",
    "  retainPrevious: process.argv[6] === 'true',",
    "  testHooks: hooks,",
    "});",
  ].join('\n');
  function runInterruptedPublish(target, original, replacement, hookName, retainPrevious = false, exitCode = 87) {
    return spawnSync(process.execPath, [
      '-e',
      interruptedPublishScript,
      casUpdaterModule,
      target,
      Buffer.from(original).toString('base64'),
      Buffer.from(replacement).toString('base64'),
      hookName,
      String(retainPrevious),
      String(exitCode),
    ], { encoding: 'utf8' });
  }
  function journalPathFor(target) {
    return path.join(
      path.dirname(target),
      `.${path.basename(target)}.tech-persistence-cas-recovery.json`
    );
  }
  function readJournalFor(target) {
    return JSON.parse(fs.readFileSync(journalPathFor(target), 'utf8'));
  }
  function journalCleanupClaimDirectoriesFor(target) {
    const journalPath = journalPathFor(target);
    const prefix = `.${path.basename(journalPath)}.journal-cleanup.`;
    return fs.readdirSync(path.dirname(target))
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(path.dirname(target), name));
  }
  let renameSwapSequence = 0;
  function runWithRenameEntrySwap(match, externalBytes, operation) {
    const originalRenameSync = fs.renameSync;
    const record = { claimedPath: null, displacedPath: null, triggered: false };
    let error = null;
    let result = null;
    fs.renameSync = function renameEntrySwap(source, destination) {
      if (!record.triggered && match(path.resolve(source), path.resolve(destination))) {
        record.triggered = true;
        renameSwapSequence += 1;
        record.displacedPath = path.join(root, `owned-rename-swap-${renameSwapSequence}`);
        originalRenameSync.call(fs, source, record.displacedPath);
        fs.writeFileSync(source, externalBytes);
        originalRenameSync.call(fs, source, destination);
        record.claimedPath = destination;
        return;
      }
      return originalRenameSync.call(fs, source, destination);
    };
    try {
      result = operation();
    } catch (operationError) {
      error = operationError;
    } finally {
      fs.renameSync = originalRenameSync;
    }
    return { error, record, result };
  }

  const afterPublishUnlinkPath = path.join(root, 'after-publish-unlink.txt');
  const casOriginal = Buffer.from('expected-original\n');
  const casReplacement = Buffer.from('replacement-published\n');
  fs.writeFileSync(afterPublishUnlinkPath, casOriginal);
  let afterPublishUnlinkConflict = null;
  try {
    publishTextCompareAndSwap(
      afterPublishUnlinkPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal),
      {
        testHooks: {
          afterPublish() {
            fs.unlinkSync(afterPublishUnlinkPath);
          },
        },
      }
    );
  } catch (error) {
    afterPublishUnlinkConflict = error;
  }
  assert(afterPublishUnlinkConflict, 'removing the linked replacement in afterPublish must fail closed');
  assert.strictEqual(
    fs.existsSync(afterPublishUnlinkPath),
    false,
    'once the replacement was linked, failure recovery must not resurrect the old canonical target'
  );
  assert.ok(afterPublishUnlinkConflict.preservedPath && fs.existsSync(afterPublishUnlinkConflict.preservedPath));
  assert.deepStrictEqual(fs.readFileSync(afterPublishUnlinkConflict.preservedPath), casOriginal);
  assert.ok(fs.existsSync(journalPathFor(afterPublishUnlinkPath)));

  const recreatedTemporaryPath = path.join(root, 'recreated-temporary-before-previous.txt');
  fs.writeFileSync(recreatedTemporaryPath, casOriginal);
  let recreatedTemporaryJournal = null;
  let recreatedTemporaryConflict = null;
  try {
    publishTextCompareAndSwap(
      recreatedTemporaryPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal),
      {
        testHooks: {
          afterTemporaryUnlink() {
            recreatedTemporaryJournal = readJournalFor(recreatedTemporaryPath);
            fs.writeFileSync(recreatedTemporaryJournal.temporaryPath, 'external-recreated-temporary\n');
          },
        },
      }
    );
  } catch (error) {
    recreatedTemporaryConflict = error;
  }
  assert(recreatedTemporaryConflict, 'a temporary path recreated after unlink must fail closed');
  assert.match(recreatedTemporaryConflict.message, /temporary|compare-and-swap/i);
  assert.ok(recreatedTemporaryJournal && fs.existsSync(recreatedTemporaryJournal.previousPath));
  assert.deepStrictEqual(fs.readFileSync(recreatedTemporaryJournal.previousPath), casOriginal);
  assert.strictEqual(
    fs.readFileSync(recreatedTemporaryJournal.temporaryPath, 'utf8'),
    'external-recreated-temporary\n'
  );
  assert.ok(fs.existsSync(journalPathFor(recreatedTemporaryPath)));

  const targetDriftBeforePreviousPath = path.join(root, 'target-drift-before-previous.txt');
  fs.writeFileSync(targetDriftBeforePreviousPath, casOriginal);
  let targetDriftJournal = null;
  let targetDriftConflict = null;
  try {
    publishTextCompareAndSwap(
      targetDriftBeforePreviousPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal),
      {
        testHooks: {
          beforePreviousUnlink() {
            targetDriftJournal = readJournalFor(targetDriftBeforePreviousPath);
            fs.writeFileSync(targetDriftBeforePreviousPath, 'external-target-before-previous\n');
          },
        },
      }
    );
  } catch (error) {
    targetDriftConflict = error;
  }
  assert(targetDriftConflict, 'target drift immediately before previous deletion must fail closed');
  assert.match(targetDriftConflict.message, /target|drift|compare-and-swap/i);
  assert.ok(targetDriftJournal && fs.existsSync(targetDriftJournal.previousPath));
  assert.deepStrictEqual(fs.readFileSync(targetDriftJournal.previousPath), casOriginal);
  assert.strictEqual(
    fs.readFileSync(targetDriftBeforePreviousPath, 'utf8'),
    'external-target-before-previous\n'
  );
  assert.ok(fs.existsSync(journalPathFor(targetDriftBeforePreviousPath)));
  const cleanupFinalSyncEioPath = path.join(root, 'cleanup-final-sync-eio.txt');
  fs.writeFileSync(cleanupFinalSyncEioPath, casOriginal);
  const cleanupFinalSyncEio = publishTextCompareAndSwap(
    cleanupFinalSyncEioPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal),
    {
      testHooks: {
        beforeFinalJournalSync() {
          const error = new Error('simulated final journal sync EIO');
          error.code = 'EIO';
          throw error;
        },
      },
    }
  );
  assert.strictEqual(cleanupFinalSyncEio.commitState, 'committed');
  assert.ok(cleanupFinalSyncEio.durabilityWarning);
  assert.match(cleanupFinalSyncEio.durabilityWarning.message, /final journal sync EIO/);
  assert.deepStrictEqual(fs.readFileSync(cleanupFinalSyncEioPath), casReplacement);
  assert.ok(
    fs.existsSync(journalPathFor(cleanupFinalSyncEioPath)),
    'post-commit final-sync failure must leave a pair-bound retry marker when reconstruction succeeds'
  );
  const cleanupFinalSyncRetry = publishTextCompareAndSwap(
    cleanupFinalSyncEioPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(cleanupFinalSyncRetry.recovered, true);
  assert.strictEqual(cleanupFinalSyncRetry.commitState, 'committed');
  assert.deepStrictEqual(fs.readFileSync(cleanupFinalSyncEioPath), casReplacement);
  assert.strictEqual(fs.existsSync(journalPathFor(cleanupFinalSyncEioPath)), false);

  const absentPublishSyncEioPath = path.join(root, 'absent-publish-sync-eio.txt');
  const externalRaceCandidate = path.join(root, 'absent-publish-external-race.txt');
  fs.writeFileSync(externalRaceCandidate, 'external-race-candidate\n');
  const originalUnlinkSync = fs.unlinkSync;
  let canonicalUnlinkCalls = 0;
  let absentPublishSyncEio = null;
  try {
    fs.unlinkSync = function guardedUnlink(candidate) {
      if (path.resolve(candidate) === path.resolve(absentPublishSyncEioPath)) {
        canonicalUnlinkCalls += 1;
        const displaced = `${absentPublishSyncEioPath}.displaced-owned-link`;
        fs.renameSync(absentPublishSyncEioPath, displaced);
        fs.renameSync(externalRaceCandidate, absentPublishSyncEioPath);
        return originalUnlinkSync.call(fs, absentPublishSyncEioPath);
      }
      return originalUnlinkSync.call(fs, candidate);
    };
    absentPublishSyncEio = publishTextCompareAndSwap(
      absentPublishSyncEioPath,
      casReplacement,
      marketplaceExpectationFromRaw(null),
      {
        testHooks: {
          beforePublishSync() {
            const error = new Error('simulated absent publish sync EIO');
            error.code = 'EIO';
            throw error;
          },
        },
      }
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.strictEqual(canonicalUnlinkCalls, 0, 'sync compensation must never unlink the canonical path');
  assert.strictEqual(absentPublishSyncEio.commitState, 'committed');
  assert.ok(absentPublishSyncEio.durabilityWarning);
  assert.ok(absentPublishSyncEio.durabilityWarning.recoveryMarkerPath);
  assert.deepStrictEqual(fs.readFileSync(absentPublishSyncEioPath), casReplacement);
  assert.strictEqual(fs.readFileSync(externalRaceCandidate, 'utf8'), 'external-race-candidate\n');
  const absentPublishSyncRetry = publishTextCompareAndSwap(
    absentPublishSyncEioPath,
    casReplacement,
    marketplaceExpectationFromRaw(null)
  );
  assert.strictEqual(absentPublishSyncRetry.recovered, true);
  assert.strictEqual(absentPublishSyncRetry.commitState, 'committed');
  assert.deepStrictEqual(fs.readFileSync(absentPublishSyncEioPath), casReplacement);
  assert.strictEqual(fs.existsSync(journalPathFor(absentPublishSyncEioPath)), false);
  const exactRetryPath = path.join(root, 'exact-published-retry.txt');
  fs.writeFileSync(exactRetryPath, casOriginal);
  const exactRetryExit = runInterruptedPublish(
    exactRetryPath,
    casOriginal,
    casReplacement,
    'afterPublish',
    false,
    88
  );
  assert.strictEqual(exactRetryExit.status, 88, exactRetryExit.stderr);
  const exactRetryResult = publishTextCompareAndSwap(
    exactRetryPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(exactRetryResult.recovered, true);
  assert.strictEqual(exactRetryResult.previousPath, null);
  assert.deepStrictEqual(fs.readFileSync(exactRetryPath), casReplacement);
  assert.strictEqual(fs.existsSync(journalPathFor(exactRetryPath)), false);

  const exactRetainPath = path.join(root, 'exact-published-retry-retain.txt');
  fs.writeFileSync(exactRetainPath, casOriginal);
  const exactRetainExit = runInterruptedPublish(
    exactRetainPath,
    casOriginal,
    casReplacement,
    'afterPublish',
    true,
    89
  );
  assert.strictEqual(exactRetainExit.status, 89, exactRetainExit.stderr);
  const exactRetainResult = publishTextCompareAndSwap(
    exactRetainPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal),
    { retainPrevious: true }
  );
  assert.strictEqual(exactRetainResult.recovered, true);
  assert.ok(exactRetainResult.previousPath && fs.existsSync(exactRetainResult.previousPath));
  assert.deepStrictEqual(fs.readFileSync(exactRetainResult.previousPath), casOriginal);
  assert.deepStrictEqual(fs.readFileSync(exactRetainPath), casReplacement);
  assert.strictEqual(fs.existsSync(journalPathFor(exactRetainPath)), false);

  for (const [hookName, exitCode] of [
    ['beforePreviousUnlink', 90],
    ['afterPreviousUnlink', 91],
    ['afterClaimDirectoryRemove', 92],
    ['beforeJournalUnlink', 93],
  ]) {
    const crashPath = path.join(root, `cleanup-crash-${hookName}.txt`);
    fs.writeFileSync(crashPath, casOriginal);
    const crash = runInterruptedPublish(
      crashPath,
      casOriginal,
      casReplacement,
      hookName,
      false,
      exitCode
    );
    assert.strictEqual(crash.status, exitCode, `${hookName}: ${crash.stderr}`);
    assert.deepStrictEqual(fs.readFileSync(crashPath), casReplacement);
    assert.ok(fs.existsSync(journalPathFor(crashPath)), `${hookName} must leave a durable journal`);
    const recoveredCrash = publishTextCompareAndSwap(
      crashPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    );
    assert.strictEqual(recoveredCrash.recovered, true, `${hookName} must recover as committed`);
    assert.deepStrictEqual(fs.readFileSync(crashPath), casReplacement);
    assert.strictEqual(fs.existsSync(journalPathFor(crashPath)), false);
  }

  const temporaryClaimCrashPath = path.join(root, 'temporary-claim-hard-exit.txt');
  fs.writeFileSync(temporaryClaimCrashPath, casOriginal);
  const temporaryClaimCrash = runInterruptedPublish(
    temporaryClaimCrashPath,
    casOriginal,
    casReplacement,
    'afterTemporaryCleanupClaim',
    false,
    97
  );
  assert.strictEqual(temporaryClaimCrash.status, 97, temporaryClaimCrash.stderr);
  const temporaryClaimCrashJournal = readJournalFor(temporaryClaimCrashPath);
  const interruptedTemporaryClaimDirectory = path.join(
    root,
    `.${path.basename(temporaryClaimCrashJournal.temporaryPath)}.temporary-cleanup.${temporaryClaimCrashJournal.token}`
  );
  assert.strictEqual(fs.existsSync(temporaryClaimCrashJournal.temporaryPath), false);
  assert.ok(fs.existsSync(interruptedTemporaryClaimDirectory));
  const temporaryClaimRecovered = publishTextCompareAndSwap(
    temporaryClaimCrashPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(temporaryClaimRecovered.recovered, true);
  assert.strictEqual(temporaryClaimRecovered.commitState, 'committed');
  assert.deepStrictEqual(fs.readFileSync(temporaryClaimCrashPath), casReplacement);
  assert.strictEqual(fs.existsSync(interruptedTemporaryClaimDirectory), false);
  assert.strictEqual(fs.existsSync(journalPathFor(temporaryClaimCrashPath)), false);

  const journalClaimCrashPath = path.join(root, 'journal-claim-hard-exit.txt');
  fs.writeFileSync(journalClaimCrashPath, casOriginal);
  const journalClaimCrash = runInterruptedPublish(
    journalClaimCrashPath,
    casOriginal,
    casReplacement,
    'afterJournalCleanupClaim',
    false,
    98
  );
  assert.strictEqual(journalClaimCrash.status, 98, journalClaimCrash.stderr);
  assert.strictEqual(fs.existsSync(journalPathFor(journalClaimCrashPath)), false);
  const journalClaimDirectories = journalCleanupClaimDirectoriesFor(journalClaimCrashPath);
  assert.strictEqual(journalClaimDirectories.length, 1);
  const journalClaimedPath = path.join(
    journalClaimDirectories[0],
    path.basename(journalPathFor(journalClaimCrashPath))
  );
  assert.ok(fs.existsSync(journalClaimedPath));
  assert.strictEqual(JSON.parse(fs.readFileSync(journalClaimedPath, 'utf8')).stage, 'prepared');
  const journalClaimRecovered = publishTextCompareAndSwap(
    journalClaimCrashPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(journalClaimRecovered.recovered, true);
  assert.strictEqual(journalClaimRecovered.commitState, 'committed');
  assert.deepStrictEqual(fs.readFileSync(journalClaimCrashPath), casReplacement);
  assert.strictEqual(fs.existsSync(journalPathFor(journalClaimCrashPath)), false);
  assert.strictEqual(journalCleanupClaimDirectoriesFor(journalClaimCrashPath).length, 0);

  const orphanJournalClaimPath = path.join(root, 'orphan-journal-claim.txt');
  fs.writeFileSync(orphanJournalClaimPath, casOriginal);
  const orphanJournalPath = journalPathFor(orphanJournalClaimPath);
  const orphanClaimDirectory = path.join(
    root,
    `.${path.basename(orphanJournalPath)}.journal-cleanup.${'a'.repeat(32)}`
  );
  fs.mkdirSync(orphanClaimDirectory, { mode: 0o700 });
  assert.throws(
    () => publishTextCompareAndSwap(
      orphanJournalClaimPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /journal cleanup claim inventory|compare-and-swap/i
  );
  assert.ok(fs.existsSync(orphanClaimDirectory));
  assert.deepStrictEqual(fs.readFileSync(orphanJournalClaimPath), casOriginal);

  const tamperedJournalClaimPath = path.join(root, 'tampered-journal-claim.txt');
  fs.writeFileSync(tamperedJournalClaimPath, casOriginal);
  const tamperedJournalClaimCrash = runInterruptedPublish(
    tamperedJournalClaimPath,
    casOriginal,
    casReplacement,
    'afterJournalCleanupClaim',
    false,
    99
  );
  assert.strictEqual(tamperedJournalClaimCrash.status, 99, tamperedJournalClaimCrash.stderr);
  const tamperedClaimDirectories = journalCleanupClaimDirectoriesFor(tamperedJournalClaimPath);
  assert.strictEqual(tamperedClaimDirectories.length, 1);
  const tamperedClaimedJournal = path.join(
    tamperedClaimDirectories[0],
    path.basename(journalPathFor(tamperedJournalClaimPath))
  );
  fs.writeFileSync(tamperedClaimedJournal, '{"tampered":true}\n');
  assert.throws(
    () => publishTextCompareAndSwap(
      tamperedJournalClaimPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /journal cleanup claim|recovery journal|compare-and-swap/i
  );
  assert.ok(fs.existsSync(tamperedClaimedJournal));
  assert.strictEqual(fs.existsSync(journalPathFor(tamperedJournalClaimPath)), false);
  assert.deepStrictEqual(fs.readFileSync(tamperedJournalClaimPath), casReplacement);

  const duplicateJournalClaimPath = path.join(root, 'duplicate-journal-claim.txt');
  fs.writeFileSync(duplicateJournalClaimPath, casOriginal);
  const duplicateJournalClaimCrash = runInterruptedPublish(
    duplicateJournalClaimPath,
    casOriginal,
    casReplacement,
    'afterJournalCleanupClaim',
    false,
    100
  );
  assert.strictEqual(duplicateJournalClaimCrash.status, 100, duplicateJournalClaimCrash.stderr);
  const originalDuplicateClaims = journalCleanupClaimDirectoriesFor(duplicateJournalClaimPath);
  assert.strictEqual(originalDuplicateClaims.length, 1);
  const duplicateClaimDirectory = path.join(
    root,
    `.${path.basename(journalPathFor(duplicateJournalClaimPath))}.journal-cleanup.${'b'.repeat(32)}`
  );
  fs.mkdirSync(duplicateClaimDirectory, { mode: 0o700 });
  fs.copyFileSync(
    path.join(originalDuplicateClaims[0], path.basename(journalPathFor(duplicateJournalClaimPath))),
    path.join(duplicateClaimDirectory, path.basename(journalPathFor(duplicateJournalClaimPath)))
  );
  assert.throws(
    () => publishTextCompareAndSwap(
      duplicateJournalClaimPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /ambiguous interrupted journal cleanup claims|compare-and-swap/i
  );
  assert.strictEqual(journalCleanupClaimDirectoriesFor(duplicateJournalClaimPath).length, 2);
  assert.deepStrictEqual(fs.readFileSync(duplicateJournalClaimPath), casReplacement);

  const differentPairPath = path.join(root, 'different-pair-retry.txt');
  fs.writeFileSync(differentPairPath, casOriginal);
  const differentPairExit = runInterruptedPublish(
    differentPairPath,
    casOriginal,
    casReplacement,
    'afterPublish',
    false,
    96
  );
  assert.strictEqual(differentPairExit.status, 96, differentPairExit.stderr);
  const differentPairJournal = readJournalFor(differentPairPath);
  const wrongReplacement = Buffer.from('different-replacement\n');
  assert.throws(
    () => publishTextCompareAndSwap(
      differentPairPath,
      wrongReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /different expected\/replacement pair|compare-and-swap/i
  );
  assert.deepStrictEqual(fs.readFileSync(differentPairPath), casReplacement);
  assert.ok(fs.existsSync(journalPathFor(differentPairPath)));
  assert.ok(fs.existsSync(differentPairJournal.previousPath));
  assert.ok(fs.existsSync(differentPairJournal.temporaryPath));
  publishTextCompareAndSwap(
    differentPairPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(fs.existsSync(journalPathFor(differentPairPath)), false);

  const journalUnlinkFailurePath = path.join(root, 'journal-unlink-failure.txt');
  fs.writeFileSync(journalUnlinkFailurePath, casOriginal);
  const journalUnlinkFailureScript = [
    "const updater = require(process.argv[1]);",
    "const original = Buffer.from(process.argv[3], 'base64');",
    "const replacement = Buffer.from(process.argv[4], 'base64');",
    "updater.publishTextCompareAndSwap(process.argv[2], replacement, updater.marketplaceExpectationFromRaw(original), {",
    "  testHooks: { beforeJournalUnlink() { const error = new Error('simulated journal unlink failure'); error.code = 'EACCES'; throw error; } },",
    "});",
  ].join('\n');
  const journalUnlinkFailure = spawnSync(process.execPath, [
    '-e',
    journalUnlinkFailureScript,
    casUpdaterModule,
    journalUnlinkFailurePath,
    casOriginal.toString('base64'),
    casReplacement.toString('base64'),
  ], { encoding: 'utf8' });
  assert.notStrictEqual(journalUnlinkFailure.status, 0);
  assert.match(journalUnlinkFailure.stderr, /simulated journal unlink failure/);
  assert.deepStrictEqual(fs.readFileSync(journalUnlinkFailurePath), casReplacement);
  assert.ok(fs.existsSync(journalPathFor(journalUnlinkFailurePath)));
  const journalUnlinkRecovery = publishTextCompareAndSwap(
    journalUnlinkFailurePath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.strictEqual(journalUnlinkRecovery.recovered, true);
  assert.strictEqual(fs.existsSync(journalPathFor(journalUnlinkFailurePath)), false);
  const preparedPath = path.join(root, 'prepared-state.txt');
  fs.writeFileSync(preparedPath, casOriginal);
  const preparedExit = runInterruptedPublish(
    preparedPath,
    casOriginal,
    casReplacement,
    'afterJournalPrepared',
    false,
    94
  );
  assert.strictEqual(preparedExit.status, 94, preparedExit.stderr);
  assert.deepStrictEqual(fs.readFileSync(preparedPath), casOriginal);
  assert.strictEqual(fs.existsSync(readJournalFor(preparedPath).previousPath), false);
  publishTextCompareAndSwap(preparedPath, casReplacement, marketplaceExpectationFromRaw(casOriginal));
  assert.deepStrictEqual(fs.readFileSync(preparedPath), casReplacement);

  const replacedPreparedJournalPath = path.join(root, 'replaced-prepared-journal.txt');
  const externalJournalBytes = '{"external":"journal-owner"}\n';
  fs.writeFileSync(replacedPreparedJournalPath, casOriginal);
  let replacedPreparedJournalError = null;
  try {
    publishTextCompareAndSwap(
      replacedPreparedJournalPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal),
      {
        testHooks: {
          afterJournalPrepared() {
            fs.writeFileSync(journalPathFor(replacedPreparedJournalPath), externalJournalBytes);
          },
        },
      }
    );
  } catch (error) {
    replacedPreparedJournalError = error;
  }
  assert(replacedPreparedJournalError, 'a replaced immutable journal must fail closed');
  assert.match(replacedPreparedJournalError.message, /recovery journal|compare-and-swap/i);
  assert.deepStrictEqual(fs.readFileSync(replacedPreparedJournalPath), casOriginal);
  assert.strictEqual(
    fs.readFileSync(journalPathFor(replacedPreparedJournalPath), 'utf8'),
    externalJournalBytes,
    'the externally replaced fixed journal must never be overwritten'
  );

  const claimedRestoredPath = path.join(root, 'claimed-restored-state.txt');
  fs.writeFileSync(claimedRestoredPath, casOriginal);
  const claimedRestoredFailure = spawnSync(process.execPath, [
    '-e',
    [
      "const updater = require(process.argv[1]);",
      "const original = Buffer.from(process.argv[3], 'base64');",
      "const replacement = Buffer.from(process.argv[4], 'base64');",
      "updater.publishTextCompareAndSwap(process.argv[2], replacement, updater.marketplaceExpectationFromRaw(original), {",
      "  testHooks: { beforePublish() { throw new Error('stop after claim'); } },",
      "});",
    ].join('\n'),
    casUpdaterModule,
    claimedRestoredPath,
    casOriginal.toString('base64'),
    casReplacement.toString('base64'),
  ], { encoding: 'utf8' });
  assert.notStrictEqual(claimedRestoredFailure.status, 0);
  assert.match(claimedRestoredFailure.stderr, /stop after claim/);
  const claimedRestoredJournal = readJournalFor(claimedRestoredPath);
  assert.deepStrictEqual(fs.readFileSync(claimedRestoredPath), casOriginal);
  assert.deepStrictEqual(fs.readFileSync(claimedRestoredJournal.previousPath), casOriginal);
  publishTextCompareAndSwap(
    claimedRestoredPath,
    casReplacement,
    marketplaceExpectationFromRaw(casOriginal)
  );
  assert.deepStrictEqual(fs.readFileSync(claimedRestoredPath), casReplacement);

  function createClaimedFixture(stem) {
    const target = path.join(root, `${stem}.txt`);
    fs.writeFileSync(target, casOriginal);
    const interrupted = runInterruptedPublish(
      target,
      casOriginal,
      casReplacement,
      'beforePublish',
      false,
      95
    );
    assert.strictEqual(interrupted.status, 95, interrupted.stderr);
    assert.strictEqual(fs.existsSync(target), false);
    return { target, journalPath: journalPathFor(target), journal: readJournalFor(target) };
  }

  const temporaryDrift = createClaimedFixture('temporary-drift');
  fs.writeFileSync(temporaryDrift.journal.temporaryPath, 'external-temporary-drift\n');
  assert.throws(
    () => publishTextCompareAndSwap(
      temporaryDrift.target,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /temporary|artifact.*drift|compare-and-swap/i
  );
  assert.ok(fs.existsSync(temporaryDrift.journalPath));
  assert.ok(fs.existsSync(temporaryDrift.journal.previousPath));
  assert.ok(fs.existsSync(temporaryDrift.journal.temporaryPath));

  const unexpectedEntry = createClaimedFixture('unexpected-entry');
  const unexpectedPath = path.join(unexpectedEntry.journal.claimDirectory, 'external-evidence.txt');
  fs.writeFileSync(unexpectedPath, 'external-evidence\n');
  assert.throws(
    () => publishTextCompareAndSwap(
      unexpectedEntry.target,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /unexpected entries|claim directory|compare-and-swap/i
  );
  assert.ok(fs.existsSync(unexpectedEntry.journalPath));
  assert.ok(fs.existsSync(unexpectedEntry.journal.previousPath));
  assert.ok(fs.existsSync(unexpectedEntry.journal.temporaryPath));
  assert.strictEqual(fs.readFileSync(unexpectedPath, 'utf8'), 'external-evidence\n');

  const aliasedArtifact = createClaimedFixture('aliased-artifact');
  const originalTemporaryPath = aliasedArtifact.journal.temporaryPath;
  const aliasedJournal = { ...aliasedArtifact.journal, temporaryPath: aliasedArtifact.target };
  fs.writeFileSync(aliasedArtifact.journalPath, `${JSON.stringify(aliasedJournal, null, 2)}\n`);
  assert.throws(
    () => publishTextCompareAndSwap(
      aliasedArtifact.target,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    ),
    /invalid|distinct|compare-and-swap/i
  );
  assert.strictEqual(fs.existsSync(aliasedArtifact.target), false);
  assert.ok(fs.existsSync(aliasedArtifact.journalPath));
  assert.ok(fs.existsSync(aliasedArtifact.journal.previousPath));
  assert.ok(fs.existsSync(originalTemporaryPath));

  const linkedClaim = createClaimedFixture('linked-claim-directory');
  const realClaimDirectory = `${linkedClaim.journal.claimDirectory}.real`;
  let linkedClaimAvailable = false;
  fs.renameSync(linkedClaim.journal.claimDirectory, realClaimDirectory);
  try {
    fs.symlinkSync(
      realClaimDirectory,
      linkedClaim.journal.claimDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    linkedClaimAvailable = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) throw error;
    fs.renameSync(realClaimDirectory, linkedClaim.journal.claimDirectory);
  }
  if (linkedClaimAvailable) {
    assert.throws(
      () => publishTextCompareAndSwap(
        linkedClaim.target,
        casReplacement,
        marketplaceExpectationFromRaw(casOriginal)
      ),
      /claim directory|plain directory|compare-and-swap/i
    );
    assert.strictEqual(fs.existsSync(linkedClaim.target), false);
    assert.ok(fs.existsSync(linkedClaim.journalPath));
    assert.deepStrictEqual(
      fs.readFileSync(path.join(realClaimDirectory, path.basename(linkedClaim.target))),
      casOriginal
    );
    assert.ok(fs.existsSync(linkedClaim.journal.temporaryPath));
  }
  const previousDestinationRacePath = path.join(root, 'previous-destination-race.txt');
  fs.writeFileSync(previousDestinationRacePath, casOriginal);
  let previousDestinationJournal = null;
  let previousDestinationError = null;
  try {
    publishTextCompareAndSwap(
      previousDestinationRacePath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal),
      {
        testHooks: {
          afterJournalPrepared() {
            previousDestinationJournal = readJournalFor(previousDestinationRacePath);
            fs.writeFileSync(previousDestinationJournal.previousPath, 'external-previous-destination\n');
          },
        },
      }
    );
  } catch (error) {
    previousDestinationError = error;
  }
  assert(previousDestinationError, 'occupied previous destination must fail closed');
  assert.match(previousDestinationError.message, /no-clobber previous path|compare-and-swap/i);
  assert.deepStrictEqual(fs.readFileSync(previousDestinationRacePath), casOriginal);
  assert.strictEqual(
    fs.readFileSync(previousDestinationJournal.previousPath, 'utf8'),
    'external-previous-destination\n'
  );
  assert.ok(fs.existsSync(previousDestinationJournal.journalPath));

  const canonicalFinalGapPath = path.join(root, 'canonical-final-gap.txt');
  fs.writeFileSync(canonicalFinalGapPath, casOriginal);
  const canonicalFinalGap = runWithRenameEntrySwap(
    (source, destination) => (
      source === path.resolve(canonicalFinalGapPath)
      && path.basename(path.dirname(destination)).startsWith(`.${path.basename(canonicalFinalGapPath)}.canonical-claim.`)
    ),
    'external-canonical-final-gap\n',
    () => publishTextCompareAndSwap(
      canonicalFinalGapPath,
      casReplacement,
      marketplaceExpectationFromRaw(casOriginal)
    )
  );
  assert(canonicalFinalGap.record.triggered);
  assert(canonicalFinalGap.error, 'canonical entry swap at atomic claim must fail closed');
  assert.strictEqual(
    fs.readFileSync(canonicalFinalGap.record.claimedPath, 'utf8'),
    'external-canonical-final-gap\n'
  );
  assert.deepStrictEqual(fs.readFileSync(canonicalFinalGapPath), casOriginal);

  function assertCleanupFinalGap(stem, artifact, externalBytes) {
    const target = path.join(root, `${stem}.txt`);
    fs.writeFileSync(target, casOriginal);
    let observedJournal = null;
    const raced = runWithRenameEntrySwap(
      (source, destination) => {
        if (!observedJournal) return false;
        const cleanupName = path.basename(path.dirname(destination));
        if (artifact === 'temporary') {
          return source === path.resolve(observedJournal.temporaryPath)
            && cleanupName.includes('.temporary-cleanup.');
        }
        if (artifact === 'previous') {
          return source === path.resolve(observedJournal.previousPath)
            && cleanupName.includes('.previous-cleanup.');
        }
        return source === path.resolve(observedJournal.journalPath)
          && cleanupName.includes('.journal-cleanup.');
      },
      externalBytes,
      () => publishTextCompareAndSwap(
        target,
        casReplacement,
        marketplaceExpectationFromRaw(casOriginal),
        {
          testHooks: {
            afterPublish() {
              observedJournal = readJournalFor(target);
            },
          },
        }
      )
    );
    assert(raced.record.triggered, `${artifact} cleanup claim race must trigger`);
    assert(raced.error, `${artifact} cleanup entry swap must fail closed`);
    assert.strictEqual(fs.readFileSync(raced.record.claimedPath, 'utf8'), externalBytes);
    assert.deepStrictEqual(fs.readFileSync(target), casReplacement);
    return { observedJournal, raced, target };
  }

  const temporaryFinalGap = assertCleanupFinalGap(
    'temporary-cleanup-final-gap',
    'temporary',
    'external-temporary-cleanup-final-gap\n'
  );
  assert.ok(fs.existsSync(temporaryFinalGap.observedJournal.previousPath));
  assert.ok(fs.existsSync(temporaryFinalGap.observedJournal.journalPath));

  const previousFinalGap = assertCleanupFinalGap(
    'previous-cleanup-final-gap',
    'previous',
    'external-previous-cleanup-final-gap\n'
  );
  assert.ok(fs.existsSync(previousFinalGap.observedJournal.journalPath));

  const journalFinalGap = assertCleanupFinalGap(
    'journal-cleanup-final-gap',
    'journal',
    'external-journal-cleanup-final-gap\n'
  );
  assert.ok(fs.existsSync(journalFinalGap.raced.record.displacedPath));

  const finallyFinalGapPath = path.join(root, 'finally-temporary-final-gap.txt');
  const finallyFinalGap = runWithRenameEntrySwap(
    (source, destination) => (
      source.startsWith(`${path.resolve(finallyFinalGapPath)}.install.`)
      && path.basename(path.dirname(destination)).includes('.final-temporary-cleanup.')
    ),
    'external-finally-temporary-final-gap\n',
    () => publishTextCompareAndSwap(
      finallyFinalGapPath,
      casReplacement,
      marketplaceExpectationFromRaw(null),
      { testHooks: { beforePublish() { throw new Error('stop before absent publish'); } } }
    )
  );
  assert(finallyFinalGap.record.triggered);
  assert(finallyFinalGap.error);
  assert.match(finallyFinalGap.error.message, /stop before absent publish/);
  assert.strictEqual(
    fs.readFileSync(finallyFinalGap.record.claimedPath, 'utf8'),
    'external-finally-temporary-final-gap\n'
  );
  assert.strictEqual(fs.existsSync(finallyFinalGapPath), false);
  const hardExitPath = path.join(root, 'hard-exit-marketplace.json');
  fs.writeFileSync(hardExitPath, existingText);
  const updaterModule = path.resolve(__dirname, 'update-codex-marketplace.js');
  const hardExitScript = [
    "const updater = require(process.argv[1]);",
    "const original = Buffer.from(process.argv[3], 'base64');",
    "updater.updateMarketplaceFile({",
    "  marketplacePath: process.argv[2],",
    "  marketplaceName: 'local-plugins',",
    "  marketplaceDisplayName: 'Local Plugins',",
    "  expectation: updater.marketplaceExpectationFromRaw(original),",
    "  testHooks: { beforePublish() { process.exit(86); } },",
    "});",
  ].join('\n');
  const hardExit = spawnSync(process.execPath, [
    '-e',
    hardExitScript,
    updaterModule,
    hardExitPath,
    Buffer.from(existingText).toString('base64'),
  ], { encoding: 'utf8' });
  assert.strictEqual(hardExit.status, 86, hardExit.stderr);
  assert.strictEqual(fs.existsSync(hardExitPath), false, 'hard exit must occur in the claimed gap');
  const hardExitJournal = path.join(
    root,
    `.${path.basename(hardExitPath)}.tech-persistence-cas-recovery.json`
  );
  assert.ok(
    fs.existsSync(hardExitJournal),
    'a durable recovery journal must survive the hard exit'
  );
  const recovered = updateMarketplaceFile({
    marketplacePath: hardExitPath,
    marketplaceName: 'local-plugins',
    marketplaceDisplayName: 'Local Plugins',
    expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
  });
  assert.strictEqual(recovered.backupPath, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hardExitPath, 'utf8')), transformed);
  assert.ok(
    !fs.existsSync(hardExitJournal),
    'restart reconciliation must remove its durable journal after recovery'
  );

  const driftPath = path.join(root, 'hard-exit-drift.json');
  fs.writeFileSync(driftPath, existingText);
  const driftExit = spawnSync(process.execPath, [
    '-e',
    hardExitScript,
    updaterModule,
    driftPath,
    Buffer.from(existingText).toString('base64'),
  ], { encoding: 'utf8' });
  assert.strictEqual(driftExit.status, 86, driftExit.stderr);
  const driftText = '{"external":"after-hard-exit"}\n';
  fs.writeFileSync(driftPath, driftText);
  assert.throws(
    () => updateMarketplaceFile({
      marketplacePath: driftPath,
      marketplaceName: 'local-plugins',
      marketplaceDisplayName: 'Local Plugins',
      expectation: marketplaceExpectationFromRaw(Buffer.from(existingText)),
    }),
    /interrupted publish contains external drift/i
  );
  assert.strictEqual(fs.readFileSync(driftPath, 'utf8'), driftText);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('[OK] Codex marketplace update preserves unknown fields and unrelated plugins');

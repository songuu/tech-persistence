#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 'tech-persistence.acceptance-os-boundary-audit.v1';
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULTS = Object.freeze({
  authorityUser: 'tp-authority',
  providerUser: 'tp-provider',
  launcher: '/usr/local/libexec/tech-persistence/provider-identity-launcher',
  providerHome: '/var/lib/tech-persistence/provider',
  providerWorkspace: '/var/lib/tech-persistence/workspace',
  authorityHome: '/var/lib/tech-persistence/authority',
  controlRoot: '/var/lib/tech-persistence/authority/control',
  secretEnv: '/var/lib/tech-persistence/authority/acceptance.env',
  getentPath: '/usr/bin/getent',
  idPath: '/usr/bin/id',
  testPath: '/usr/bin/test',
  getcapPath: '/usr/sbin/getcap',
  getfaclPath: '/usr/bin/getfacl',
});

function parseNumericList(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split(/\s+/).map((item) => Number(item)).filter(Number.isSafeInteger);
}

function parseCapabilities(value) {
  return Array.from(new Set(String(value || '').match(/cap_[a-z0-9_]+/g) || [])).sort();
}

function hasExtendedAcl(value) {
  return String(value || '').split(/\r?\n/).some((line) => (
    /^default:/.test(line)
    || /^mask::/.test(line)
    || /^user:[^:]+:/.test(line)
    || /^group:[^:]+:/.test(line)
  ));
}

function failedCheckIds(report) {
  return report.checks.filter((check) => !check.ok).map((check) => check.id);
}

function fileDigest(file, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  return `sha256:${crypto.createHash('sha256').update(fileSystem.readFileSync(file)).digest('hex')}`;
}

function isWithin(candidate, root) {
  const normalizedCandidate = path.posix.normalize(candidate);
  const normalizedRoot = path.posix.normalize(root).replace(/\/$/, '');
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function validateOptions(options) {
  for (const key of ['authorityUser', 'providerUser']) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(options[key] || ''))) {
      throw new Error(`${key} must be a bounded Linux account name`);
    }
  }
  if (options.authorityUser === options.providerUser) throw new Error('authority and provider users must differ');
  for (const key of [
    'launcher', 'authorityHome', 'providerHome', 'providerWorkspace', 'controlRoot', 'secretEnv',
    'getentPath', 'idPath', 'testPath', 'getcapPath', 'getfaclPath',
  ]) {
    const value = String(options[key] || '');
    if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
      throw new Error(`${key} must be a canonical absolute Linux path`);
    }
  }
}

function evaluateBoundarySnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`OS boundary audit schema version must be ${SCHEMA_VERSION}`);
  }
  const authority = snapshot.accounts && snapshot.accounts.authority;
  const provider = snapshot.accounts && snapshot.accounts.provider;
  const paths = snapshot.paths || {};
  const probes = snapshot.probes || {};
  if (!authority || !provider) throw new Error('OS boundary audit requires authority and provider accounts');

  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail });
  const plain = (entry, type) => Boolean(entry && entry.type === type && entry.symbolicLink === false);

  add('linux-platform', snapshot.platform === 'linux', snapshot.platform);
  add('observed-at-valid', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.observedAt), snapshot.observedAt);
  add('artifact-digests-valid', Boolean(snapshot.digests
    && HASH_PATTERN.test(snapshot.digests.auditor)
    && HASH_PATTERN.test(snapshot.digests.launcher)), snapshot.digests);
  add('authority-current-uid', snapshot.currentUid === authority.uid, `${snapshot.currentUid} == ${authority.uid}`);
  add('distinct-account-uids', authority.uid !== provider.uid, `${authority.uid} != ${provider.uid}`);
  add('distinct-primary-gids', authority.gid !== provider.gid, `${authority.gid} != ${provider.gid}`);
  add('non-root-service-identities', authority.uid > 0 && provider.uid > 0 && authority.gid > 0 && provider.gid > 0, `${authority.uid}:${authority.gid},${provider.uid}:${provider.gid}`);
  add('authority-primary-group-present', authority.groups.includes(authority.gid), authority.groups.join(','));
  add('authority-no-supplementary-groups', authority.groups.length === 1 && authority.groups[0] === authority.gid, authority.groups.join(','));
  add('provider-no-supplementary-groups', provider.groups.length === 1 && provider.groups[0] === provider.gid, provider.groups.join(','));
  add('provider-excluded-from-authority-group', !provider.groups.includes(authority.gid), provider.groups.join(','));
  add('accounts-nologin', authority.shell === '/usr/sbin/nologin' && provider.shell === '/usr/sbin/nologin', `${authority.shell},${provider.shell}`);
  add('account-homes-bound', authority.home === paths.authorityHome.path && provider.home === paths.providerHome.path, `${authority.home},${provider.home}`);

  add('launcher-regular-non-link', plain(paths.launcher, 'file'), paths.launcher && paths.launcher.path);
  add('launcher-root-owned', paths.launcher && paths.launcher.uid === 0, paths.launcher && paths.launcher.uid);
  add('launcher-authority-group', paths.launcher && paths.launcher.gid === authority.gid, paths.launcher && paths.launcher.gid);
  add('launcher-mode-0750', paths.launcher && paths.launcher.mode === 0o750, paths.launcher && paths.launcher.mode);
  add('launcher-single-link', paths.launcher && paths.launcher.nlink === 1, paths.launcher && paths.launcher.nlink);
  add('launcher-no-extended-acl', paths.launcher && paths.launcher.extendedAcl === false, paths.launcher && paths.launcher.extendedAcl);
  const ancestryProtected = Boolean(paths.launcher && Array.isArray(paths.launcher.ancestry)
    && paths.launcher.ancestry.length > 0
    && paths.launcher.ancestry.every((entry) => (
      plain(entry, 'directory') && entry.uid === 0 && (entry.mode & 0o022) === 0
    )));
  add('launcher-ancestry-protected', ancestryProtected, paths.launcher && paths.launcher.ancestry);
  add(
    'launcher-ancestry-no-extended-acl',
    Boolean(paths.launcher && paths.launcher.ancestry.every((entry) => entry.extendedAcl === false)),
    paths.launcher && paths.launcher.ancestry.map((entry) => entry.extendedAcl)
  );
  add(
    'launcher-minimal-capabilities',
    JSON.stringify(snapshot.launcherCapabilities) === JSON.stringify(['cap_setgid', 'cap_setuid']),
    snapshot.launcherCapabilities
  );

  add('provider-home-regular-non-link', plain(paths.providerHome, 'directory'), paths.providerHome && paths.providerHome.path);
  add('provider-home-owner', paths.providerHome && paths.providerHome.uid === provider.uid, paths.providerHome && paths.providerHome.uid);
  add('provider-home-group', paths.providerHome && paths.providerHome.gid === provider.gid, paths.providerHome && paths.providerHome.gid);
  add('provider-home-mode-0700', paths.providerHome && paths.providerHome.mode === 0o700, paths.providerHome && paths.providerHome.mode);
  add('authority-home-regular-non-link', plain(paths.authorityHome, 'directory'), paths.authorityHome && paths.authorityHome.path);
  add('authority-home-owner', paths.authorityHome && paths.authorityHome.uid === authority.uid, paths.authorityHome && paths.authorityHome.uid);
  add('authority-home-group', paths.authorityHome && paths.authorityHome.gid === authority.gid, paths.authorityHome && paths.authorityHome.gid);
  add('authority-home-mode-0700', paths.authorityHome && paths.authorityHome.mode === 0o700, paths.authorityHome && paths.authorityHome.mode);
  add('provider-workspace-regular-non-link', plain(paths.providerWorkspace, 'directory'), paths.providerWorkspace && paths.providerWorkspace.path);
  add('provider-workspace-authority-owner', paths.providerWorkspace && paths.providerWorkspace.uid === authority.uid, paths.providerWorkspace && paths.providerWorkspace.uid);
  add('provider-workspace-group', paths.providerWorkspace && paths.providerWorkspace.gid === provider.gid, paths.providerWorkspace && paths.providerWorkspace.gid);
  add('provider-workspace-mode-0770', paths.providerWorkspace && paths.providerWorkspace.mode === 0o770, paths.providerWorkspace && paths.providerWorkspace.mode);
  add('control-root-regular-non-link', plain(paths.controlRoot, 'directory'), paths.controlRoot && paths.controlRoot.path);
  add('control-root-authority-owner', paths.controlRoot && paths.controlRoot.uid === authority.uid, paths.controlRoot && paths.controlRoot.uid);
  add('control-root-authority-group', paths.controlRoot && paths.controlRoot.gid === authority.gid, paths.controlRoot && paths.controlRoot.gid);
  add('control-root-mode-0700', paths.controlRoot && paths.controlRoot.mode === 0o700, paths.controlRoot && paths.controlRoot.mode);
  add('secret-env-regular-non-link', plain(paths.secretEnv, 'file'), paths.secretEnv && paths.secretEnv.path);
  add('secret-env-authority-owner', paths.secretEnv && paths.secretEnv.uid === authority.uid, paths.secretEnv && paths.secretEnv.uid);
  add('secret-env-authority-group', paths.secretEnv && paths.secretEnv.gid === authority.gid, paths.secretEnv && paths.secretEnv.gid);
  add('secret-env-mode-0600', paths.secretEnv && paths.secretEnv.mode === 0o600, paths.secretEnv && paths.secretEnv.mode);
  add('secret-env-single-link', paths.secretEnv && paths.secretEnv.nlink === 1, paths.secretEnv && paths.secretEnv.nlink);
  add(
    'sensitive-paths-no-extended-acl',
    [paths.authorityHome, paths.providerHome, paths.providerWorkspace, paths.controlRoot, paths.secretEnv]
      .every((entry) => entry && entry.extendedAcl === false),
    'provider/authority paths'
  );

  const workspaceRealpath = paths.providerWorkspace && paths.providerWorkspace.realpath;
  const authorityPathsOutside = Boolean(workspaceRealpath
    && paths.authorityHome && paths.controlRoot && paths.secretEnv && paths.launcher
    && !isWithin(paths.authorityHome.realpath, workspaceRealpath)
    && !isWithin(paths.controlRoot.realpath, workspaceRealpath)
    && !isWithin(paths.secretEnv.realpath, workspaceRealpath)
    && !isWithin(paths.launcher.realpath, workspaceRealpath));
  add('authority-paths-outside-provider-workspace', authorityPathsOutside, workspaceRealpath);
  add(
    'authority-assets-contained',
    Boolean(paths.authorityHome && paths.controlRoot && paths.secretEnv
      && isWithin(paths.controlRoot.realpath, paths.authorityHome.realpath)
      && isWithin(paths.secretEnv.realpath, paths.authorityHome.realpath)),
    paths.authorityHome && paths.authorityHome.realpath
  );

  add('probe-provider-uid', probes.providerUid === provider.uid, probes.providerUid);
  add('probe-provider-gid', probes.providerGid === provider.gid, probes.providerGid);
  add(
    'probe-cleared-supplementary-groups',
    Array.isArray(probes.providerGroups)
      && probes.providerGroups.length === 1
      && probes.providerGroups[0] === provider.gid,
    probes.providerGroups
  );
  add('probe-secret-unreadable', probes.canReadSecret === false, probes.canReadSecret);
  add('probe-control-root-unreadable', probes.canReadControlRoot === false, probes.canReadControlRoot);
  add('probe-control-root-unwritable', probes.canWriteControlRoot === false, probes.canWriteControlRoot);
  add('probe-workspace-writable', probes.canWriteProviderWorkspace === true, probes.canWriteProviderWorkspace);
  add('probe-launcher-unexecutable', probes.canExecuteLauncher === false, probes.canExecuteLauncher);
  add('probe-authority-identity-rejected', probes.rejectsAuthorityIdentity === true, probes.rejectsAuthorityIdentity);
  add('probe-root-identity-rejected', probes.rejectsRootIdentity === true, probes.rejectsRootIdentity);
  add('probe-relative-command-rejected', probes.rejectsRelativeCommand === true, probes.rejectsRelativeCommand);

  const snapshotDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: checks.every((check) => check.ok),
    observedAt: snapshot.observedAt,
    snapshotDigest,
    boundary: {
      authority: { name: authority.name, uid: authority.uid, gid: authority.gid },
      provider: { name: provider.name, uid: provider.uid, gid: provider.gid },
      launcher: paths.launcher.path,
      authorityHome: paths.authorityHome.path,
      providerWorkspace: paths.providerWorkspace.path,
      controlRoot: paths.controlRoot.path,
      secretEnv: paths.secretEnv.path,
      digests: snapshot.digests,
    },
    checks,
  };
}

function runFixed(command, args, dependencies = {}) {
  const runner = dependencies.spawnSync || spawnSync;
  const result = runner(command, args, {
    encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function requireSuccessful(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status === null ? 'null' : result.status}`);
  }
  return result.stdout;
}

function collectAccount(name, commands, dependencies) {
  const passwd = requireSuccessful(runFixed(commands.getentPath, ['passwd', name], dependencies), `getent passwd ${name}`);
  const fields = passwd.split(':');
  if (fields.length < 4 || fields[0] !== name) throw new Error(`invalid getent passwd record for ${name}`);
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error(`invalid UID/GID for ${name}`);
  const groups = parseNumericList(requireSuccessful(runFixed(commands.idPath, ['-G', name], dependencies), `id -G ${name}`));
  return { name, uid, gid, groups, home: fields[5], shell: fields[6] };
}

function statEntry(file, expectedType, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const stat = fileSystem.lstatSync(file);
  return {
    path: file,
    realpath: fileSystem.realpathSync(file),
    type: stat.isFile() ? 'file' : (stat.isDirectory() ? 'directory' : 'other'),
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    mode: stat.mode & 0o777,
    symbolicLink: stat.isSymbolicLink(),
    expectedType,
  };
}

function attachAcl(entry, commands, dependencies) {
  const acl = requireSuccessful(runFixed(commands.getfaclPath, ['-cp', entry.realpath], dependencies), `getfacl ${entry.path}`);
  return { ...entry, extendedAcl: hasExtendedAcl(acl) };
}

function launcherAncestry(launcherRealpath, commands, dependencies = {}) {
  const ancestors = ['/'];
  let current = '';
  for (const segment of path.posix.dirname(launcherRealpath).split('/').filter(Boolean)) {
    current += `/${segment}`;
    ancestors.push(current);
  }
  return ancestors.map((entry) => attachAcl(statEntry(entry, 'directory', dependencies), commands, dependencies));
}

function probeAsProvider(launcher, provider, command, args, dependencies) {
  return runFixed(launcher, [
    '--reuid', String(provider.uid), '--regid', String(provider.gid), '--clear-groups', '--', command, ...args,
  ], dependencies);
}

function rejectedIdentityProbe(launcher, uid, gid, command, dependencies) {
  const result = runFixed(launcher, [
    '--reuid', String(uid), '--regid', String(gid), '--clear-groups', '--', command,
  ], dependencies);
  return !result.error && result.status === 126;
}

function accessProbe(result) {
  if (result.error || ![0, 1].includes(result.status)) return null;
  return result.status === 0;
}

function collectBoundarySnapshot(options, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'linux') throw new Error('acceptance OS boundary audit requires Linux');
  const commands = { ...DEFAULTS, ...options };
  validateOptions(commands);
  const authority = collectAccount(options.authorityUser, commands, dependencies);
  const provider = collectAccount(options.providerUser, commands, dependencies);
  const launcher = attachAcl(statEntry(options.launcher, 'file', dependencies), commands, dependencies);
  launcher.ancestry = launcherAncestry(launcher.realpath, commands, dependencies);
  const capabilityOutput = requireSuccessful(
    runFixed(commands.getcapPath, [launcher.realpath], dependencies),
    'getcap provider launcher'
  );
  const uidProbe = probeAsProvider(launcher.realpath, provider, commands.idPath, ['-u'], dependencies);
  const gidProbe = probeAsProvider(launcher.realpath, provider, commands.idPath, ['-g'], dependencies);
  const groupsProbe = probeAsProvider(launcher.realpath, provider, commands.idPath, ['-G'], dependencies);
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAt: (dependencies.now ? dependencies.now() : new Date()).toISOString(),
    platform,
    currentUid: dependencies.currentUid === undefined ? process.getuid() : dependencies.currentUid,
    accounts: { authority, provider },
    paths: {
      launcher,
      authorityHome: attachAcl(statEntry(options.authorityHome, 'directory', dependencies), commands, dependencies),
      providerHome: attachAcl(statEntry(options.providerHome, 'directory', dependencies), commands, dependencies),
      providerWorkspace: attachAcl(statEntry(options.providerWorkspace, 'directory', dependencies), commands, dependencies),
      controlRoot: attachAcl(statEntry(options.controlRoot, 'directory', dependencies), commands, dependencies),
      secretEnv: attachAcl(statEntry(options.secretEnv, 'file', dependencies), commands, dependencies),
    },
    launcherCapabilities: parseCapabilities(capabilityOutput),
    digests: {
      auditor: fileDigest(dependencies.auditorPath || __filename, dependencies),
      launcher: fileDigest(launcher.realpath, dependencies),
    },
    probes: {
      providerUid: uidProbe.status === 0 ? Number(uidProbe.stdout) : null,
      providerGid: gidProbe.status === 0 ? Number(gidProbe.stdout) : null,
      providerGroups: groupsProbe.status === 0 ? parseNumericList(groupsProbe.stdout) : null,
      canReadSecret: accessProbe(probeAsProvider(launcher.realpath, provider, commands.testPath, ['-r', options.secretEnv], dependencies)),
      canReadControlRoot: accessProbe(probeAsProvider(launcher.realpath, provider, commands.testPath, ['-r', options.controlRoot], dependencies)),
      canWriteControlRoot: accessProbe(probeAsProvider(launcher.realpath, provider, commands.testPath, ['-w', options.controlRoot], dependencies)),
      canWriteProviderWorkspace: accessProbe(probeAsProvider(launcher.realpath, provider, commands.testPath, ['-w', options.providerWorkspace], dependencies)),
      canExecuteLauncher: accessProbe(probeAsProvider(launcher.realpath, provider, commands.testPath, ['-x', launcher.realpath], dependencies)),
      rejectsAuthorityIdentity: rejectedIdentityProbe(launcher.realpath, authority.uid, authority.gid, commands.idPath, dependencies),
      rejectsRootIdentity: rejectedIdentityProbe(launcher.realpath, 0, 0, commands.idPath, dependencies),
      rejectsRelativeCommand: rejectedIdentityProbe(launcher.realpath, provider.uid, provider.gid, 'id', dependencies),
    },
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift() || 'audit';
  if (!['audit', 'help'].includes(command)) throw new Error(`unknown command: ${command}`);
  const options = { ...DEFAULTS, command, json: false };
  const mapping = {
    '--authority-user': 'authorityUser', '--provider-user': 'providerUser', '--launcher': 'launcher',
    '--provider-home': 'providerHome', '--provider-workspace': 'providerWorkspace', '--authority-home': 'authorityHome',
    '--control-root': 'controlRoot', '--secret-env': 'secretEnv',
  };
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const key = mapping[argument];
    if (!key) throw new Error(`unknown option: ${argument}`);
    if (args.length === 0 || args[0].startsWith('--')) throw new Error(`missing value for ${argument}`);
    options[key] = args.shift();
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/acceptance-authority-os-boundary.js audit [options] [--json]',
    '',
    'Read-only Linux audit. Run as the configured authority account after install-linux.sh.',
    'Options: --authority-user --provider-user --launcher --authority-home --provider-home',
    '         --provider-workspace --control-root --secret-env',
  ].join('\n');
}

function main() {
  const options = parseArgs(process.argv);
  if (options.command === 'help') {
    console.log(usage());
    return;
  }
  const report = evaluateBoundarySnapshot(collectBoundarySnapshot(options));
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`${check.ok ? '[OK]' : '[FAIL]'} ${check.id}`);
    console.log(`${report.ok ? '[PASS]' : '[FAIL]'} ${report.snapshotDigest}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[fail] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULTS,
  parseNumericList,
  parseCapabilities,
  hasExtendedAcl,
  fileDigest,
  validateOptions,
  failedCheckIds,
  evaluateBoundarySnapshot,
  collectBoundarySnapshot,
  parseArgs,
};

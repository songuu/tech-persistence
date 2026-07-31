const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const repoRoot = resolve(__dirname, "..", "..");

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

test("deploy script keeps the Tech Persistence release boundary explicit", () => {
  const script = readRepoFile("scripts/deploy-site.ps1");

  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /root@47\.253\.230\.197/);
  assert.match(script, /\/tech-persistence\//);
  assert.match(script, /site[\\/]dist/);
  assert.match(script, /site[\\/]build\.js/);
  assert.match(script, /releases/);
  assert.match(script, /current/);
  assert.match(script, /ln -s/);
  assert.match(script, /mv -Tf/);
  assert.match(script, /BackupRetention/);
  assert.match(script, /Host:/);
  assert.match(script, /PublicOrigin/);
  assert.match(script, /https:\/\/songuu\.top/);
  assert.doesNotMatch(script, /agent-build/i);
  assert.doesNotMatch(script, /\.vitepress[\\/]dist/i);
});

test("nginx snippet owns only the /tech-persistence/ route", () => {
  const nginx = readRepoFile(
    "deploy/nginx/tech-persistence.location.conf",
  );

  assert.match(
    nginx,
    /location\s*=\s*\/tech-persistence\s*\{[\s\S]*301\s+\/tech-persistence\//,
  );
  assert.match(nginx, /location\s+\^~\s+\/tech-persistence\//);
  assert.match(nginx, /alias\s+\/opt\/tech-persistence\/current\//);
  assert.match(
    nginx,
    /try_files[\s\S]*\/tech-persistence\/index\.html/,
  );
  assert.doesNotMatch(nginx, /location\s+(?:=|\^~)?\s*\/\s*\{/);
  assert.doesNotMatch(nginx, /agent-build/i);
});

test("deployment runbook documents gates, atomic release, verification, and rollback", () => {
  const runbook = readRepoFile("docs/SITE_DEPLOYMENT.md");

  const orderedMarkers = [
    "local gates",
    "site/build.js",
    "releases/<release-id>",
    "current",
    "loopback",
    "public HTTPS",
  ];
  let cursor = -1;

  for (const marker of orderedMarkers) {
    const next = runbook.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order marker: ${marker}`);
    cursor = next;
  }

  assert.match(runbook, /-DryRun/);
  assert.match(runbook, /BackupRetention/);
  assert.match(runbook, /nginx -t/);
  assert.match(runbook, /systemctl reload nginx/);
  assert.match(runbook, /rollback/i);
  assert.match(runbook, /\/opt\/tech-persistence\/releases/);
  assert.match(runbook, /https:\/\/songuu\.top\/tech-persistence\//);
});

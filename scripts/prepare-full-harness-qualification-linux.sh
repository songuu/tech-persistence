#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 0 ] || exit 2
stage=/var/lib/tech-persistence/authority/auth-validation-20260902-vDnp2t
runtime=/var/lib/tech-persistence/runtime-candidates/harness-20260902-a3
source=/var/lib/tech-persistence/qualification-projects/full-harness-20260902
install -d -o root -g root -m 0755 /var/lib/tech-persistence/qualification-projects
install -d -o root -g root -m 0755 "$source"
SOURCE_ROOT="$source" /usr/bin/node -e '
  const fs=require("node:fs"), p=process.env.SOURCE_ROOT;
  fs.writeFileSync(`${p}/README.md`, "# Harness qualification fixture\n");
  fs.writeFileSync(`${p}/test.js`, `"use strict";\nconst fs=require("node:fs");\nconst { execFileSync }=require("node:child_process");\nif(fs.readFileSync("result.txt","utf8")!=="HARNESS_FULL_CHAIN_OK\\n") throw new Error("result mismatch");\nconst tracked=execFileSync("/usr/bin/git",["status","--porcelain","--untracked-files=no"],{encoding:"utf8"});\nif(tracked!=="") throw new Error("tracked files changed");\n`);
'
if [ ! -d "$source/.git" ]; then
  git -C "$source" init -q
  git -C "$source" config user.name qualification
  git -C "$source" config user.email qualification@invalid
fi
git -C "$source" add README.md test.js
git -C "$source" diff --cached --quiet || git -C "$source" commit -qm 'qualification fixture'
chown -R root:root "$source"
find "$source" -type d -exec chmod 0755 {} +
find "$source" -type f -exec chmod 0644 {} +
install -d -o tp-authority -g tp-provider -m 2710 /var/lib/tech-persistence/task-sandboxes
RUNTIME="$runtime" SOURCE_ROOT="$source" /usr/bin/node -e '
  const fs=require("node:fs"); const worker=require(`${process.env.RUNTIME}/scripts/harness-task-worker.js`);
  const projects={"qualification-project":{sourceRoot:process.env.SOURCE_ROOT,timeoutMs:1200000,validationCommands:["node test.js"]}};
  fs.writeFileSync("/var/lib/tech-persistence/task-runtime/qualification-git.config",worker.gitSystemConfigForProjects(projects),{mode:0o440});
'
chown root:tp-authority /var/lib/tech-persistence/task-runtime/qualification-git.config
chmod 0440 /var/lib/tech-persistence/task-runtime/qualification-git.config
install -o root -g tp-authority -m 0550 "$stage/qualify-full-harness-linux.js" "$runtime/scripts/qualify-full-harness-linux.js"
/usr/sbin/runuser -u tp-authority -- /usr/bin/node "$runtime/scripts/qualify-full-harness-linux.js"

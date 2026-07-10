#!/usr/bin/env node
'use strict';const assert=require('assert');const p=require('./agent-orchestrator/provider-profiles');
assert.strictEqual(p.profileId({},'implementation'),'implementation-coding-v1');
assert.ok(p.capabilitySnapshot({},'review').capabilities.includes('structured-output'));
assert.notStrictEqual(p.hash({a:1}),p.hash({a:2}));
console.log('agent-orchestrator-p1: 3 passed');
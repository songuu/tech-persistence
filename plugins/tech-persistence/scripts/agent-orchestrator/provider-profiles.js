'use strict';
const crypto=require('crypto');
const DEFAULT_PROFILES={spec:'spec-reasoning-v1',implementation:'implementation-coding-v1',review:'review-independent-v1'};
const PROFILES={
 'spec-reasoning-v1':{id:'spec-reasoning-v1',adapter:'claude-print',capabilities:['stdin','structured-output','repo-read'],providerKey:'spec'},
 'implementation-coding-v1':{id:'implementation-coding-v1',adapter:'codex-exec',capabilities:['stdin','structured-output','repo-read','workspace-write'],providerKey:'implementation'},
 'review-independent-v1':{id:'review-independent-v1',adapter:'claude-print',capabilities:['stdin','structured-output','repo-read'],providerKey:'review'}
};
function profileId(options,key){const requested=options&&options[`${key}-profile`];return requested&&PROFILES[requested]?requested:DEFAULT_PROFILES[key];}
function profile(options,key){return PROFILES[profileId(options,key)];}
function capabilitySnapshot(options,key){const p=profile(options,key);return {profileId:p.id,adapter:p.adapter,capabilities:p.capabilities,verifiedAt:new Date().toISOString(),source:'static-profile'};}
function hash(value){return 'sha256:'+crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
module.exports={DEFAULT_PROFILES,PROFILES,profileId,profile,capabilitySnapshot,hash};
'use strict';
const { projectMany } = require('./harness-events');

// Read-only by construction: accepts value snapshots and returns a detached projection.
function projectHarnessTimeline(sources = []) {
  return projectMany(sources.map((source) => ({
    kind: source.kind,
    sourceId: source.sourceId,
    source: source.value,
    observedAt: source.observedAt,
    links: source.links,
    summary: source.summary,
  })));
}
module.exports = { projectHarnessTimeline };

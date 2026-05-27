'use strict';

const PRIVATE_TAGS = [
  { tag: 'system-private', marker: '[SYSTEM PRIVATE REDACTED]' },
  { tag: 'private', marker: '[PRIVATE REDACTED]' },
  { tag: 'claude-mem-context', marker: '[CLAUDE MEM CONTEXT REDACTED]' },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTagContent(text, tag, marker) {
  const escapedTag = escapeRegExp(tag);
  const closedTag = new RegExp(
    `<\\s*${escapedTag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${escapedTag}\\s*>`,
    'gi'
  );
  const unclosedTag = new RegExp(`<\\s*${escapedTag}\\b[^>]*>[\\s\\S]*$`, 'gi');
  return text.replace(closedTag, marker).replace(unclosedTag, marker);
}

function stripPrivateTags(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return PRIVATE_TAGS.reduce(
    (current, { tag, marker }) => stripTagContent(current, tag, marker),
    value
  );
}

function redactObservationValue(value) {
  if (typeof value === 'string') return stripPrivateTags(value);
  if (Array.isArray(value)) return value.map(redactObservationValue);
  return value;
}

function redactObservation(observation) {
  const redacted = { ...observation };
  [
    'input_summary',
    'output_summary',
    'command',
  ].forEach((field) => {
    if (field in redacted) redacted[field] = redactObservationValue(redacted[field]);
  });
  if (Array.isArray(redacted.input_paths)) {
    redacted.input_paths = redacted.input_paths
      .map(redactObservationValue)
      .filter((item) => typeof item === 'string' && !item.includes('[PRIVATE REDACTED]'));
  }
  return redacted;
}

module.exports = {
  PRIVATE_TAGS,
  redactObservation,
  stripPrivateTags,
};

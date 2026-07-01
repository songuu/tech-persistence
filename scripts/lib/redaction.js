'use strict';

const PRIVATE_TAGS = [
  { tag: 'system-private', marker: '[SYSTEM PRIVATE REDACTED]' },
  { tag: 'private', marker: '[PRIVATE REDACTED]' },
  { tag: 'claude-mem-context', marker: '[CLAUDE MEM CONTEXT REDACTED]' },
];

const SECRET_MARKER = '[REDACTED]';

const SECRET_PATTERNS = [
  {
    id: 'private_key_block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'aws_access_key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'openai_key',
    regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9][A-Za-z0-9_-]{19,}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'gitlab_pat',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'huggingface_token',
    regex: /\bhf_[A-Za-z0-9]{20,}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'npm_token',
    regex: /\bnpm_[A-Za-z0-9]{20,}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'digitalocean_token',
    regex: /\bdop_v1_[A-Za-z0-9]{64,}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'bearer_token',
    regex: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/gi,
    replace: (_match, prefix) => `${prefix}${SECRET_MARKER}`,
  },
  {
    id: 'secret_assignment',
    regex: /(\b(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?)[^"',\s}]{8,}(["']?)/gi,
    replace: (_match, prefix, suffix) => `${prefix}${SECRET_MARKER}${suffix || ''}`,
  },
  {
    id: 'long_base64_blob',
    regex: /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
    replace: () => SECRET_MARKER,
  },
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

function redactGcpServiceAccountFields(text) {
  if (!/"type"\s*:\s*"service_account"/i.test(text) || !/"private_key"\s*:/i.test(text)) {
    return text;
  }
  return text
    .replace(/("private_key(?:_id)?"\s*:\s*")[^"]+(")/gi, `$1${SECRET_MARKER}$2`)
    .replace(/("client_email"\s*:\s*")[^"]+(")/gi, `$1${SECRET_MARKER}$2`);
}

function redactSecretPatterns(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const withoutGcpFields = redactGcpServiceAccountFields(value);
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern.regex, pattern.replace),
    withoutGcpFields
  );
}

function stripPrivateTags(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const withoutTags = PRIVATE_TAGS.reduce(
    (current, { tag, marker }) => stripTagContent(current, tag, marker),
    value
  );
  return redactSecretPatterns(withoutTags);
}

function redactSensitiveText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return stripPrivateTags(value);
}

function redactObservationValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
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
  SECRET_MARKER,
  SECRET_PATTERNS,
  redactObservation,
  redactSecretPatterns,
  redactSensitiveText,
  stripPrivateTags,
};

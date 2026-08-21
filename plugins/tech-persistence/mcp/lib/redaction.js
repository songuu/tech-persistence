'use strict';

const PRIVATE_TAGS = [
  { tag: 'system-private', marker: '[SYSTEM PRIVATE REDACTED]' },
  { tag: 'private', marker: '[PRIVATE REDACTED]' },
  { tag: 'claude-mem-context', marker: '[CLAUDE MEM CONTEXT REDACTED]' },
];

const SECRET_MARKER = '[REDACTED]';

// Keep this vocabulary aligned with the structured-key policy in
// self-learning-canonical.js. Free text needs its own scanner because JSON and
// shell snippets may be embedded in prose and cannot safely be parsed as JSON.
const SENSITIVE_KEY_SUFFIXES = new Set([
  'authorization',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'session_token',
  'auth_token',
  'bearer_token',
  'id_token',
  'token',
  'secret',
  'client_secret',
  'secret_key',
  'secret_access_key',
  'access_key_id',
  'password',
  'passwd',
  'pwd',
  'private_key',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'set_cookie',
  'connection_string',
  'database_url',
]);

const ASSIGNMENT_PREFIX_PATTERN = /(^|[^A-Za-z0-9_.-])((?:\\["']|["'])?)([A-Za-z0-9][A-Za-z0-9_.-]*)(\\["']|["'])?(\s*)([:=])(\s*)/g;
const AUTHORIZATION_PREFIX_PATTERN = /\b(Authorization(?:\s*[:=]\s*|\s+))(?:Basic|Bearer)\s+/gi;
const URI_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:(?:\/\/|\\\/\\\/))(?!\[REDACTED\]@)[^\s\/?#@]+@/g;

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
    id: 'github_pat_classic',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'github_pat_fine_grained',
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    replace: () => SECRET_MARKER,
  },
  {
    id: 'slack_token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g,
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

function normalizeSensitiveKeyName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isSensitiveAssignmentKey(value) {
  const normalized = normalizeSensitiveKeyName(value);
  if (SENSITIVE_KEY_SUFFIXES.has(normalized)) return true;
  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (normalized.endsWith(`_${suffix}`)) return true;
  }
  return false;
}

function quoteTokenAt(text, offset) {
  if (text.startsWith('\\"', offset)) return '\\"';
  if (text.startsWith("\\'", offset)) return "\\'";
  if (text[offset] === '"' || text[offset] === "'") return text[offset];
  return null;
}

function precedingBackslashCount(text, offset) {
  let count = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) count += 1;
  return count;
}

function findQuotedValueEnd(text, valueStart, quoteToken) {
  const quote = quoteToken[quoteToken.length - 1];
  for (let index = valueStart + quoteToken.length; index < text.length; index += 1) {
    if (text[index] !== quote) continue;
    const slashCount = precedingBackslashCount(text, index);
    if (quoteToken.length === 1 && slashCount % 2 === 0) {
      return { closeStart: index, end: index + 1 };
    }
    // In a stringified JSON snippet the delimiter itself is \" (or \').
    // An embedded escaped quote has three or more preceding backslashes.
    if (quoteToken.length === 2 && slashCount === 1) {
      return { closeStart: index - 1, end: index + 1 };
    }
  }
  return null;
}

function isEscapedAt(text, offset) {
  return precedingBackslashCount(text, offset) % 2 === 1;
}

function findUnquotedValueEnd(text, valueStart, separator) {
  if (text.startsWith(SECRET_MARKER, valueStart)) return valueStart + SECRET_MARKER.length;
  let index = valueStart;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (isEscapedAt(text, index)) continue;
    if (/\s/.test(char) || char === ';' || char === '}' || char === ']') break;
    if (separator === ':' && char === ',') break;
    if (separator === '=' && char === ',' && /\s/.test(text[index + 1] || '')) break;
  }
  return index;
}

function likelyStructuredColon(text, match, key, openingKeyQuote) {
  if (openingKeyQuote) return true;
  // Camel/snake/kebab/dot/upper-case names are assignment-shaped. For bare
  // words such as "password", require surrounding object punctuation so prose
  // like "password: should be strong" remains untouched.
  const camelCase = /[a-z0-9][A-Z]/.test(key);
  const upperCase = /[A-Z]/.test(key) && key === key.toUpperCase();
  if (camelCase || upperCase || /[_.-]/.test(key)) return true;
  const prefix = `${text.slice(0, match.index)}${match[1]}`.trimEnd();
  return prefix.length > 0 && /[{[,]$/.test(prefix);
}

function redactAuthorizationCredentials(text) {
  let cursor = 0;
  let output = '';
  AUTHORIZATION_PREFIX_PATTERN.lastIndex = 0;
  for (let match = AUTHORIZATION_PREFIX_PATTERN.exec(text); match;
    match = AUTHORIZATION_PREFIX_PATTERN.exec(text)) {
    const valueStart = match.index + match[0].length;
    const quoteToken = quoteTokenAt(text, valueStart);
    let valueEnd;
    if (quoteToken) {
      const quotedEnd = findQuotedValueEnd(text, valueStart, quoteToken);
      if (quotedEnd) {
        valueEnd = quotedEnd.end;
      } else {
        const lineEnd = text.indexOf('\n', valueStart + quoteToken.length);
        valueEnd = lineEnd === -1 ? text.length : lineEnd;
      }
    } else {
      valueEnd = findUnquotedValueEnd(text, valueStart, ':');
    }
    if (valueEnd === valueStart) continue;

    output += text.slice(cursor, match.index);
    output += `${match[1]}${SECRET_MARKER}`;
    cursor = valueEnd;
    AUTHORIZATION_PREFIX_PATTERN.lastIndex = valueEnd;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

function redactSecretAssignments(text) {
  let cursor = 0;
  let output = '';
  ASSIGNMENT_PREFIX_PATTERN.lastIndex = 0;
  for (let match = ASSIGNMENT_PREFIX_PATTERN.exec(text); match;
    match = ASSIGNMENT_PREFIX_PATTERN.exec(text)) {
    const openingKeyQuote = match[2] || '';
    const key = match[3];
    const closingKeyQuote = match[4] || '';
    const separator = match[6];
    if (!isSensitiveAssignmentKey(key)) continue;
    if (openingKeyQuote !== closingKeyQuote) continue;
    if (separator === ':' && !likelyStructuredColon(text, match, key, openingKeyQuote)) continue;

    const valueStart = match.index + match[0].length;
    const quoteToken = quoteTokenAt(text, valueStart);
    let replacement;
    let valueEnd;
    if (quoteToken) {
      const quotedEnd = findQuotedValueEnd(text, valueStart, quoteToken);
      if (quotedEnd) {
        replacement = `${quoteToken}${SECRET_MARKER}${text.slice(quotedEnd.closeStart, quotedEnd.end)}`;
        valueEnd = quotedEnd.end;
      } else {
        const lineEnd = text.indexOf('\n', valueStart + quoteToken.length);
        valueEnd = lineEnd === -1 ? text.length : lineEnd;
        replacement = `${quoteToken}${SECRET_MARKER}`;
      }
    } else {
      valueEnd = findUnquotedValueEnd(text, valueStart, separator);
      if (valueEnd === valueStart) continue;
      replacement = SECRET_MARKER;
    }

    output += text.slice(cursor, valueStart);
    output += replacement;
    cursor = valueEnd;
    ASSIGNMENT_PREFIX_PATTERN.lastIndex = valueEnd;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

function redactSecretPatterns(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const withoutGcpFields = redactGcpServiceAccountFields(value);
  const withoutAuthorizationCredentials = redactAuthorizationCredentials(withoutGcpFields);
  const withoutUriUserinfo = withoutAuthorizationCredentials.replace(
    URI_USERINFO_PATTERN,
    (_match, scheme) => `${scheme}${SECRET_MARKER}@`
  );
  const withoutAssignments = redactSecretAssignments(withoutUriUserinfo);
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern.regex, pattern.replace),
    withoutAssignments
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

function redactArtifactValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactArtifactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactArtifactValue(item)]));
  }
  return value;
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
  redactArtifactValue,
  redactSecretPatterns,
  redactSensitiveText,
  stripPrivateTags,
};

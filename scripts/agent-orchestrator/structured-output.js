'use strict';

const fs = require('fs');
const path = require('path');

const schemaCache = new Map();
const MAX_REF_DEPTH = 32;
const LOCAL_DEFINITION_REF_PREFIX = '#/$defs/';

const SINGLE_SCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const ARRAY_SCHEMA_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const MAP_SCHEMA_KEYWORDS = ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'];

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (Array.isArray(expected)) return expected.some((type) => matchesType(value, type));
  if (expected === 'object') return isPlainObject(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'null') return value === null;
  return typeof value === expected;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeJsonPointerToken(token, ref) {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error(`$ref ${JSON.stringify(ref)} contains an invalid JSON Pointer escape`);
  }
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parseLocalDefinitionRef(ref) {
  if (typeof ref !== 'string') throw new Error('$ref must be a string');
  if (!ref.startsWith('#')) {
    throw new Error(
      `$ref ${JSON.stringify(ref)} is unsupported; only document-local ${LOCAL_DEFINITION_REF_PREFIX}... JSON Pointer references are allowed`
    );
  }
  let fragment;
  try {
    fragment = decodeURIComponent(ref.slice(1));
  } catch (_error) {
    throw new Error(`$ref ${JSON.stringify(ref)} contains invalid URI encoding`);
  }
  if (!fragment.startsWith('/$defs/')) {
    throw new Error(
      `$ref ${JSON.stringify(ref)} is unsupported; only document-local ${LOCAL_DEFINITION_REF_PREFIX}... JSON Pointer references are allowed`
    );
  }
  const tokens = fragment.slice(1).split('/').map((token) => decodeJsonPointerToken(token, ref));
  if (tokens.length < 2 || tokens[0] !== '$defs' || !tokens[1]) {
    throw new Error(
      `$ref ${JSON.stringify(ref)} must identify a schema below ${LOCAL_DEFINITION_REF_PREFIX}`
    );
  }
  return tokens;
}

function resolveLocalDefinitionRef(rootSchema, ref) {
  const tokens = parseLocalDefinitionRef(ref);
  let current = rootSchema;
  for (const token of tokens) {
    if ((!isPlainObject(current) && !Array.isArray(current))
        || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new Error(`$ref ${JSON.stringify(ref)} does not resolve at JSON Pointer token ${JSON.stringify(token)}`);
    }
    current = current[token];
  }
  if (current !== true && current !== false && !isPlainObject(current)) {
    throw new Error(`$ref ${JSON.stringify(ref)} does not resolve to a schema`);
  }
  return current;
}

function collectReferenceEntries(schema, at = '#', result = [], seen = new Set()) {
  if (schema === true || schema === false || !isPlainObject(schema) || seen.has(schema)) return result;
  seen.add(schema);
  if (Object.prototype.hasOwnProperty.call(schema, '$ref')) {
    result.push({ ref: schema.$ref, at: `${at}/$ref` });
  }
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (child === true || child === false || isPlainObject(child)) {
      collectReferenceEntries(child, `${at}/${keyword}`, result, seen);
    }
  }
  for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      collectReferenceEntries(child, `${at}/${keyword}/${index}`, result, seen);
    });
  }
  for (const keyword of MAP_SCHEMA_KEYWORDS) {
    const children = schema[keyword];
    if (!isPlainObject(children)) continue;
    for (const [key, child] of Object.entries(children)) {
      collectReferenceEntries(child, `${at}/${keyword}/${key}`, result, seen);
    }
  }
  return result;
}

function createValidationContext(rootSchema) {
  return {
    rootSchema,
    refStack: [],
  };
}

function validateSchemaReferences(rootSchema, context = createValidationContext(rootSchema)) {
  const errors = new Set();

  function follow(ref, at, trail) {
    let target;
    try {
      target = resolveLocalDefinitionRef(context.rootSchema, ref);
    } catch (error) {
      errors.add(`${at}: ${error.message}`);
      return;
    }
    if (trail.includes(ref)) {
      errors.add(`${at}: reference cycle detected: ${[...trail, ref].join(' -> ')}`);
      return;
    }
    if (trail.length >= MAX_REF_DEPTH) {
      errors.add(`${at}: reference chain exceeds maximum depth ${MAX_REF_DEPTH}`);
      return;
    }
    for (const nested of collectReferenceEntries(target)) {
      follow(nested.ref, nested.at, [...trail, ref]);
    }
  }

  for (const entry of collectReferenceEntries(rootSchema)) {
    follow(entry.ref, entry.at, []);
  }
  return [...errors];
}

function validateBranch(value, schema, at, context) {
  const errors = [];
  validateValue(value, schema, at, errors, context);
  return errors;
}

function validateValue(value, schema, at = '$', errors = [], context) {
  let activeContext = context;
  if (!activeContext) {
    activeContext = createValidationContext(schema);
    const referenceErrors = validateSchemaReferences(schema, activeContext);
    if (referenceErrors.length > 0) {
      errors.push(...referenceErrors.map((error) => `${at} schema ${error}`));
      return errors;
    }
  }
  if (schema === true || schema === undefined) return errors;
  if (schema === false) {
    errors.push(`${at} is forbidden by schema`);
    return errors;
  }
  if (!isPlainObject(schema)) {
    errors.push(`${at} has an invalid local schema definition`);
    return errors;
  }

  if (Object.prototype.hasOwnProperty.call(schema, '$ref')) {
    const ref = schema.$ref;
    let target;
    try {
      target = resolveLocalDefinitionRef(activeContext.rootSchema, ref);
    } catch (error) {
      errors.push(`${at} schema ${error.message}`);
      return errors;
    }
    if (activeContext.refStack.includes(ref)) {
      errors.push(`${at} schema reference cycle detected: ${[...activeContext.refStack, ref].join(' -> ')}`);
      return errors;
    }
    if (activeContext.refStack.length >= MAX_REF_DEPTH) {
      errors.push(`${at} schema reference chain exceeds maximum depth ${MAX_REF_DEPTH}`);
      return errors;
    }
    validateValue(value, target, at, errors, {
      ...activeContext,
      refStack: [...activeContext.refStack, ref],
    });
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateValue(value, branch, at, errors, activeContext);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((branch) => validateBranch(value, branch, at, activeContext).length === 0);
    if (matches.length === 0) errors.push(`${at} does not match any allowed schema`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateBranch(value, branch, at, activeContext).length === 0);
    if (matches.length !== 1) errors.push(`${at} must match exactly one allowed schema`);
  }

  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
    errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum)
      && !schema.enum.some((allowed) => sameJsonValue(value, allowed))) {
    errors.push(`${at} must be one of the allowed values: ${schema.enum.map(JSON.stringify).join(', ')}`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${at} must be ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}; got ${valueType(value)}`);
    return errors;
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${at}.${required} is required`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childAt = `${at}.${key}`;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateValue(child, properties[key], childAt, errors, activeContext);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at} has additional property ${key}`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateValue(child, schema.additionalProperties, childAt, errors, activeContext);
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${at} must contain at least ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${at} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const serialized = value.map(JSON.stringify);
      if (new Set(serialized).size !== serialized.length) errors.push(`${at} must contain unique items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateValue(
        item,
        schema.items,
        `${at}[${index}]`,
        errors,
        activeContext
      ));
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${at} must contain at least ${schema.minLength} character(s)`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${at} must contain at most ${schema.maxLength} character(s)`);
    }
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern).test(value))) {
      errors.push(`${at} does not match required pattern ${schema.pattern}`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${at} must be a valid date-time`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${at} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${at} must be <= ${schema.maximum}`);
    }
  }
  return errors;
}

function loadSchema(schemaRoot, schemaName) {
  const file = path.resolve(schemaRoot, schemaName);
  const root = path.resolve(schemaRoot);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`structured output schema escapes schema root: ${schemaName}`);
  }
  const stat = fs.statSync(file);
  const cacheKey = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (!schemaCache.has(cacheKey)) {
    schemaCache.clear();
    schemaCache.set(cacheKey, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return schemaCache.get(cacheKey);
}

function validateCollection(value, schema, property, errors, context) {
  if (!isPlainObject(value)) {
    errors.push(`$.${property} collection wrapper must be an object`);
    return;
  }
  const keys = Object.keys(value);
  if (!Object.prototype.hasOwnProperty.call(value, property)) {
    errors.push(`$.${property} is required`);
    return;
  }
  for (const key of keys) {
    if (key !== property) errors.push(`$ has additional property ${key}`);
  }
  if (!Array.isArray(value[property])) {
    errors.push(`$.${property} must be array; got ${valueType(value[property])}`);
    return;
  }
  value[property].forEach((entry, index) => {
    validateValue(entry, schema, `$.${property}[${index}]`, errors, context);
  });
}

function assertStructuredOutput(value, options = {}) {
  const label = options.label || 'provider structured output';
  if (!options.schemaRoot || !options.schemaName) {
    throw new Error(`${label} local schema configuration is missing`);
  }
  const schema = loadSchema(options.schemaRoot, options.schemaName);
  const errors = [];
  const context = createValidationContext(schema);
  const referenceErrors = validateSchemaReferences(schema, context);
  if (referenceErrors.length > 0) {
    errors.push(...referenceErrors.map((error) => `schema ${error}`));
  } else if (options.collectionProperty) {
    validateCollection(value, schema, options.collectionProperty, errors, context);
  } else {
    validateValue(value, schema, '$', errors, context);
  }
  if (errors.length > 0) {
    throw new Error(`${label} failed local schema validation: ${errors.join('; ')}`);
  }
  return value;
}

module.exports = {
  MAX_REF_DEPTH,
  assertStructuredOutput,
  loadSchema,
  validateSchemaReferences,
  validateValue,
};

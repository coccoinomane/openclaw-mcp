import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const MAX_ERRORS = 8;
const MAX_DETAIL_LENGTH = 220;

// Reject unsafe names rather than quoting control characters or arbitrary payloads.
function fieldName(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value)
    ? value
    : '[redacted field]';
}

function fieldPath(path: string): string {
  if (!path) return 'input';
  if (path.length > 256) return '[redacted path]';
  const parts = path.slice(1).split('/');
  if (parts.length > 4) return '[redacted path]';
  return parts
    .map((part) => (/^(0|[1-9][0-9]{0,8})$/.test(part) ? '[' + part + ']' : fieldName(part)))
    .join('.');
}

function detail(error: ErrorObject): string {
  const path = fieldPath(error.instancePath);
  const { keyword, params } = error;
  switch (keyword) {
    case 'required':
      return (
        'missing required field: ' +
        (error.instancePath ? path + '.' : '') +
        fieldName(params.missingProperty)
      );
    case 'additionalProperties':
      return (
        'unknown field: ' +
        (error.instancePath ? path + '.' : '') +
        fieldName(params.additionalProperty)
      );
    case 'type':
      return path + ' must be ' + params.type;
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return path + ' must be ' + params.comparison + ' ' + params.limit;
    case 'minLength':
    case 'maxLength':
      return (
        path +
        ' must have ' +
        (keyword === 'minLength' ? 'at least ' : 'at most ') +
        params.limit +
        ' characters'
      );
    case 'minItems':
    case 'maxItems':
      return (
        path +
        ' must have ' +
        (keyword === 'minItems' ? 'at least ' : 'at most ') +
        params.limit +
        ' items'
      );
    case 'pattern':
      return path + ' must match its schema pattern';
    case 'format':
      return path + ' must match its schema format';
    case 'enum':
      return path + ' must be one of the allowed values in the tool schema';
    case 'const':
      return path + ' must equal the constant in the tool schema';
    default:
      return path + ' does not satisfy its schema constraint';
  }
}

export function createInputValidator(name: string, schema: Tool['inputSchema']) {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return (input: unknown): string | undefined => {
    if (validate(input)) return undefined;
    const errors = validate.errors ?? [];
    const details = errors.slice(0, MAX_ERRORS).map((error) => {
      const message = detail(error);
      return message.length > MAX_DETAIL_LENGTH
        ? message.slice(0, MAX_DETAIL_LENGTH - 3) + '...'
        : message;
    });
    if (errors.length > MAX_ERRORS) details.push('more errors omitted');
    return (
      'Invalid input for ' +
      fieldName(name) +
      ': ' +
      details.join('; ') +
      '. Check the input schema in tools/list.'
    );
  };
}

const MAX_TEXT = 20000;
const MAX_TITLE = 200;
const SOURCES = new Set(['gemini-live', 'browser', 'manual']);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** A short title derived from the first few words of the transcript. */
function deriveTitle(text) {
  const words = text.trim().split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? `${words.slice(0, 57)}...` : words || 'Untitled';
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return trimmed;
}

function parseCreate(body = {}) {
  const text = optionalString(body.text, 'text', MAX_TEXT);
  if (!text) throw new ValidationError('text is required');
  const title = optionalString(body.title, 'title', MAX_TITLE) || deriveTitle(text);
  const language = optionalString(body.language, 'language', 32) || 'hi-en';
  const source = body.source ?? 'manual';
  if (!SOURCES.has(source)) throw new ValidationError(`source must be one of ${[...SOURCES].join(', ')}`);
  let durationMs = body.durationMs;
  if (durationMs !== undefined && durationMs !== null) {
    if (!Number.isInteger(durationMs) || durationMs < 0) throw new ValidationError('durationMs must be a non-negative integer');
  }
  return { title, text, language, source, durationMs };
}

function parseUpdate(body = {}) {
  const patch = {
    title: optionalString(body.title, 'title', MAX_TITLE),
    text: optionalString(body.text, 'text', MAX_TEXT),
    language: optionalString(body.language, 'language', 32),
  };
  if (patch.text === '') throw new ValidationError('text cannot be empty');
  if (patch.title === '') throw new ValidationError('title cannot be empty');
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new ValidationError('provide at least one of title, text, language');
  }
  return patch;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id must be a positive integer');
  return id;
}

module.exports = { ValidationError, deriveTitle, parseCreate, parseUpdate, parseId };

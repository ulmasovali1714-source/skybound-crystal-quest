import { createHmac, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function requestId() {
  return randomUUID();
}

export function keyedDigest(secret, value) {
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

export function resolveIdempotencyKey(request, body) {
  const headerKey = request.headers['idempotency-key'];
  const bodyKey = body?.idempotencyKey;
  if (headerKey !== undefined && typeof headerKey !== 'string') {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key is invalid.');
  }
  if (bodyKey !== undefined && typeof bodyKey !== 'string') {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key is invalid.');
  }
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_MISMATCH', 'The idempotency keys do not match.');
  }
  const value = headerKey || bodyKey;
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  }
  return value;
}

export async function readJson(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object.');
    return parsed;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
}

export function sendJson(response, status, payload, requestIdValue) {
  const data = JSON.stringify({ ...payload, requestId: requestIdValue });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(data);
}

export function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

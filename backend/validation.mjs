import { HttpError, safeInteger } from './http-utils.mjs';

export function validateClientReport(report, runSeed, nowMs = Date.now(), startedAt = null, maxRunMs = 3_600_000) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new HttpError(400, 'INVALID_RUN_REPORT', 'A valid run report is required.');
  }
  if (!safeInteger(report.score, { max: 10_000_000 }) || !safeInteger(report.crystals, { max: 1_000_000 }) ||
      !safeInteger(report.elapsedMs, { min: 1, max: maxRunMs }) || report.seed !== runSeed ||
      report.randomAlgorithm !== 'mulberry32-v1') {
    throw new HttpError(422, 'INVALID_RUN_REPORT', 'The run report does not match the server-issued run.');
  }
  if (startedAt instanceof Date && nowMs - startedAt.getTime() > maxRunMs + 60_000) {
    throw new HttpError(422, 'RUN_EXPIRED', 'The game run has expired.');
  }
  if (!Array.isArray(report.inputEvents) || report.inputEvents.length < 1 || report.inputEvents.length > 12_000) {
    throw new HttpError(422, 'INVALID_INPUT_EVENTS', 'The run input event list is invalid.');
  }
  let previous = -1;
  for (const elapsed of report.inputEvents) {
    if (!safeInteger(elapsed, { max: report.elapsedMs }) || elapsed < previous) {
      throw new HttpError(422, 'INVALID_INPUT_EVENTS', 'The run input event list is invalid.');
    }
    previous = elapsed;
  }
  if (report.inputEvents[0] !== 0) {
    throw new HttpError(422, 'INVALID_INPUT_EVENTS', 'The run input event list is invalid.');
  }
  return Object.freeze({
    score: report.score,
    crystals: report.crystals,
    elapsedMs: report.elapsedMs,
    seed: report.seed,
    randomAlgorithm: report.randomAlgorithm,
    inputEvents: report.inputEvents,
  });
}

export function parseReferralStartParam(value) {
  if (typeof value !== 'string') return null;
  const match = /^ref_([A-Za-z0-9_-]{8,64})$/.exec(value);
  return match ? match[1] : null;
}

export function isTelegramMember(member) {
  if (!member || typeof member !== 'object') return false;
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  return member.status === 'restricted' && member.is_member === true;
}

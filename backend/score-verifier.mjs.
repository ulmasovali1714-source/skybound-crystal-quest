/**
 * Fail-closed default. A client report is not proof of a score or crystal count.
 * Production score rewards remain disabled until a trusted deterministic replay
 * verifier for this exact game ruleset is installed through GAME_VERIFIER_MODULE.
 * The configured module must export async verifyRunReport({ run, clientReport })
 * and return { verified: true, score, crystals } only after replaying the run.
 */
export async function verifyRunReport() {
  return { verified: false, reason: 'GAMEPLAY_REPLAY_VERIFIER_NOT_CONFIGURED' };
}

export function validateVerifierResult(result, clientReport) {
  if (!result || result.verified !== true) return null;
  if (!Number.isSafeInteger(result.score) || result.score < 0 || result.score > 10_000_000 ||
      !Number.isSafeInteger(result.crystals) || result.crystals < 0 || result.crystals > clientReport.crystals ||
      result.crystals > 1_000_000) {
    throw new Error('The configured game verifier returned an invalid result.');
  }
  return Object.freeze({ score: result.score, crystals: result.crystals });
}

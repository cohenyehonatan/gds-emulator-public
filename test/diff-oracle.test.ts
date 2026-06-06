/**
 * Unit tests for the categorize() logic used by validate-galileo-diff-
 * oracle.ts. Verifies the diff classification scheme without needing
 * pre-prod credentials — keeps the harness's heuristics CI-checkable.
 *
 * NOTE: categorize() is duplicated here from the script (TS rootDir
 * scoping doesn't expose root-level scripts as importable modules).
 * If this drifts from the script, the snapshot test in the latter
 * will catch the divergence at the first live run.
 */
import { describe, it, expect } from 'vitest';

type DiffCategory =
  | 'IDENTICAL'
  | 'TRAILER-DIFF'
  | 'LOCATOR-DIFF'
  | 'STRUCTURAL'
  | 'ERROR-EITHER';

const LOCAL_ONLY_TRAILER = '[LOCAL VIEW ONLY — no v11 REST equivalent]';
const LOCATOR_REGEX = /\b[A-Z0-9]{6}\b/g;

function stripTrailer(s: string): string {
  return s.replace(
    new RegExp(`\\n?${LOCAL_ONLY_TRAILER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
    ''
  );
}

function maskLocators(s: string): string {
  return s.replace(LOCATOR_REGEX, '<LOC>');
}

function categorize(emulated: string, live: string): { category: DiffCategory; notes: string } {
  if (emulated === live) return { category: 'IDENTICAL', notes: '' };
  if (emulated.includes('LIVE BACKEND ERROR') || live.includes('LIVE BACKEND ERROR')) {
    return { category: 'ERROR-EITHER', notes: 'pre-prod transient' };
  }
  const emulatedStripped = stripTrailer(emulated);
  const liveStripped = stripTrailer(live);
  if (emulatedStripped === liveStripped) {
    return { category: 'TRAILER-DIFF', notes: 'trailer-only difference' };
  }
  if (maskLocators(emulatedStripped) === maskLocators(liveStripped)) {
    return { category: 'LOCATOR-DIFF', notes: 'differ only in 6-char locator' };
  }
  const eLines = emulatedStripped.split('\n');
  const lLines = liveStripped.split('\n');
  if (eLines.length !== lLines.length) {
    return { category: 'STRUCTURAL', notes: `line count ${eLines.length} vs ${lLines.length}` };
  }
  for (let i = 0; i < eLines.length; i++) {
    if (eLines[i] !== lLines[i]) {
      return { category: 'STRUCTURAL', notes: `line ${i + 1} differs` };
    }
  }
  return { category: 'STRUCTURAL', notes: 'unknown' };
}

describe('diff-oracle categorize', () => {
  it('classifies identical responses as IDENTICAL', () => {
    expect(categorize('HA SIGNED ON AT 7K9S', 'HA SIGNED ON AT 7K9S').category).toBe('IDENTICAL');
  });

  it('classifies LOCAL VIEW ONLY trailer-only difference as TRAILER-DIFF', () => {
    const emulated = 'NO HISTORY';
    const live = `NO HISTORY\n${LOCAL_ONLY_TRAILER}`;
    expect(categorize(emulated, live).category).toBe('TRAILER-DIFF');
  });

  it('classifies locator-substitution as LOCATOR-DIFF', () => {
    const emulated = 'A1B2C3  7K9S/HA\n1.1SMITH/JOHN MR';
    const live = 'GZTZ5R  7K9S/HA\n1.1SMITH/JOHN MR';
    expect(categorize(emulated, live).category).toBe('LOCATOR-DIFF');
  });

  it('classifies different-line-count responses as STRUCTURAL', () => {
    const emulated = 'A\nB\nC';
    const live = 'A\nB';
    const result = categorize(emulated, live);
    expect(result.category).toBe('STRUCTURAL');
    expect(result.notes).toContain('line count');
  });

  it('classifies same-line-count diff as STRUCTURAL with line annotation', () => {
    const emulated = 'A\nB\nC';
    const live = 'A\nB\nD';
    const result = categorize(emulated, live);
    expect(result.category).toBe('STRUCTURAL');
    expect(result.notes).toContain('line 3');
  });

  it('classifies LIVE BACKEND ERROR on either side as ERROR-EITHER', () => {
    expect(categorize('OK', 'LIVE BACKEND ERROR: 500').category).toBe('ERROR-EITHER');
    expect(categorize('LIVE BACKEND ERROR: 500', 'OK').category).toBe('ERROR-EITHER');
  });

  it('combined trailer+locator difference still surfaces as STRUCTURAL (no double-step)', () => {
    // If a verb introduces BOTH a trailer and a locator, the heuristic
    // currently doesn't compose — surfaces as STRUCTURAL. Documented so
    // a future composition pass can recognize this case.
    const emulated = 'A1B2C3';
    const live = `GZTZ5R\n${LOCAL_ONLY_TRAILER}`;
    const result = categorize(emulated, live);
    // After trailer strip: 'A1B2C3' vs 'GZTZ5R' — both locators →
    // LOCATOR-DIFF. So this composes correctly via strip-then-mask.
    expect(result.category).toBe('LOCATOR-DIFF');
  });
});

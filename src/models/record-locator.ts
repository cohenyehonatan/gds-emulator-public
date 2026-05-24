/**
 * Record locator (PNR "Sabre Record Locator", e.g. VZRAFH — workbook p.~).
 * Six characters. Real Sabre locators are alphabetic; we keep A-Z and avoid
 * digits to match the look of examples in the course. Uniqueness is enforced
 * by the caller (pnr-store) via the `exists` predicate.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function generateRecordLocator(exists: (loc: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let loc = '';
    for (let i = 0; i < 6; i++) {
      loc += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!exists(loc)) return loc;
  }
  throw new Error('Could not generate a unique record locator');
}

export function isRecordLocator(s: string): boolean {
  return /^[A-Z]{6}$/.test(s);
}

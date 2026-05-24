/**
 * Record locator (PNR "Sabre Record Locator"). Six alphabetic characters,
 * matching the workbook examples (`VZRAFH`, `5UXHHO`). We keep A-Z; uniqueness
 * is enforced by the caller (pnr-store) via the `exists` predicate.
 *
 * Note: modern Sabre locators can include digits, but the classic all-alpha
 * form matches every example in the course, so we stay with it.
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

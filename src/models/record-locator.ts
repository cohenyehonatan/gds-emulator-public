/**
 * Record locator (PNR "Sabre Record Locator"). Six characters. The
 * EmulatedBackend generator uses A-Z only — matches the course
 * examples (`VZRAFH`, `5UXHHO`) for readability of test fixtures.
 * `isRecordLocator` accepts the broader A-Z0-9 form because live
 * GDS locators (Travelport included) are alphanumeric, and the
 * predicate runs against both emulated and live PNRs.
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
  return /^[A-Z0-9]{6}$/.test(s);
}

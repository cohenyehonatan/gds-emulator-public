/**
 * Sabre keyboard mapping — the "Other Identification Code Keys" (workbook p.3,
 * "Sabre System Keyboard Quick Reference").
 *
 * A real Sabre keyboard puts special characters on ordinary physical keys:
 *   physical [  →  ¤  Change          (e.g. 91¤214-555-2121-H)
 *   physical \  →  §  End-Item        (strings several entries together)
 *   physical '  →  ¥  Cross of Lorraine (separator)
 *
 * Since an ASCII keyboard can't easily produce ¤ § ¥, we accept the physical-key
 * characters as aliases and normalize them to the Sabre glyphs before parsing.
 * The real glyphs are accepted too (idempotent).
 */

export const CHANGE = '¤';
export const END_ITEM = '§';
export const CROSS_OF_LORRAINE = '¥';

/** Physical (ASCII) key → Sabre special character. */
const KEY_TO_SABRE: Record<string, string> = {
  '[': CHANGE,
  '\\': END_ITEM,
  "'": CROSS_OF_LORRAINE,
};

/** Map physical-key aliases to Sabre special characters. */
export function normalizeKeyboard(raw: string): string {
  return raw.replace(/[[\\']/g, (c) => KEY_TO_SABRE[c] ?? c);
}

/**
 * Split an entry on the End-Item separator into its component entries.
 * `-A/B§9...§6P` → ['-A/B', '9...', '6P']. A single entry returns [itself].
 */
export function splitEndItems(raw: string): string[] {
  return raw
    .split(END_ITEM)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

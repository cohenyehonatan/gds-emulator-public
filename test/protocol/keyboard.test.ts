import { describe, it, expect } from 'vitest';
import { normalizeKeyboard, splitEndItems, CHANGE, END_ITEM, CROSS_OF_LORRAINE } from '../../src/protocol/keyboard.js';

describe('keyboard mapping', async () => {
  it('maps physical-key aliases to Sabre special characters', async () => {
    expect(normalizeKeyboard('[')).toBe(CHANGE); // ¤
    expect(normalizeKeyboard('\\')).toBe(END_ITEM); // §
    expect(normalizeKeyboard("'")).toBe(CROSS_OF_LORRAINE); // ¥
    expect(normalizeKeyboard('91[214-555-2121-H')).toBe('91¤214-555-2121-H');
  });

  it('is idempotent on real glyphs and leaves ordinary entries alone', async () => {
    expect(normalizeKeyboard('6P§E')).toBe('6P§E');
    expect(normalizeKeyboard('01Y1')).toBe('01Y1');
    expect(normalizeKeyboard('-SMITH/JOHN MR')).toBe('-SMITH/JOHN MR');
  });

  it('splits on the end-item separator', async () => {
    expect(splitEndItems('-A/B§9305-555-1212-H§6P')).toEqual(['-A/B', '9305-555-1212-H', '6P']);
    expect(splitEndItems('01Y1')).toEqual(['01Y1']);
  });
});

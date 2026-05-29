import { describe, it, expect } from 'vitest';
import { generateRecordLocator, isRecordLocator } from '../../src/models/record-locator.js';

describe('record locator', async () => {
  it('generates a 6-letter locator', async () => {
    const loc = generateRecordLocator(() => false);
    expect(isRecordLocator(loc)).toBe(true);
  });

  it('avoids collisions via the exists predicate', async () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const loc = generateRecordLocator((l) => taken.has(l));
      expect(taken.has(loc)).toBe(false);
      taken.add(loc);
    }
    expect(taken.size).toBe(200);
  });

  it('rejects malformed locators', async () => {
    expect(isRecordLocator('ABC12')).toBe(false);
    expect(isRecordLocator('ABCDE1')).toBe(false);
    expect(isRecordLocator('ABCDEFG')).toBe(false);
  });
});

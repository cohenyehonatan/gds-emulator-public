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

  it('rejects malformed locators (wrong length / lowercase / non-alphanumeric)', async () => {
    expect(isRecordLocator('ABC12')).toBe(false); // 5 chars
    expect(isRecordLocator('ABCDEFG')).toBe(false); // 7 chars
    expect(isRecordLocator('abcdef')).toBe(false); // lowercase
    expect(isRecordLocator('ABCD-1')).toBe(false); // dash not alphanumeric
  });

  it('accepts alphanumeric locators (matches live Travelport format)', async () => {
    expect(isRecordLocator('ABCDE1')).toBe(true); // 5 letters + 1 digit
    expect(isRecordLocator('ABC123')).toBe(true);
    expect(isRecordLocator('123456')).toBe(true);
  });
});

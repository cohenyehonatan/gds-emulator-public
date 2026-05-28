import { describe, it, expect } from 'vitest';
import { parsePassengerSelection } from '../../src/utils/passenger-ref.js';

describe('parsePassengerSelection (dotted-name references)', () => {
  it('parses a single ref (1.2)', () => {
    expect(parsePassengerSelection('1.2')).toEqual([{ item: 1, passenger: 2 }]);
  });

  it('parses a within-item range (1.3-1.5)', () => {
    expect(parsePassengerSelection('1.3-1.5')).toEqual([
      { item: 1, passenger: 3 },
      { item: 1, passenger: 4 },
      { item: 1, passenger: 5 },
    ]);
  });

  it('parses a comma list (1.2,1.4)', () => {
    expect(parsePassengerSelection('1.2,1.4')).toEqual([
      { item: 1, passenger: 2 },
      { item: 1, passenger: 4 },
    ]);
  });

  it('parses ranges within a comma list (1.2,1.4-1.5)', () => {
    expect(parsePassengerSelection('1.2,1.4-1.5')).toEqual([
      { item: 1, passenger: 2 },
      { item: 1, passenger: 4 },
      { item: 1, passenger: 5 },
    ]);
  });

  it('rejects a cross-item range (1.2-2.3)', () => {
    expect(() => parsePassengerSelection('1.2-2.3')).toThrow(/Cross-item/);
  });

  it('rejects a descending range (1.5-1.3)', () => {
    expect(() => parsePassengerSelection('1.5-1.3')).toThrow(/Bad range/);
  });

  it('rejects an undotted single number (no implicit .1)', () => {
    expect(() => parsePassengerSelection('3')).toThrow(/Bad passenger ref/);
  });
});

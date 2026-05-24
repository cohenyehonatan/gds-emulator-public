import { describe, it, expect } from 'vitest';
import { parseEntry, ParseError } from '../../src/protocol/parser.js';

describe('parseEntry — sigil dispatch', () => {
  it('parses availability', () => {
    const e = parseEntry('115JUNJFKLAX');
    expect(e.kind).toBe('availability');
    if (e.kind === 'availability') {
      expect(e.origin).toBe('JFK');
      expect(e.destination).toBe('LAX');
      expect(e.date.raw).toBe('15JUN');
    }
  });

  it('parses a sell with seats/class/line', () => {
    const e = parseEntry('01Y1');
    expect(e.kind).toBe('sell');
    if (e.kind === 'sell') {
      expect(e.seats).toBe(1);
      expect(e.bookingClass).toBe('Y');
      expect(e.line).toBe(1);
    }
  });

  it('matches multi-char sigils before single-char (ER, not E)', () => {
    const er = parseEntry('ER');
    expect(er.kind).toBe('end_transaction');
    if (er.kind === 'end_transaction') expect(er.redisplay).toBe(true);

    const e = parseEntry('E');
    expect(e.kind).toBe('end_transaction');
    if (e.kind === 'end_transaction') expect(e.redisplay).toBe(false);
  });

  it('distinguishes IG/I (ignore) from SI (sign in)', () => {
    expect(parseEntry('IG').kind).toBe('ignore');
    expect(parseEntry('I').kind).toBe('ignore');
    expect(parseEntry('SI*4321').kind).toBe('sign_in');
  });

  it('parses field + display entries', () => {
    expect(parseEntry('-SMITH/JOHN MR').kind).toBe('name');
    expect(parseEntry('9305-555-1212-H').kind).toBe('phone');
    expect(parseEntry('7TAW15JUN/').kind).toBe('ticketing');
    expect(parseEntry('6P').kind).toBe('received_from');
    expect(parseEntry('*ABCDEF').kind).toBe('display');
  });

  it('throws ParseError on garbage', () => {
    expect(() => parseEntry('ZZZ')).toThrow(ParseError);
    expect(() => parseEntry('')).toThrow(ParseError);
  });
});

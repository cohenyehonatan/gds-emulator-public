import { describe, it, expect } from 'vitest';
import { parseEntry, ParseError } from '../../src/protocol/parser.js';
import { parseNameText } from '../../src/models/name-element.js';

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

  it('parses cancel entries (segment, multiple, range, itinerary, all-air)', () => {
    const x1 = parseEntry('X1');
    expect(x1.kind).toBe('cancel');
    if (x1.kind === 'cancel') {
      expect(x1.mode).toBe('segment');
      expect(x1.segments).toEqual([1]);
    }
    const multi = parseEntry('X1/3');
    if (multi.kind === 'cancel') expect(multi.segments).toEqual([1, 3]);
    const range = parseEntry('X1-3');
    if (range.kind === 'cancel') expect(range.segments).toEqual([1, 2, 3]);
    const it = parseEntry('XI');
    if (it.kind === 'cancel') expect(it.mode).toBe('itinerary');
    const ia = parseEntry('XIA');
    if (ia.kind === 'cancel') expect(ia.mode).toBe('all_air');
  });

  it('parses a change-segment-status entry', () => {
    const e = parseEntry('.1HK');
    expect(e.kind).toBe('segment_status');
    if (e.kind === 'segment_status') {
      expect(e.segment).toBe(1);
      expect(e.status).toBe('HK');
    }
  });

  it('throws ParseError on garbage', () => {
    expect(() => parseEntry('ZZZ')).toThrow(ParseError);
    expect(() => parseEntry('')).toThrow(ParseError);
  });
});

describe('multi-passenger name parsing', () => {
  it('parses count + multiple given names into one item', () => {
    const item = parseNameText('2MURRAY/FRED MR/HANA MRS');
    expect(item.count).toBe(2);
    expect(item.surname).toBe('MURRAY');
    expect(item.passengers).toEqual([
      { firstName: 'FRED', title: 'MR' },
      { firstName: 'HANA', title: 'MRS' },
    ]);
  });

  it('defaults a single name to count 1', () => {
    const item = parseNameText('SMITH/JUNE');
    expect(item.count).toBe(1);
    expect(item.passengers).toEqual([{ firstName: 'JUNE' }]);
  });
});

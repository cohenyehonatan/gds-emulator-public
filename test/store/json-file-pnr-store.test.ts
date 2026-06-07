/**
 * JsonFilePnrStore — persistent PnrStore variant.
 *
 * Same API as the in-memory PnrStore. The map is mirrored to a JSON
 * file on each commit; constructor reads the file (if present) on
 * startup so PNRs survive a process restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFilePnrStore } from '../../src/store/json-file-pnr-store.js';
import { Pnr } from '../../src/models/pnr.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'json-pnr-store-test-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makePnr(): Pnr {
  const p = new Pnr();
  p.names = [{ surname: 'SMITH', passengers: [{ firstName: 'JOHN' }], count: 1, infant: false }];
  p.segments = [{
    segmentNumber: 1, carrier: 'UA', flightNumber: '1234', bookingClass: 'Y',
    date: '27JUN', dayOfWeek: 'S', dayOfWeekNum: 7,
    origin: 'DEN', destination: 'FRA', status: 'HK', seats: 1,
    departTime: '0800', arriveTime: '0730',
  }];
  return p;
}

describe('JsonFilePnrStore', () => {
  it('starts empty when the file does not exist', () => {
    const store = new JsonFilePnrStore(join(tmp, 'fresh.json'));
    expect(store.size).toBe(0);
    expect(store.values()).toHaveLength(0);
  });

  it('commits a Pnr and writes the file atomically', () => {
    const path = join(tmp, 'commit.json');
    const store = new JsonFilePnrStore(path);
    const pnr = makePnr();
    const locator = store.commit(pnr);

    expect(locator).toMatch(/^[A-Z]{6}$/);
    expect(store.size).toBe(1);
    expect(existsSync(path)).toBe(true);
    // No leftover temp file.
    expect(existsSync(path + '.tmp')).toBe(false);

    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data).toHaveLength(1);
    expect(data[0].locator).toBe(locator);
    expect(data[0].names[0].surname).toBe('SMITH');
    expect(data[0].segments[0].carrier).toBe('UA');
  });

  it('round-trips: a second instance over the same file sees prior PNRs', () => {
    const path = join(tmp, 'roundtrip.json');
    const writer = new JsonFilePnrStore(path);
    const locator = writer.commit(makePnr());

    const reader = new JsonFilePnrStore(path);
    expect(reader.size).toBe(1);
    const recovered = reader.get(locator);
    expect(recovered).toBeDefined();
    expect(recovered!.names[0].surname).toBe('SMITH');
    expect(recovered!.segments[0].carrier).toBe('UA');
    expect(recovered!.createdAt).toBeInstanceOf(Date);
  });

  it('findBySurname works after a round-trip', () => {
    const path = join(tmp, 'surname.json');
    const writer = new JsonFilePnrStore(path);
    writer.commit(makePnr());

    const reader = new JsonFilePnrStore(path);
    const matches = reader.findBySurname('SMITH');
    expect(matches).toHaveLength(1);
    expect(matches[0].names[0].passengers[0].firstName).toBe('JOHN');
  });

  it('hydrates accountingLinesHidden Set from the JSON array', () => {
    const path = join(tmp, 'set.json');
    const writer = new JsonFilePnrStore(path);
    const pnr = makePnr();
    pnr.accountingLinesHidden = new Set([1, 3, 5]);
    writer.commit(pnr);

    const reader = new JsonFilePnrStore(path);
    const recovered = [...reader.values()][0];
    expect(recovered.accountingLinesHidden).toBeInstanceOf(Set);
    expect([...recovered.accountingLinesHidden]).toEqual([1, 3, 5]);
  });

  it('logs a warning and starts empty when the file is malformed', () => {
    const path = join(tmp, 'broken.json');
    writeFileSync(path, '{this is not valid json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = new JsonFilePnrStore(path);
    expect(store.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('supports rapid sequential commits without losing entries', () => {
    const path = join(tmp, 'rapid.json');
    const store = new JsonFilePnrStore(path);
    const locators: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pnr = makePnr();
      pnr.names = [{ surname: `SUR${i}`, passengers: [{ firstName: `F${i}` }], count: 1, infant: false }];
      locators.push(store.commit(pnr));
    }
    const reader = new JsonFilePnrStore(path);
    expect(reader.size).toBe(5);
    for (const locator of locators) expect(reader.has(locator)).toBe(true);
  });
});

// vi.spyOn(console, 'warn')
import { vi } from 'vitest';

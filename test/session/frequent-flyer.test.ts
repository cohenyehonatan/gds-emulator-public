import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('frequent flyer parsing', async () => {
  it('parses add / change / delete', async () => {
    const add = parseEntry('FFBA2345678-2.2');
    expect(add.kind).toBe('frequent_flyer');
    if (add.kind === 'frequent_flyer') {
      expect(add).toMatchObject({ operation: 'add', carrier: 'BA', number: '2345678' });
      expect(add.nameRef).toEqual({ item: 2, passenger: 2 });
    }
    const chg = parseEntry('FF1¤CY123456-1.2');
    if (chg.kind === 'frequent_flyer') expect(chg).toMatchObject({ operation: 'change', line: 1, carrier: 'CY' });
    const del = parseEntry('FF1¤');
    if (del.kind === 'frequent_flyer') expect(del).toMatchObject({ operation: 'delete', line: 1 });
  });
});

describe('frequent flyer in the work area', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
    await host.process('-SMITH/JOHN MR', wa);
  });

  it('adds, changes, and deletes a frequent-flyer number', async () => {
    await host.process('FFBA2345678-1.1', wa);
    expect(wa.pnr.frequentFlyers[0]).toMatchObject({ carrier: 'BA', number: '2345678' });
    expect(await host.process('*FF', wa)).toContain('1.BA 2345678 -1.1');

    await host.process('FF1¤CY999000-1.1', wa); // change
    expect(wa.pnr.frequentFlyers[0]).toMatchObject({ carrier: 'CY', number: '999000' });

    expect(await host.process('FF1¤', wa)).toBe('NO FREQUENT FLYER'); // delete the only one
    expect(wa.pnr.frequentFlyers).toHaveLength(0);
  });

  it('rejects a frequent flyer referencing a non-existent passenger', async () => {
    expect(await host.process('FFBA2345678-2.1', wa)).toBe('FORMAT'); // only one name
    expect(wa.pnr.frequentFlyers).toHaveLength(0);
  });

  it('keeps the frequent flyer through commit and retrieval', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('FFAA9988776-1.1', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    expect(await host.process(`*${locator}`, wa)).toContain('AA 9988776');
  });
});

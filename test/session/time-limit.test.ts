import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('time-limit / option field (8)', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  it('parses the option entry', async () => {
    const e = parseEntry('86P/17JUN');
    expect(e.kind).toBe('time_limit');
    if (e.kind === 'time_limit') expect(e.text).toBe('6P/17JUN');
  });

  it('stores the option field and overwrites on re-entry', async () => {
    await host.process('86P/17JUN', wa);
    expect(wa.pnr.optionField).toBe('6P/17JUN');
    await host.process('86P/20JUN', wa); // overwrite
    expect(wa.pnr.optionField).toBe('6P/20JUN');
  });

  it('shows the option line in the PNR display', async () => {
    await host.process('115JUNJFKLAX', wa);
    await host.process('01Y1', wa);
    await host.process('86P/17JUN', wa);
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('9305-555-1212-H', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('6P', wa);
    const locator = await host.process('E', wa);
    expect(await host.process(`*${locator}`, wa)).toContain('OPTION - 6P/17JUN');
  });
});

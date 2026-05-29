import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('divide parsing', async () => {
  it('parses D<item>, D<item>.<pax>, and multiple', async () => {
    const d1 = parseEntry('D1');
    if (d1.kind === 'divide') expect(d1.refs).toEqual([{ item: 1, passenger: undefined }]);
    const d21 = parseEntry('D2.1');
    if (d21.kind === 'divide') expect(d21.refs).toEqual([{ item: 2, passenger: 1 }]);
    const multi = parseEntry('D3.1*4.1');
    if (multi.kind === 'divide') expect(multi.refs).toEqual([{ item: 3, passenger: 1 }, { item: 4, passenger: 1 }]);
  });
});

describe('divide / file a PNR', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
    await host.process('115JUNJFKLAX', wa);
    await host.process('02Y2', wa); // 2 seats
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('-JONES/MARY MS', wa);
  });

  it('divides a name field into a new pending PNR and files it', async () => {
    const divided = await host.process('D2', wa);
    expect(divided).toContain('JONES/MARY MS');
    expect(divided).toContain('DIVIDED FROM');
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['JONES']); // work area shows the new PNR
    expect(wa.dividedOriginal!.names.map((n) => n.surname)).toEqual(['SMITH']);

    const filed = await host.process('F', wa);
    const m = /PNR FILED ([A-Z]{6})/.exec(filed);
    expect(m).not.toBeNull();
    expect(host.context.backend.pnrs.has(m![1])).toBe(true); // new PNR committed
    expect(wa.pnr.names.map((n) => n.surname)).toEqual(['SMITH']); // original restored
    expect(filed).toContain(`DIVIDED TO ${m![1]}`);
    expect(wa.dividedOriginal).toBeUndefined();
  });

  it('divides one passenger out of a multi-passenger name item', async () => {
    const w = host.newWorkArea();
    await host.process('SI*4321', w);
    await host.process('-2MURRAY/FRED MR/HANA MRS', w);
    await host.process('D1.2', w); // divide HANA (passenger 2)
    expect(w.pnr.names[0].passengers.map((p) => p.firstName)).toEqual(['HANA']); // new PNR
    expect(w.dividedOriginal!.names[0].passengers.map((p) => p.firstName)).toEqual(['FRED']);
  });

  it('refuses to divide all names, and rejects File with no divide', async () => {
    const w = host.newWorkArea();
    await host.process('SI*4321', w);
    await host.process('-SMITH/JOHN MR', w);
    expect(await host.process('D1', w)).toContain('CANNOT DIVIDE ALL');
    expect(await host.process('F', w)).toContain('NO DIVIDED PNR');
  });
});

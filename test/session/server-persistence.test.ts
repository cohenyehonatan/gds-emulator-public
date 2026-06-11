/**
 * Server persistence: committed PNRs survive a host restart when the
 * backend uses JsonFilePnrStore (the start:server default), and the
 * HELP STORE topic reports the live store status.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { GdsHost } from '../../src/session/gds-host.js';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { AmadeusDialect } from '../../src/dialects/amadeus/index.js';
import { EmulatedBackend } from '../../src/backends/backend.js';
import { JsonFilePnrStore } from '../../src/store/json-file-pnr-store.js';
import { JsonFileQueues } from '../../src/store/json-file-queues.js';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const FILE = join(tmpdir(), `gds-persist-${process.pid}.json`);

afterEach(() => {
  try { unlinkSync(FILE); } catch { /* */ }
});

function fileHost() {
  return new GdsHost({
    port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'A0UC',
    backend: new EmulatedBackend({ pnrStore: new JsonFilePnrStore(FILE) }),
  });
}

async function commitPnr(h: GdsHost): Promise<string> {
  const wa = h.newWorkArea();
  await h.process('SON/Z01UC', wa);
  await h.process('A01JULCDGJFK', wa);
  await h.process('N1F1', wa);
  await h.process('N.COHEN/YEHONATAN MR', wa);
  await h.process('P.19293177108', wa);
  await h.process('R.ONLINE', wa);
  await h.process('T.TAU/30JUN', wa);
  const er = await h.process('ER', wa);
  return /^([A-Z0-9]{6})\b/.exec(er)![1];
}

describe('restart survival', () => {
  it('a PNR committed by one host retrieves from a fresh host on the same file', async () => {
    const locator = await commitPnr(fileHost());
    const h2 = fileHost(); // the "restart"
    const wa = h2.newWorkArea();
    await h2.process('SON/Z01UC', wa);
    const resp = await h2.process(`*${locator}`, wa);
    expect(resp).toContain('COHEN/YEHONATAN MR');
    expect(resp).toContain('AF 002');
    // Retrieve-by-name survives too.
    const wa2 = h2.newWorkArea();
    await h2.process('SON/Z01UC', wa2);
    expect(await h2.process('*-COHEN', wa2)).toContain(locator);
  });
});

describe('HELP STORE', () => {
  it('reports the file store, count, recent locators, and retrieval hint', async () => {
    const h = fileHost();
    const locator = await commitPnr(h);
    const wa = h.newWorkArea();
    const resp = await h.process('HELP STORE', wa);
    expect(resp).toContain(`PNR STORE: JSON FILE ${FILE} (SURVIVES RESTART)`);
    expect(resp).toContain('COMMITTED PNRS: 1');
    expect(resp).toContain(`${locator}  COHEN/YEHONATAN  AF002 01JUL CDGJFK`);
    expect(resp).toContain('RETRIEVE: *<locator>');
  });

  it('reports ephemeral for the in-memory default; HE STORE works on Amadeus', async () => {
    const g = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'AB' });
    expect(await g.process('HELP STORE', g.newWorkArea())).toContain('IN-MEMORY (EPHEMERAL');
    const a = new GdsHost({ port: 0, logLevel: 'error', dialect: new AmadeusDialect(), pcc: 'A0UC' });
    expect(await a.process('HE STORE', a.newWorkArea())).toContain('PNR STORE:');
  });
});

describe('queue persistence', () => {
  const QFILE = FILE.replace(/\.json$/, '') + '.queues.json';
  afterEach(() => {
    try { unlinkSync(QFILE); } catch { /* */ }
  });

  function persistentHost() {
    return new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'A0UC',
      backend: new EmulatedBackend({
        pnrStore: new JsonFilePnrStore(FILE),
        queues: new (JsonFileQueues)(QFILE),
      }),
    });
  }

  it('a queue placement survives a restart alongside its PNR', async () => {
    const h1 = persistentHost();
    const locator = await commitPnr(h1);
    const wa = h1.newWorkArea();
    await h1.process('SON/Z01UC', wa);
    await h1.process(`*${locator}`, wa);
    expect(await h1.process('QEB/35', wa)).toContain('35');

    const h2 = persistentHost(); // restart
    const wa2 = h2.newWorkArea();
    await h2.process('SON/Z01UC', wa2);
    const resp = await h2.process('Q/35', wa2);
    expect(resp).toContain('COHEN/YEHONATAN MR'); // pulled off the queue
    const status = await h2.process('HELP STORE', wa2);
    expect(status).toContain(`QUEUE STORE: JSON FILE ${QFILE} (SURVIVES RESTART)`);
    expect(status).toMatch(/QUEUED: \d+ ON \d+ QUEUE\(S\)/);
  });
});

describe('live-backend shadow persistence', () => {
  it('the shadow PnrStore accepts a file store — surname index survives a "restart"', async () => {
    const { LiveTravelportBackend } = await import('../../src/backends/live-travelport-backend.js');
    const sfile = FILE.replace(/\.json$/, '') + '.shadow.json';
    const creds = { clientId: 'x', clientSecret: 'x', username: 'x', password: 'x' };
    const b1 = new LiveTravelportBackend(creds, { pnrStore: new JsonFilePnrStore(sfile) });
    const { Pnr } = await import('../../src/models/pnr.js');
    const pnr = new Pnr();
    pnr.locator = 'GZW1CS';
    pnr.names.push({ surname: 'COHEN', passengers: [{ firstName: 'YEHONATAN' }], count: 1, infant: false });
    b1.pnrs.commit(pnr);
    // The "restart": a fresh backend over the same shadow file.
    const b2 = new LiveTravelportBackend(creds, { pnrStore: new JsonFilePnrStore(sfile) });
    expect(b2.pnrs.get('GZW1CS')?.names[0].surname).toBe('COHEN');
    expect(b2.pnrs.findBySurname('COHEN')).toHaveLength(1);
    const { unlinkSync } = await import('fs');
    try { unlinkSync(sfile); } catch { /* */ }
  });
});

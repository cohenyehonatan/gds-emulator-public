import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { parseGalileoEntry } from '../../src/dialects/galileo/parser.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo FD cryptic parsing', () => {
  it('FDLONPAR — origin/destination, no date', () => {
    const r = parseGalileoEntry('FDLONPAR');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.origin).toBe('LON');
      expect(r.destination).toBe('PAR');
      expect(r.date).toBeUndefined();
      expect(r.carriers).toBeUndefined();
    }
  });

  it('FD14AUGLONPAR — date at start (Mini Guide verbatim)', () => {
    const r = parseGalileoEntry('FD14AUGLONPAR');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.origin).toBe('LON');
      expect(r.destination).toBe('PAR');
      expect(r.date?.day).toBe(14);
      expect(r.date?.month).toBe(7); // AUG = 7 (0-based)
    }
  });

  it('FDLONPAR14AUG — date at end', () => {
    const r = parseGalileoEntry('FDLONPAR14AUG');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.origin).toBe('LON');
      expect(r.destination).toBe('PAR');
      expect(r.date?.day).toBe(14);
    }
  });

  it('FDLON14AUGPAR — date in middle', () => {
    const r = parseGalileoEntry('FDLON14AUGPAR');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.origin).toBe('LON');
      expect(r.destination).toBe('PAR');
      expect(r.date?.day).toBe(14);
    }
  });

  it('FD14AUGLONPAR/BA — single carrier filter', () => {
    const r = parseGalileoEntry('FD14AUGLONPAR/BA');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.carriers).toEqual(['BA']);
    }
  });

  it('FD14AUGLONNYC/BA/UA — multi-carrier filter', () => {
    const r = parseGalileoEntry('FD14AUGLONNYC/BA/UA');
    expect(r.kind).toBe('fare_display');
    if (r.kind === 'fare_display') {
      expect(r.carriers).toEqual(['BA', 'UA']);
    }
  });

  it('rejects FDPAR (current-city default not modelled)', () => {
    expect(() => parseGalileoEntry('FDPAR')).toThrow();
  });

  it('rejects more than 3 carriers (REST docs limit)', () => {
    expect(() => parseGalileoEntry('FDLONPAR/BA/UA/AA/DL')).toThrow();
  });

  it('rejects malformed carrier code', () => {
    expect(() => parseGalileoEntry('FDLONPAR/B1')).toThrow();
  });
});

describe('Galileo live FD — POST /11/air/faredisplay/fares', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const fareDisplayResp = () =>
    new Response(
      JSON.stringify({
        FareDisplayResponse: {
          transactionId: 'abc',
          fareDisplay: [
            {
              from: { value: 'LON' },
              to: { value: 'PAR' },
              departureDate: '2026-08-14',
              listCurrency: { value: 'GBP' },
              fare: [
                {
                  sequence: 1,
                  carrier: 'BA',
                  amount: { value: 250 },
                  fareBasisCode: 'YEE3M',
                  bookingClass: 'Y',
                  oneWayInd: true,
                },
                {
                  sequence: 2,
                  carrier: 'BA',
                  amount: { value: 450 },
                  fareBasisCode: 'YEE6M',
                  bookingClass: 'Y',
                  roundTripInd: true,
                },
              ],
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x',
      clientSecret: 'y',
      username: 'z',
      password: 'w',
    });
    host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
      backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('FD14AUGLONPAR POSTs canonical FareDisplayQueryRequest', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp());

    const resp = await host.process('FD14AUGLONPAR', wa);
    expect(resp).toContain('LONPAR');
    expect(resp).toContain('GBP');
    expect(resp).toContain('BA');
    expect(resp).toContain('250.00');
    expect(resp).toContain('YEE3M');

    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toContain('/air/faredisplay/fares');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.FareDisplayQueryRequest?.from?.value).toBe('LON');
    expect(body.FareDisplayQueryRequest?.to?.value).toBe('PAR');
    expect(body.FareDisplayQueryRequest?.departureDate).toMatch(/-08-14$/);
  });

  it('FDLONPAR (no date) POSTs without departureDate', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp());

    await host.process('FDLONPAR', wa);

    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.FareDisplayQueryRequest?.departureDate).toBeUndefined();
    expect(body.FareDisplayQueryRequest?.from?.value).toBe('LON');
    expect(body.FareDisplayQueryRequest?.to?.value).toBe('PAR');
  });

  it('FD14AUGLONPAR/BA/UA passes the carrier filter in the body', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(fareDisplayResp());

    await host.process('FD14AUGLONPAR/BA/UA', wa);

    const [, init] = fetchSpy.mock.calls[1];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.FareDisplayQueryRequest?.carrier).toEqual(['BA', 'UA']);
  });

  it('Empty fareDisplay result renders NO FARES <orig><dest>', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ FareDisplayResponse: { fareDisplay: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const resp = await host.process('FDLONPAR', wa);
    expect(resp).toBe('NO FARES LONPAR');
  });

  it('5xx surfaces LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response('"down"', { status: 503, statusText: 'Service Unavailable' })
      );

    const resp = await host.process('FDLONPAR', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('503');
  });
});

describe('Galileo emulated FD — synthesize from inventory', () => {
  it('emulated FDJFKLAX synthesizes rows from the inventory tariff', async () => {
    const emulatedHost = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    const resp = await emulatedHost.process('FDJFKLAX', ewa);
    // At minimum should include the FARE DISPLAY header for the O&D.
    expect(resp).toContain('JFKLAX');
  });
});

/**
 * Live retrieve must MERGE the local shadow's local-only fields, not
 * clobber them. Dogfooding find (2026-06-12): the mirror-commit in
 * retrieveGalileoLive overwrote the stored PNR with the history-less
 * mapped one — destroying the only copy of the mutation log (v11 has
 * no change-log endpoint). GZWFTM's entire build history vanished on
 * its first retrieve; *H silently fell back to current-state view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import { Pnr } from '../../src/models/pnr.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('live retrieve preserves the shadow’s local-only fields', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let backend: LiveTravelportBackend;
  let wa: WorkArea;

  const tokenResp = () =>
    new Response(JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const reservationResp = (loc: string) =>
    new Response(
      JSON.stringify({
        Reservation: {
          Identifier: { value: loc },
          Traveler: [{ PersonName: { Given: 'YEHONATAN', Surname: 'COHEN' } }],
          AirReservation: {
            Flights: [
              {
                carrier: 'DL',
                number: '1332',
                Departure: { location: 'MIA', time: '2026-07-01T08:00:00Z' },
                Arrival: { location: 'ATL', time: '2026-07-01T10:00:00Z' },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    backend = new LiveTravelportBackend({ clientId: 'x', clientSecret: 'y', username: 'z', password: 'w' });
    host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend });
    wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);

    // Seed the shadow as the BUILD session's commit would have left it.
    const shadow = new Pnr();
    shadow.locator = 'GZWFTM';
    shadow.names = [{ count: 1, surname: 'COHEN', passengers: [{ firstName: 'YEHONATAN' }] }];
    shadow.history = [
      { timestamp: new Date('2026-06-12T08:13:33Z'), text: 'NAME ADD COHEN/YEHONATAN', code: 'AN' },
      { timestamp: new Date('2026-06-12T08:10:28Z'), text: 'SELL 1 DL1332E DL1851E', code: 'AS' },
    ];
    shadow.fopField = 'S';
    shadow.remarks.push({ type: 'document', text: 'AC-AAA.IBM54' });
    backend.pnrs.commit(shadow);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('*<locator> keeps history + fopField + document remarks; *H shows the log', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(reservationResp('GZWFTM'));
    await host.process('*GZWFTM', wa);

    const h = await host.process('*H', wa);
    expect(h).toContain('NAME ADD COHEN/YEHONATAN'); // not the current-state fallback
    expect(h).toMatch(/AS .*SELL 1 DL1332E/);
    expect(await host.process('*FOP', wa)).toBe('F. S');
    expect(await host.process('*DI', wa)).toBe('DI. 1 AC-AAA.IBM54');

    // The mirror-commit no longer clobbers the store either.
    expect(backend.pnrs.get('GZWFTM')?.history).toHaveLength(2);
  });

  it('vendor-truth fields still come from the live response', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResp()).mockResolvedValueOnce(reservationResp('GZWFTM'));
    const r = await host.process('*GZWFTM', wa);
    expect(r).toContain('DL 1332'); // segments are the MAPPED ones
  });
});

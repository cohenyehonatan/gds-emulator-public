import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live N. — capture traveler UUID from addTraveler response', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const searchResp = () =>
    new Response(
      JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-001' },
                ProductBrandOptions: [
                  {
                    Flight: [
                      {
                        carrier: 'UA',
                        number: 1234,
                        Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                        Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                      },
                    ],
                    ProductBrandOffering: [
                      { Product: [{ productRef: 'p0' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-T' } } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  const ok = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const travelerResp = (uuid: string) =>
    new Response(
      JSON.stringify({
        Traveler: [
          {
            Identifier: { authority: 'Travelport', value: uuid },
            PersonName: { Given: 'JOHN', Surname: 'SMITH' },
          },
        ],
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
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

  // After the 2026-06-06 refactor, addTraveler is deferred until BOTH
  // a name AND a phone are present (Travelport pre-prod rejects
  // commit on Travelers without embedded Telephone[]). Tests post
  // P. after the N. cryptic and mock an extra ok() for the
  // addPrimaryContact call that fires from the same handler.
  it('N. + P. captures the traveler UUID into wa.liveTravelerIds', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())                       // addOffer
      .mockResolvedValueOnce(travelerResp('uuid-john')) // addTraveler (fires at P.)
      .mockResolvedValueOnce(ok());                       // addPrimaryContact

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    expect(wa.liveTravelerIds).toBeUndefined(); // not posted yet — no phone
    await host.process('P.LON*02012345678', wa);

    expect(wa.liveTravelerIds).toEqual(['uuid-john']);
  });

  it('two N. entries then one P. batch via /travelers/list', async () => {
    // Batch response carries both UUIDs in the ReferenceList wrapper.
    const batchResp = () =>
      new Response(
        JSON.stringify({
          TravelerListResponse: {
            ReferenceList: [
              {
                Traveler: [
                  { Identifier: { value: 'uuid-1' } },
                  { Identifier: { value: 'uuid-2' } },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())            // addOffer
      .mockResolvedValueOnce(batchResp())     // addTravelers (fires at P.)
      .mockResolvedValueOnce(ok());            // addPrimaryContact

    await host.process('A27JUNDENFRA', wa);
    await host.process('N2Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('N.SMITH/JANE MRS', wa);
    expect(wa.liveTravelerIds).toBeUndefined(); // not posted yet
    await host.process('P.LON*02012345678', wa);

    expect(wa.liveTravelerIds).toEqual(['uuid-1', 'uuid-2']);
  });

  it('a response without an Identifier still appends an empty slot', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Traveler: [{ PersonName: { Given: 'JOHN' } }] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(ok()); // addPrimaryContact

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);

    expect(wa.liveTravelerIds).toEqual(['']); // pushed empty placeholder
  });

  it('IGNORE clears liveTravelerIds alongside the rest of the live workbench state', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResp())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(travelerResp('uuid-john'))
      .mockResolvedValueOnce(ok())                                 // addPrimaryContact
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // workbench DELETE

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    expect(wa.liveTravelerIds).toEqual(['uuid-john']);

    await host.process('I', wa);
    expect(wa.liveTravelerIds).toBeUndefined();
    expect(wa.liveWorkbenchId).toBeUndefined();
  });
});

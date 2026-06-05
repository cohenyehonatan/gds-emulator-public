import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Full live build → commit round-trip. Sequence:
 *   SON/ZHA → A → N1Y1 → N.SMITH/JOHN MR → P.<phone> → T.<tk> → R.<rcv> → E
 * Fetch mocked end-to-end. Asserts every REST call's URL + body shape
 * against references/galileo/Travelport-JSON-Air-v11-API-Spec.md.
 */

describe('Galileo live build → commit (mocked fetch chain)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function searchResponse(): Response {
    return new Response(
      JSON.stringify({
        CatalogProductOfferingsResponse: {
          CatalogProductOfferings: {
            Identifier: { value: 'SRCH-FIXTURE' },
            CatalogProductOffering: [
              {
                Identifier: { value: 'OFF-7K9S-001' },
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
  }

  function createWorkbenchResponse(id: string): Response {
    return new Response(
      JSON.stringify({ ReservationWorkbench: { Identifier: { value: id } } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function addOfferResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  function addTravelerResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  function addPrimaryContactResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  function commitResponse(locator: string): Response {
    return new Response(
      JSON.stringify({
        Receipt: [{ Confirmation: { Locator: { value: locator, authority: 'Travelport' } } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);  // local, no fetch
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('full build flow: search → sell → name → phone → tkt → rcv → commit returns locator', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())                  // 1. OAuth
      .mockResolvedValueOnce(searchResponse())                 // 2. A27JUNDENFRA
      .mockResolvedValueOnce(createWorkbenchResponse('WB-X'))  // 3. N1Y1 → createWorkbench
      .mockResolvedValueOnce(addOfferResponse())               // 4. N1Y1 → addOffer
      .mockResolvedValueOnce(addTravelerResponse())            // 5. N.SMITH/JOHN MR
      .mockResolvedValueOnce(addPrimaryContactResponse())      // 6. P.LON*...
      .mockResolvedValueOnce(commitResponse('ABC123'));        // 7. E → commit

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('E', wa);
    expect(resp).toBe('ABC123');

    expect(fetchSpy).toHaveBeenCalledTimes(7);

    // Verify the addTraveler call's URL + body:
    const [travelerUrl, travelerInit] = fetchSpy.mock.calls[4];
    expect(travelerUrl).toContain('/reservationworkbench/WB-X/travelers');
    const tbody = JSON.parse((travelerInit?.body as string) ?? '{}');
    // Single-pax `/travelers` uses object shape, not array (per
    // APIRef_TravelerAdd.htm). Multi-pax uses array on `/travelers/list`.
    expect(tbody.Traveler?.PersonName?.Surname).toBe('SMITH');
    expect(tbody.Traveler?.PersonName?.Given).toContain('JOHN');
    expect(tbody.Traveler?.passengerTypeCode).toBe('ADT');

    // Verify the addPrimaryContact call's URL + body:
    const [pcUrl, pcInit] = fetchSpy.mock.calls[5];
    expect(pcUrl).toContain('/primarycontact/reservationworkbench/WB-X/primarycontacts');
    const pcBody = JSON.parse((pcInit?.body as string) ?? '{}');
    expect(pcBody.PrimaryContact?.[0]?.Telephone?.[0]?.phoneNumber).toBe('LON*02012345678');

    // Verify the commit call's URL + body:
    const [commitUrl, commitInit] = fetchSpy.mock.calls[6];
    expect(commitUrl).toContain('/air/book/reservation/reservations/WB-X');
    const cbody = JSON.parse((commitInit?.body as string) ?? '{}');
    expect(cbody.ReservationQueryCommitReservation?.enableTwoStepCommitInd).toBe(false);
  });

  it('ER (end + retrieve) returns the rendered BF with the live locator', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-X'))
      .mockResolvedValueOnce(addOfferResponse())
      .mockResolvedValueOnce(addTravelerResponse())
      .mockResolvedValueOnce(addPrimaryContactResponse())
      .mockResolvedValueOnce(commitResponse('DEF456'));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('ER', wa);
    expect(resp).toContain('DEF456');     // header carries the live locator
    expect(resp).toContain('SMITH/JOHN'); // BF rendered
    expect(resp).toContain('UA');         // segment from live availability
  });

  it('after commit, *<locator> retrieve goes live (TripServices GET) and renders the BF', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-X'))
      .mockResolvedValueOnce(addOfferResponse())
      .mockResolvedValueOnce(addTravelerResponse())
      .mockResolvedValueOnce(addPrimaryContactResponse())
      .mockResolvedValueOnce(commitResponse('GHI789'))
      // Live retrieve response — minimal but mappable:
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Reservation: {
              Identifier: { value: 'GHI789' },
              Traveler: [{ PersonName: { Given: 'JOHN', Surname: 'SMITH' } }],
              AirReservation: {
                Flights: [
                  {
                    carrier: 'UA',
                    number: '1234',
                    Departure: { location: 'DEN', time: '2026-06-27T08:00:00Z' },
                    Arrival: { location: 'FRA', time: '2026-06-28T07:30:00Z' },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    await host.process('E', wa);
    expect(wa.liveWorkbenchId).toBeUndefined();  // workbench consumed

    const resp = await host.process('*GHI789', wa);
    expect(resp).toContain('GHI789');
    expect(resp).toContain('SMITH/JOHN');
    // Verify the live retrieve URL was hit:
    expect(fetchSpy).toHaveBeenCalledTimes(8);
    const [retrieveUrl] = fetchSpy.mock.calls[7];
    expect(retrieveUrl).toContain('/air/book/reservation/reservations/GHI789');
  });

  it('name without prior sell still works — workbench is created on first name', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-Y'))  // createWorkbench on first name
      .mockResolvedValueOnce(addTravelerResponse());           // addTraveler

    await host.process('N.SMITH/JOHN MR', wa);
    expect(wa.liveWorkbenchId).toBe('WB-Y');
    expect(wa.pnr.names.length).toBe(1);
  });

  it('commit failure surfaces as LIVE BACKEND ERROR', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-X'))
      .mockResolvedValueOnce(addOfferResponse())
      .mockResolvedValueOnce(addTravelerResponse())
      .mockResolvedValueOnce(addPrimaryContactResponse())
      .mockResolvedValueOnce(new Response('"workbench expired"', {
        status: 410, statusText: 'Gone',
      }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('E', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('410');
    // workbench id NOT cleared — agent could retry from same workbench
    // if they got lucky, though in practice 410 means it's gone.
    expect(wa.liveWorkbenchId).toBe('WB-X');
  });

  it('commit response without a locator throws — defensive parsing', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(searchResponse())
      .mockResolvedValueOnce(createWorkbenchResponse('WB-X'))
      .mockResolvedValueOnce(addOfferResponse())
      .mockResolvedValueOnce(addTravelerResponse())
      .mockResolvedValueOnce(addPrimaryContactResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ noLocatorHere: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

    await host.process('A27JUNDENFRA', wa);
    await host.process('N1Y1', wa);
    await host.process('N.SMITH/JOHN MR', wa);
    await host.process('P.LON*02012345678', wa);
    await host.process('T.TAU/10JUN', wa);
    await host.process('R.AGT', wa);
    const resp = await host.process('E', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('missing locator');
  });

  it('commit refuses with LIVE WORKBENCH MISSING when nothing was built', async () => {
    // No prior live calls — but the user still needs the mandatory fields to
    // hit our PNR-shape check, so we manually populate them.
    wa.pnr.segments.push({
      segmentNumber: 1, carrier: 'UA', flightNumber: '1', bookingClass: 'Y',
      date: '27JUN', dayOfWeek: '?', dayOfWeekNum: 0,
      origin: 'DEN', destination: 'FRA', status: 'SS', seats: 1,
      departTime: '0800', arriveTime: '0730',
    });
    wa.pnr.names.push({ surname: 'X', passengers: [{ firstName: 'Y' }], count: 1, infant: false });
    wa.pnr.phones.push({ number: 'p' });
    wa.pnr.ticketing = 'T';
    wa.pnr.receivedFrom = 'R';
    // (No liveWorkbenchId — the segments / names were planted manually.)
    const resp = await host.process('E', wa);
    expect(resp).toBe('LIVE WORKBENCH MISSING');
  });
});

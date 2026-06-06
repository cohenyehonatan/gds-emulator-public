import { describe, it, expect } from 'vitest';
import { mapCatalogProductOfferings } from '../../src/backends/travelport-mapper.js';

/**
 * Synthetic fixtures shaped after the documented JSON Air v11
 * CatalogProductOfferingsResponse. A real fixture (saved from the
 * 2026-05-27 spike against 7K9S) would replace these; without one
 * we test against the published-schema interpretation.
 */
const NONSTOP_FIXTURE = {
  CatalogProductOfferingsResponse: {
    CatalogProductOfferings: {
      CatalogProductOffering: [
        {
          Departure: 'DEN',
          Arrival: 'FRA',
          DepartureDate: '2026-06-27',
          ProductBrandOptions: [
            {
              Flight: [
                {
                  carrier: 'UA',
                  number: 1234,
                  Departure: { location: 'DEN', time: '2026-06-27T08:00:00.000-06:00' },
                  Arrival: { location: 'FRA', time: '2026-06-28T07:30:00.000+02:00' },
                  equipment: '777',
                },
              ],
              ProductBrandOffering: [
                {
                  Brand: { brandName: 'Economy' },
                  FareDetail: [
                    { FareBasis: 'YPRO', BookingCode: { code: 'Y', count: 9 } },
                  ],
                },
                {
                  Brand: { brandName: 'Business' },
                  FareDetail: [
                    { FareBasis: 'JPRO', BookingCode: { code: 'J', count: 4 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

const CONNECTION_FIXTURE = {
  CatalogProductOfferingsResponse: {
    CatalogProductOfferings: {
      CatalogProductOffering: [
        {
          ProductBrandOptions: [
            {
              Flight: [
                {
                  carrier: 'LH',
                  number: 401,
                  Departure: { location: 'JFK', time: '2026-06-27T18:30:00.000-04:00' },
                  Arrival: { location: 'FRA', time: '2026-06-28T08:30:00.000+02:00' },
                  equipment: '748',
                },
                {
                  carrier: 'LH',
                  number: 1056,
                  Departure: { location: 'FRA', time: '2026-06-28T10:30:00.000+02:00' },
                  Arrival: { location: 'CDG', time: '2026-06-28T12:00:00.000+02:00' },
                  equipment: '320',
                },
              ],
              ProductBrandOffering: [
                {
                  FareDetail: [
                    { FareBasis: 'YPRO', BookingCode: { code: 'Y', count: 6 } },
                    { FareBasis: 'YPRO', BookingCode: { code: 'Y', count: 9 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

describe('mapCatalogProductOfferings — nonstop', () => {
  it('maps a single-flight offering to one AvailabilityLine', () => {
    const lines = mapCatalogProductOfferings(NONSTOP_FIXTURE);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      line: 1,
      carrier: 'UA',
      flightNumber: '1234',
      origin: 'DEN',
      destination: 'FRA',
      departTime: '0800',
      arriveTime: '0730',
      equipment: '777',
    });
  });

  it('aggregates booking classes from every ProductBrandOffering', () => {
    const lines = mapCatalogProductOfferings(NONSTOP_FIXTURE);
    expect(lines[0].classes).toEqual({ Y: 9, J: 4 });
  });

  it('passes through the date / dow tokens from MapOptions', () => {
    const lines = mapCatalogProductOfferings(NONSTOP_FIXTURE, {
      date: '27JUN',
      dayOfWeekLetter: 'F',
      dayOfWeekNum: 5,
    });
    expect(lines[0].date).toBe('27JUN');
    expect(lines[0].dayOfWeek).toBe('F');
    expect(lines[0].dayOfWeekNum).toBe(5);
  });
});

describe('mapCatalogProductOfferings — connection', () => {
  it('emits one AvailabilityLine per flight, grouped by connectionGroup', () => {
    const lines = mapCatalogProductOfferings(CONNECTION_FIXTURE);
    expect(lines.length).toBe(2);
    expect(lines[0].carrier).toBe('LH');
    expect(lines[0].flightNumber).toBe('401');
    expect(lines[1].flightNumber).toBe('1056');
    expect(lines[0].connectionGroup).toBe(1);
    expect(lines[1].connectionGroup).toBe(1);
    expect(lines[0].legIndex).toBe(0);
    expect(lines[1].legIndex).toBe(1);
  });
});

describe('mapCatalogProductOfferings — vendorRef capture', () => {
  const FIXTURE_WITH_IDS = {
    CatalogProductOfferingsResponse: {
      CatalogProductOfferings: {
        CatalogProductOffering: [
          {
            Identifier: { value: 'OFF-7K9S-001' },
            ProductBrandOptions: [
              {
                Identifier: { value: 'PRD-001' },
                Flight: [
                  {
                    carrier: 'UA',
                    number: 1234,
                    Departure: { location: 'DEN', time: '2026-06-27T08:00:00.000-06:00' },
                    Arrival: { location: 'FRA', time: '2026-06-28T07:30:00.000+02:00' },
                  },
                ],
                ProductBrandOffering: [
                  {
                    Identifier: { value: 'BRD-Y' },
                    FareDetail: [{ FareBasis: 'YPRO', BookingCode: { code: 'Y', count: 9 } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };

  it('attaches vendorRef when the response carries Travelport identifiers', () => {
    const lines = mapCatalogProductOfferings(FIXTURE_WITH_IDS);
    expect(lines[0].vendorRef).toEqual({
      offerId: 'OFF-7K9S-001',
      productId: 'PRD-001',
      brandId: 'BRD-Y',
    });
  });

  it('omits vendorRef when no Identifier values are present', () => {
    const lines = mapCatalogProductOfferings(NONSTOP_FIXTURE);
    expect(lines[0].vendorRef).toBeUndefined();
  });

  it('shares the same vendorRef across legs of a connection', () => {
    const conn = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              Identifier: { value: 'OFF-CONN' },
              ProductBrandOptions: [
                {
                  Identifier: { value: 'PRD-CONN' },
                  Flight: [
                    {
                      carrier: 'LH',
                      number: 401,
                      Departure: { location: 'JFK', time: '2026-06-27T18:30:00.000-04:00' },
                      Arrival: { location: 'FRA', time: '2026-06-28T08:30:00.000+02:00' },
                    },
                    {
                      carrier: 'LH',
                      number: 1056,
                      Departure: { location: 'FRA', time: '2026-06-28T10:30:00.000+02:00' },
                      Arrival: { location: 'CDG', time: '2026-06-28T12:00:00.000+02:00' },
                    },
                  ],
                  ProductBrandOffering: [{ Identifier: { value: 'BRD' } }],
                },
              ],
            },
          ],
        },
      },
    };
    const lines = mapCatalogProductOfferings(conn);
    expect(lines).toHaveLength(2);
    expect(lines[0].vendorRef?.offerId).toBe('OFF-CONN');
    expect(lines[1].vendorRef?.offerId).toBe('OFF-CONN');
  });

  it('tolerates a flat `id` field as a fallback for Identifier.value', () => {
    const flat = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              id: 'flat-offer-id',
              ProductBrandOptions: [
                {
                  Flight: [
                    {
                      carrier: 'AA',
                      number: 100,
                      Departure: { location: 'JFK', time: '2026-06-27T08:00:00Z' },
                      Arrival: { location: 'LAX', time: '2026-06-27T11:00:00Z' },
                    },
                  ],
                  ProductBrandOffering: [],
                },
              ],
            },
          ],
        },
      },
    };
    const lines = mapCatalogProductOfferings(flat);
    expect(lines[0].vendorRef?.offerId).toBe('flat-offer-id');
  });
});

describe('mapCatalogProductOfferings — defensive parsing', () => {
  it('returns [] for an empty response', () => {
    expect(mapCatalogProductOfferings({})).toEqual([]);
    expect(mapCatalogProductOfferings(null)).toEqual([]);
    expect(mapCatalogProductOfferings(undefined)).toEqual([]);
  });

  it('handles a response with the wrapper key missing', () => {
    const noWrapper = NONSTOP_FIXTURE.CatalogProductOfferingsResponse;
    const lines = mapCatalogProductOfferings(noWrapper);
    expect(lines.length).toBe(1);
  });

  it('drops a flight that lacks required fields (carrier / number / Departure / Arrival)', () => {
    const bad = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              ProductBrandOptions: [
                {
                  Flight: [{ carrier: 'X' /* no number, no Departure */ }],
                  ProductBrandOffering: [],
                },
              ],
            },
          ],
        },
      },
    };
    expect(mapCatalogProductOfferings(bad)).toEqual([]);
  });

  it('handles a non-ISO time string by returning empty clock', () => {
    const odd = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              ProductBrandOptions: [
                {
                  Flight: [
                    {
                      carrier: 'AA',
                      number: 100,
                      Departure: { location: 'JFK', time: 'not-a-timestamp' },
                      Arrival: { location: 'LAX', time: '2026-06-27T13:00:00Z' },
                    },
                  ],
                  ProductBrandOffering: [],
                },
              ],
            },
          ],
        },
      },
    };
    const lines = mapCatalogProductOfferings(odd);
    expect(lines[0].departTime).toBe('');
    expect(lines[0].arriveTime).toBe('1300');
  });
});

describe('mapCatalogProductOfferings — flightRefs resolution (pre-prod shape)', () => {
  // VERIFIED 2026-06-06: real Travelport responses don't embed Flight
  // on each ProductBrandOption. They put the FlightDetail records in
  // a response-level ReferenceList[] and each brand option carries
  // flightRefs: ['s17', 's18'] pointing into that table. Mocked
  // fixtures embed Flight directly (a shape we still tolerate).
  it('resolves flightRefs against ReferenceList[].Flight[]', () => {
    const live = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          Identifier: { value: 'SRCH-001' },
          CatalogProductOffering: [
            {
              id: 'o1',
              ProductBrandOptions: [
                {
                  flightRefs: ['s21'],
                  ProductBrandOffering: [
                    { Product: [{ productRef: 'p0' }], FareDetail: [{ BookingCode: { code: 'Y', count: 9 } }] },
                  ],
                },
              ],
            },
          ],
        },
        ReferenceList: [
          {
            '@type': 'ReferenceListFlight',
            Flight: [
              {
                '@type': 'FlightDetail',
                id: 's21',
                carrier: 'FI',
                number: '670',
                equipment: '75W',
                Departure: { location: 'DEN', date: '2026-07-06', time: '16:40:00' },
                Arrival: { location: 'KEF', date: '2026-07-07', time: '06:00:00' },
              },
            ],
          },
        ],
      },
    };
    const lines = mapCatalogProductOfferings(live);
    expect(lines).toHaveLength(1);
    expect(lines[0].carrier).toBe('FI');
    expect(lines[0].flightNumber).toBe('670');
    expect(lines[0].origin).toBe('DEN');
    expect(lines[0].destination).toBe('KEF');
    expect(lines[0].equipment).toBe('75W');
  });

  it('drops flightRefs that don\'t resolve (no row in ReferenceList)', () => {
    const partial = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              id: 'o1',
              ProductBrandOptions: [
                { flightRefs: ['unknown-id'], ProductBrandOffering: [] },
              ],
            },
          ],
        },
        ReferenceList: [{ '@type': 'ReferenceListFlight', Flight: [] }],
      },
    };
    expect(mapCatalogProductOfferings(partial)).toHaveLength(0);
  });

  it('embedded Flight wins over flightRefs (preserves legacy mock fixtures)', () => {
    const mixed = {
      CatalogProductOfferingsResponse: {
        CatalogProductOfferings: {
          CatalogProductOffering: [
            {
              id: 'o1',
              ProductBrandOptions: [
                {
                  flightRefs: ['s99'],
                  Flight: [
                    {
                      carrier: 'UA',
                      number: '1234',
                      Departure: { location: 'DEN', time: '2026-07-06T08:00:00Z' },
                      Arrival: { location: 'FRA', time: '2026-07-07T07:30:00Z' },
                    },
                  ],
                  ProductBrandOffering: [],
                },
              ],
            },
          ],
        },
        ReferenceList: [
          { '@type': 'ReferenceListFlight', Flight: [{ id: 's99', carrier: 'XX' }] },
        ],
      },
    };
    const lines = mapCatalogProductOfferings(mixed);
    expect(lines[0].carrier).toBe('UA'); // embedded — NOT 'XX'
  });
});

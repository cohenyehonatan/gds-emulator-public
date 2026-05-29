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

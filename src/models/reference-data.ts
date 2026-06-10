/**
 * Cross-dialect encode/decode reference data — city/airport and
 * airline names for the Galileo `.CD/.CE/.AD/.AE` and Worldspan
 * `KC//KD//KAC//KAD` families (forms verbatim from the Mini Format
 * Guide help table and the Go! Res manual p.25 respectively; the
 * NAME DATA and response wording are reconstructed for our seeded
 * codes — neither source shows the host's encode/decode screens).
 */

export const AIRPORT_NAMES: Record<string, string> = {
  JFK: 'NEW YORK JFK',
  LAX: 'LOS ANGELES INTL',
  SFO: 'SAN FRANCISCO',
  ORD: 'CHICAGO OHARE',
  DEN: 'DENVER INTL',
  DFW: 'DALLAS FT WORTH',
  LHR: 'LONDON HEATHROW',
  FRA: 'FRANKFURT INTL',
  KEF: 'KEFLAVIK',
  HEL: 'HELSINKI VANTAA',
  BKK: 'BANGKOK SUVARNABHUMI',
  CDG: 'PARIS CH DE GAULLE',
  NCE: 'COTE D AZUR',
};

export const AIRLINE_NAMES: Record<string, string> = {
  AA: 'AMERICAN AIRLINES',
  UA: 'UNITED AIRLINES',
  DL: 'DELTA AIR LINES',
  B6: 'JETBLUE AIRWAYS',
  BA: 'BRITISH AIRWAYS',
  LH: 'LUFTHANSA',
  AF: 'AIR FRANCE',
  FI: 'ICELANDAIR',
  AZ: 'ALITALIA',
  '6X': 'AMADEUS TEST AIRLINE',
};

export function decodeCity(code: string): string | undefined {
  return AIRPORT_NAMES[code];
}

export function encodeCity(name: string): [string, string][] {
  const u = name.toUpperCase();
  return Object.entries(AIRPORT_NAMES).filter(([, n]) => n.includes(u));
}

export function decodeAirline(code: string): string | undefined {
  return AIRLINE_NAMES[code];
}

export function encodeAirline(name: string): [string, string][] {
  const u = name.toUpperCase();
  return Object.entries(AIRLINE_NAMES).filter(([, n]) => n.includes(u));
}

/**
 * Hotel seed for the emulator. Fictional properties across a handful
 * of cities, with multiple chains per city so the chain-filtered HA
 * variants have something to work with.
 *
 * Chain codes mirror real Amadeus convention (HI = Holiday Inn, MC =
 * Marriott Hotels, SI = Sheraton, UI = Hyatt, BW = Best Western, HN =
 * Hilton). Property names + addresses are invented; rates are
 * round-number plausible values not benchmarked to any real market.
 */

import type { HotelProperty } from '../models/hotel.js';

export const HOTEL_SEED: HotelProperty[] = [
  // --- LON (London) ---
  {
    chain: 'HI', property: 'LON', name: 'HOLIDAY INN LONDON KENSINGTON',
    city: 'LON', address: '1 WRIGHTS LANE, KENSINGTON',
    rates: [
      { code: 'RAC', amount: 199, currency: 'GBP', available: 12 },
      { code: 'COR', amount: 169, currency: 'GBP', available: 5 },
      { code: 'AAA', amount: 179, currency: 'GBP', available: 3 },
    ],
  },
  {
    chain: 'MC', property: 'LON', name: 'LONDON MARRIOTT MAYFAIR',
    city: 'LON', address: '140 PARK LANE, MAYFAIR',
    rates: [
      { code: 'RAC', amount: 449, currency: 'GBP', available: 8 },
      { code: 'COR', amount: 379, currency: 'GBP', available: 4 },
    ],
  },
  {
    chain: 'HN', property: 'LON', name: 'HILTON LONDON PADDINGTON',
    city: 'LON', address: '146 PRAED ST, PADDINGTON',
    rates: [
      { code: 'RAC', amount: 219, currency: 'GBP', available: 20 },
      { code: 'COR', amount: 199, currency: 'GBP', available: 8 },
    ],
  },
  // --- MAD (Madrid) ---
  {
    chain: 'SI', property: 'MAD', name: 'SHERATON MADRID MIRASIERRA',
    city: 'MAD', address: 'ALFREDO MARQUERIE 43',
    rates: [
      { code: 'RAC', amount: 230, currency: 'EUR', available: 15 },
      { code: 'GOV', amount: 195, currency: 'EUR', available: 5 },
    ],
  },
  {
    chain: 'HI', property: 'MAD', name: 'HOLIDAY INN MADRID PIRAMIDES',
    city: 'MAD', address: 'PASEO DE LAS ACACIAS 40',
    rates: [
      { code: 'RAC', amount: 145, currency: 'EUR', available: 22 },
      { code: 'COR', amount: 125, currency: 'EUR', available: 8 },
    ],
  },
  // --- ZRH (Zurich) ---
  {
    chain: 'UI', property: 'TIE', name: 'PARK HYATT ZURICH',
    city: 'ZRH', address: 'BEETHOVENSTRASSE 21',
    rates: [
      { code: 'RAC', amount: 680, currency: 'CHF', available: 6 },
      { code: 'COR', amount: 590, currency: 'CHF', available: 3 },
    ],
  },
  {
    chain: 'UI', property: 'AMB', name: 'HYATT REGENCY ZURICH AIRPORT',
    city: 'ZRH', address: 'POSTFACH 200, ZURICH-FLUGHAFEN',
    rates: [
      { code: 'RAC', amount: 420, currency: 'CHF', available: 18 },
      { code: 'COR', amount: 360, currency: 'CHF', available: 10 },
    ],
  },
  // --- NYC (New York) ---
  {
    chain: 'MC', property: 'NYC', name: 'NEW YORK MARRIOTT MARQUIS',
    city: 'NYC', address: '1535 BROADWAY, TIMES SQUARE',
    rates: [
      { code: 'RAC', amount: 389, currency: 'USD', available: 25 },
      { code: 'COR', amount: 329, currency: 'USD', available: 12 },
    ],
  },
  {
    chain: 'HN', property: 'NYC', name: 'HILTON NEW YORK MIDTOWN',
    city: 'NYC', address: '1335 6TH AVENUE',
    rates: [
      { code: 'RAC', amount: 359, currency: 'USD', available: 30 },
      { code: 'COR', amount: 309, currency: 'USD', available: 15 },
    ],
  },
  {
    chain: 'HI', property: 'NYC', name: 'HOLIDAY INN MANHATTAN FINANCIAL DISTRICT',
    city: 'NYC', address: '99 WASHINGTON ST',
    rates: [
      { code: 'RAC', amount: 249, currency: 'USD', available: 20 },
      { code: 'COR', amount: 219, currency: 'USD', available: 8 },
    ],
  },
];

/**
 * Rail seed — fictional schedules over the station pairs the QRG's
 * own examples use (WAS-NYP Amtrak corridor, GOT-STO AccesRail,
 * XPG-QQS Eurostar Paris Nord ↔ London St Pancras). Times and seat
 * counts are invented; train numbers are plausible shapes.
 */

import type { RailService } from '../models/rail.js';

export const RAIL_SEED: RailService[] = [
  // --- Amtrak (2V) Northeast corridor: WAS ↔ NYP ---
  { provider: '2V', trainNumber: '2150', origin: 'WAS', destination: 'NYP', departTime: '700A', arriveTime: '1005A', classSeats: { F: 9, Y: 9 } },
  { provider: '2V', trainNumber: '2154', origin: 'WAS', destination: 'NYP', departTime: '1200P', arriveTime: '305P', classSeats: { F: 4, Y: 9 } },
  { provider: '2V', trainNumber: '2158', origin: 'WAS', destination: 'NYP', departTime: '500P', arriveTime: '805P', classSeats: { F: 2, Y: 9 } },
  { provider: '2V', trainNumber: '2151', origin: 'NYP', destination: 'WAS', departTime: '800A', arriveTime: '1110A', classSeats: { F: 9, Y: 9 } },
  { provider: '2V', trainNumber: '2159', origin: 'NYP', destination: 'WAS', departTime: '600P', arriveTime: '910P', classSeats: { F: 4, Y: 9 } },
  // --- Eurostar (9F): XPG (Paris Nord) ↔ QQS (London St Pancras) ---
  { provider: '9F', trainNumber: '9007', origin: 'XPG', destination: 'QQS', departTime: '810A', arriveTime: '930A', classSeats: { F: 6, Y: 9 } },
  { provider: '9F', trainNumber: '9023', origin: 'XPG', destination: 'QQS', departTime: '110P', arriveTime: '230P', classSeats: { F: 6, Y: 9 } },
  { provider: '9F', trainNumber: '9024', origin: 'QQS', destination: 'XPG', departTime: '301P', arriveTime: '620P', classSeats: { F: 6, Y: 9 } },
  // --- AccesRail (9B): GOT ↔ STO (the QRG's own example pair) ---
  { provider: '9B', trainNumber: '4026', origin: 'GOT', destination: 'STO', departTime: '240A', arriveTime: '655A', classSeats: { Y: 9 } },
  { provider: '9B', trainNumber: '4030', origin: 'GOT', destination: 'STO', departTime: '900A', arriveTime: '120P', classSeats: { Y: 9 } },
];

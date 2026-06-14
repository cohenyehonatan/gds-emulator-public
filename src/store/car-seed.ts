/**
 * Car-rental seed for the emulator. Each city has 3-4 companies, each
 * with 2-3 vehicle classes. Amadeus 2-letter company codes:
 *   ZE = Hertz   ZD = Budget   ZA = Avis   ET = Enterprise
 *   ZI = National (Alamo)   ZL = Dollar   ZR = Thrifty
 *
 * ACRISS SIPP vehicle-type codes (4 chars: Size/Body/Transmission/Fuel-Air):
 *   ECMN = Economy 2/4-door Manual unspecified
 *   ECAR = Economy 2/4-door Auto unspecified-AC
 *   CCAR = Compact 2/4-door Auto unspecified-AC
 *   ICAR = Intermediate 2/4-door Auto unspecified-AC
 *   IDAR = Intermediate 4-door Auto AC
 *   SDAR = Standard 4-door Auto AC
 *   FDAR = Full-size 4-door Auto AC
 *   PDAR = Premium 4-door Auto AC
 *
 * Per-day amounts are round-number plausible values not benchmarked
 * to any real market.
 */

import type { CarRental } from '../models/car.js';

export const COMPANY_NAMES: Record<string, string> = {
  ZE: 'HERTZ',
  ZD: 'BUDGET',
  ZA: 'AVIS',
  ET: 'ENTERPRISE',
  ZI: 'NATIONAL',
  ZL: 'DOLLAR',
  ZR: 'THRIFTY',
};

export const CAR_SEED: CarRental[] = [
  // --- LON ---
  { company: 'ZE', vehicleType: 'ECMN', category: 'ECONOMY MANUAL',     rateCode: 'BST', amount: 35, currency: 'GBP', available: 12, city: 'LON' },
  { company: 'ZE', vehicleType: 'ICAR', category: 'INTERMEDIATE AUTO',  rateCode: 'BST', amount: 65, currency: 'GBP', available: 8,  city: 'LON' },
  { company: 'ZE', vehicleType: 'FDAR', category: 'FULL-SIZE AUTO',     rateCode: 'BST', amount: 85, currency: 'GBP', available: 4,  city: 'LON' },
  { company: 'ZD', vehicleType: 'ECMN', category: 'ECONOMY MANUAL',     rateCode: 'BST', amount: 30, currency: 'GBP', available: 15, city: 'LON' },
  { company: 'ZD', vehicleType: 'CCAR', category: 'COMPACT AUTO',       rateCode: 'BST', amount: 45, currency: 'GBP', available: 10, city: 'LON' },
  { company: 'ZA', vehicleType: 'ICAR', category: 'INTERMEDIATE AUTO',  rateCode: 'BST', amount: 60, currency: 'GBP', available: 9,  city: 'LON' },
  { company: 'ZA', vehicleType: 'SDAR', category: 'STANDARD AUTO',      rateCode: 'BST', amount: 70, currency: 'GBP', available: 6,  city: 'LON' },
  // --- NYC ---
  { company: 'ZE', vehicleType: 'CCAR', category: 'COMPACT AUTO',       rateCode: 'BST', amount: 55, currency: 'USD', available: 20, city: 'NYC' },
  { company: 'ZE', vehicleType: 'FDAR', category: 'FULL-SIZE AUTO',     rateCode: 'BST', amount: 95, currency: 'USD', available: 10, city: 'NYC' },
  { company: 'ZA', vehicleType: 'ECAR', category: 'ECONOMY AUTO',       rateCode: 'BST', amount: 50, currency: 'USD', available: 18, city: 'NYC' },
  { company: 'ET', vehicleType: 'ICAR', category: 'INTERMEDIATE AUTO',  rateCode: 'BST', amount: 65, currency: 'USD', available: 14, city: 'NYC' },
  { company: 'ET', vehicleType: 'PDAR', category: 'PREMIUM AUTO',       rateCode: 'BST', amount: 120, currency: 'USD', available: 6, city: 'NYC' },
  // --- ZRH ---
  { company: 'ZE', vehicleType: 'CCAR', category: 'COMPACT AUTO',       rateCode: 'BST', amount: 80, currency: 'CHF', available: 8,  city: 'ZRH' },
  { company: 'ZA', vehicleType: 'IDAR', category: 'INTERMEDIATE 4DR',   rateCode: 'BST', amount: 110, currency: 'CHF', available: 6, city: 'ZRH' },
  { company: 'ZD', vehicleType: 'ECMN', category: 'ECONOMY MANUAL',     rateCode: 'BST', amount: 65, currency: 'CHF', available: 10, city: 'ZRH' },
  // --- MAD ---
  { company: 'ZE', vehicleType: 'ECMN', category: 'ECONOMY MANUAL',     rateCode: 'BST', amount: 40, currency: 'EUR', available: 14, city: 'MAD' },
  { company: 'ZA', vehicleType: 'CCAR', category: 'COMPACT AUTO',       rateCode: 'BST', amount: 55, currency: 'EUR', available: 11, city: 'MAD' },
  { company: 'ZD', vehicleType: 'ICAR', category: 'INTERMEDIATE AUTO',  rateCode: 'BST', amount: 70, currency: 'EUR', available: 9,  city: 'MAD' },
  // --- LAX (the JFK-LAX market; loaded so an LAX trip can add a car) ---
  { company: 'ZE', vehicleType: 'ICAR', category: 'INTERMEDIATE AUTO',  rateCode: 'BST', amount: 58, currency: 'USD', available: 16, city: 'LAX' },
  { company: 'ZE', vehicleType: 'FDAR', category: 'FULL-SIZE AUTO',     rateCode: 'BST', amount: 89, currency: 'USD', available: 8,  city: 'LAX' },
  { company: 'ZA', vehicleType: 'ECAR', category: 'ECONOMY AUTO',       rateCode: 'BST', amount: 49, currency: 'USD', available: 20, city: 'LAX' },
  { company: 'ET', vehicleType: 'SDAR', category: 'STANDARD AUTO',      rateCode: 'BST', amount: 72, currency: 'USD', available: 12, city: 'LAX' },
  // --- SFO ---
  { company: 'ZE', vehicleType: 'CCAR', category: 'COMPACT AUTO',       rateCode: 'BST', amount: 62, currency: 'USD', available: 14, city: 'SFO' },
  { company: 'ZI', vehicleType: 'IDAR', category: 'INTERMEDIATE 4DR',   rateCode: 'BST', amount: 78, currency: 'USD', available: 9,  city: 'SFO' },
  { company: 'ZA', vehicleType: 'ECAR', category: 'ECONOMY AUTO',       rateCode: 'BST', amount: 52, currency: 'USD', available: 17, city: 'SFO' },
];

/**
 * MCT seed — fictional records following OAG's documented model
 * shape (4-layer hierarchy collapsed to airport default + carrier
 * exception + carrier-pair re-override). See `src/models/mct.ts`
 * + `docs/behavior-layer-research-2026-06-09.md`.
 *
 * Includes the OAG guide's worked MIA example verbatim (AA 55-minute
 * D-I exception, voided for AA→BA via the 9999 sentinel) so the
 * resolution semantics can be tested against the documented case.
 *
 * Airports chosen to match the rest of our seed (JFK/LAX/DFW/LHR +
 * MIA for the OAG example). Default magnitudes follow the guide's
 * documented typical ranges: ~30 min domestic, ~60-90 international.
 */

import type { MctRecord } from '../models/mct.js';
import { USE_STANDARD } from '../models/mct.js';

export const MCT_SEED: MctRecord[] = [
  // --- MIA: the OAG guide's worked example, verbatim semantics ---
  { airport: 'MIA', connectionType: 'DI', minutes: 60 },                                   // status standard: 1 hour
  { airport: 'MIA', connectionType: 'DI', carrier: 'AA', minutes: 55 },                    // AA to ALL: 55 min
  { airport: 'MIA', connectionType: 'DI', carrier: 'AA', toCarrier: 'BA', minutes: USE_STANDARD }, // AA to BA: revert to standard
  { airport: 'MIA', connectionType: 'DD', minutes: 40 },
  { airport: 'MIA', connectionType: 'II', minutes: 90 },
  { airport: 'MIA', connectionType: 'ID', minutes: 75 },

  // --- JFK ---
  { airport: 'JFK', connectionType: 'DD', minutes: 30 },
  { airport: 'JFK', connectionType: 'DI', minutes: 75 },
  { airport: 'JFK', connectionType: 'ID', minutes: 90 },
  { airport: 'JFK', connectionType: 'II', minutes: 90 },
  { airport: 'JFK', connectionType: 'DD', carrier: 'B6', minutes: 25 },  // JetBlue same-terminal

  // --- LAX ---
  { airport: 'LAX', connectionType: 'DD', minutes: 35 },
  { airport: 'LAX', connectionType: 'DI', minutes: 80 },
  { airport: 'LAX', connectionType: 'II', minutes: 90 },

  // --- DFW ---
  { airport: 'DFW', connectionType: 'DD', minutes: 30 },
  { airport: 'DFW', connectionType: 'DD', carrier: 'AA', minutes: 25 }, // AA hub advantage
  { airport: 'DFW', connectionType: 'DI', minutes: 60 },

  // --- LHR (the guide notes 2,372 carrier exceptions here; we seed a few) ---
  { airport: 'LHR', connectionType: 'II', minutes: 90 },
  { airport: 'LHR', connectionType: 'II', carrier: 'BA', minutes: 60 },                    // BA online T5
  { airport: 'LHR', connectionType: 'II', carrier: 'BA', toCarrier: 'AA', minutes: 75 },   // BA→AA cross-terminal
  { airport: 'LHR', connectionType: 'ID', minutes: 75 },
];

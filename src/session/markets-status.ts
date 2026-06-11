/**
 * HELP MARKETS / HE MARKETS — backend-aware.
 *
 * EMULATED: the seeded inventory (what this emulator serves).
 * LIVE: the real vendor serves real markets — presenting the seed
 * would be misleading (an operator saw HELP MARKETS claim KEF-FRA
 * is FI-only while the live host returned SK/FI/LH/AY/LX). The live
 * view shows what THIS session has OBSERVED through availability
 * responses (passive — markets are never probed, per the vendor-
 * pacing rule), plus the honest note that any real market may work.
 */

import type { Backend } from '../backends/backend.js';
import { LiveTravelportBackend } from '../backends/live-travelport-backend.js';

export function renderMarkets(backend: Backend): string {
  if (backend instanceof LiveTravelportBackend) {
    const lines = [
      'LIVE BACKEND — real vendor inventory; any real-world market may be served.',
      'OBSERVED THIS SESSION (from availability responses, never probed):',
    ];
    if (backend.marketsObserved.size === 0) {
      lines.push('  (none yet — run an availability, e.g. A15SEPKEFFRA)');
    } else {
      for (const [pair, cxrs] of [...backend.marketsObserved.entries()].sort()) {
        lines.push(`  ${pair}  ${[...cxrs].sort().join(' ')}`);
      }
    }
    return lines.join('\n');
  }
  return backend.inventory.marketsSummary().join('\n');
}

/**
 * HELP STORE / HE STORE — live persistence status. Emulator-native
 * (real hosts obviously don't disclose their datastore); tells an
 * operator whether committed Booking Files survive a restart, where
 * they live, and what's in there.
 */

import type { Backend } from '../backends/backend.js';
import { JsonFilePnrStore } from '../store/json-file-pnr-store.js';

export function renderStoreStatus(backend: Backend): string {
  const store = backend.pnrs;
  const kind =
    store instanceof JsonFilePnrStore
      ? `JSON FILE ${store.filePath} (SURVIVES RESTART)`
      : 'IN-MEMORY (EPHEMERAL - LOST ON RESTART)';
  const pnrs = store.values();
  const lines = [
    `PNR STORE: ${kind}`,
    `COMMITTED PNRS: ${pnrs.length}`,
  ];
  const recent = pnrs.slice(-10);
  for (const p of recent) {
    const name = p.names[0]
      ? `${p.names[0].surname}/${p.names[0].passengers[0]?.firstName ?? ''}`
      : '(no name)';
    const seg = p.segments[0];
    lines.push(
      ` ${p.locator}  ${name}  ${seg ? `${seg.carrier}${seg.flightNumber} ${seg.date} ${seg.origin}${seg.destination}` : '(no itinerary)'}`,
    );
  }
  if (pnrs.length > recent.length) lines.push(` … ${pnrs.length - recent.length} more`);
  if (pnrs.length > 0) lines.push('RETRIEVE: *<locator> / RT<locator> / *-<surname>');
  return lines.join('\n');
}

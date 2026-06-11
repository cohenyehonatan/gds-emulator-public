/**
 * HELP STORE / HE STORE — live persistence status. Emulator-native
 * (real hosts obviously don't disclose their datastore); tells an
 * operator whether committed Booking Files survive a restart, where
 * they live, and what's in there.
 */

import type { Backend } from '../backends/backend.js';
import { JsonFilePnrStore } from '../store/json-file-pnr-store.js';
import { JsonFileQueues } from '../store/json-file-queues.js';

export function renderStoreStatus(backend: Backend): string {
  const store = backend.pnrs;
  const kind =
    store instanceof JsonFilePnrStore
      ? `JSON FILE ${store.filePath} (SURVIVES RESTART)`
      : 'IN-MEMORY (EPHEMERAL - LOST ON RESTART)';
  const pnrs = store.values();
  const queues = backend.queues;
  const queuedTotal = [...queues.values()].reduce((acc, l) => acc + l.length, 0);
  const queueKind = queues instanceof JsonFileQueues
    ? `JSON FILE ${queues.filePath} (SURVIVES RESTART)`
    : 'IN-MEMORY (EPHEMERAL - LOST ON RESTART)';
  const lines = [
    `PNR STORE: ${kind}`,
    `QUEUE STORE: ${queueKind}`,
    `COMMITTED PNRS: ${pnrs.length}   QUEUED: ${queuedTotal} ON ${queues.size} QUEUE(S)`,
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

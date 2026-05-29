/**
 * Result of a `Q/<queue>` access. The live source is Travelport's
 * `AgencyQueueResponse.AgencyQueue.QueueList[]` — one entry per booking
 * sitting on the queue. The emulated source is `backend.queues` (a
 * plain `Map<queueId, locator[]>`) crossed with `backend.pnrs` for
 * name + first-segment date.
 *
 * Render with `renderGalileoQueueList` to surface as a cryptic screen.
 */
export interface QueueListItem {
  locator: string;
  /** Lead-passenger surname/given as a single display string (e.g. "SMITH/J"). */
  name: string;
  /** First-segment travel date — Sabre-style token (`27JUN`) or whatever the source emits. */
  travelDate: string;
}

export interface QueueListResult {
  queue: string;
  items: QueueListItem[];
}

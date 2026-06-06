/**
 * validate-galileo-handler-live.ts — REPL-style live verification.
 *
 * Drives a full cryptic sequence (SON → A → N1Y1 → N. → P. → R. → T. →
 * ER) through the Galileo dialect handler chain against a real
 * `LiveTravelportBackend`. This is the integration test for the
 * 2026-06-06 handler refactor that defers `addTraveler` until both N.
 * and P. are present — what `validate-travelport-creds.ts` exercises
 * by hand-rolling each body, this one exercises through the same
 * code path a live REPL session uses.
 *
 * Verifies that the cryptic-level `ER` produces a real Travelport
 * locator (the pre-refactor handler silently committed Travelers
 * without Telephone[] and any ER would fail with "TELEPHONE IS A
 * REQUIRED FIELD" inside Result.Error[]).
 *
 * ── WHAT THIS SENDS OVER THE NETWORK ───────────────────────────────
 * Hits the same Travelport pre-prod endpoints `validate-travelport-
 * creds.ts` does, in roughly the same order. Same secrets (read from
 * env vars), same single-call-per-endpoint discipline. After commit
 * we issue one cancel POST to avoid leaving the BF in pre-prod queues.
 *
 * ── RUN ────────────────────────────────────────────────────────────
 *   export TVP_CLIENT_ID=...   TVP_CLIENT_SECRET=...
 *   export TVP_USERNAME=...    TVP_PASSWORD=...
 *   npx tsx validate-galileo-handler-live.ts
 *
 * No env vars → script exits 2.
 */

import { GdsHost } from './src/session/gds-host.js';
import { GalileoDialect } from './src/dialects/galileo/index.js';
import {
  LiveTravelportBackend,
  liveTravelportFromEnv,
} from './src/backends/live-travelport-backend.js';
import type { WorkArea } from './src/session/work-area.js';

function makeEntry(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${day}${months[date.getUTCMonth()]}`;
}

async function run(host: GdsHost, wa: WorkArea, entry: string): Promise<string> {
  console.log(`\n▶ ${entry}`);
  let resp: string;
  try {
    resp = await host.process(entry, wa);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⨯ THREW: ${msg}`);
    throw err;
  }
  // Indent each line of the response so the cryptic surface is
  // visually distinct from the entries we typed.
  for (const line of resp.split('\n')) console.log(`  ${line}`);
  return resp;
}

async function main(): Promise<void> {
  const backend = liveTravelportFromEnv();
  if (!backend) {
    console.error('✗ Missing required env vars (TVP_CLIENT_ID / TVP_CLIENT_SECRET / TVP_USERNAME / TVP_PASSWORD).');
    process.exit(2);
  }

  console.log('Galileo live-handler REPL verification (pre-prod sandbox)');
  console.log(`PCC=${backend.id}  workflow: SON → A → N1Y1 → N. → P. → R. → T. → ER`);

  const host = new GdsHost({
    port: 0,
    logLevel: 'error',
    dialect: new GalileoDialect(),
    pcc: '7K9S',
    backend,
  });
  const wa = host.newWorkArea();

  // Future-date the availability ~30 days out, mirroring the spike script.
  const departure = new Date(Date.now() + 30 * 86_400_000);
  const dateToken = makeEntry(departure);

  // Sign-on first — no network call, just establishes the FSM.
  await run(host, wa, 'SON/ZHA');

  // 1) Availability — triggers live search.
  await run(host, wa, `A${dateToken}DENFRA`);

  // 2) Sell line 1, 1 seat. The trial tenant's search results vary by
  // route + date — Y (full economy) frequently isn't returned. Inspect
  // line 1's actual class map and pick the first available class so
  // the verifier doesn't fail on CLASS NOT AVAILABLE.
  const line1 = wa.lastAvailability?.lines[0];
  if (!line1) {
    console.error('\n✗ No availability lines after A. — cannot continue.');
    process.exit(1);
  }
  const availableClass = Object.entries(line1.classes).find(([, n]) => n > 0)?.[0];
  if (!availableClass) {
    console.error('\n✗ Line 1 has no class with availability. classes =', line1.classes);
    process.exit(1);
  }
  console.log(`\n(picked class ${availableClass} from line 1's classes: ${JSON.stringify(line1.classes)})`);
  await run(host, wa, `N1${availableClass}1`);

  // 3) Name — accumulates locally; addTraveler deferred until P. arrives.
  await run(host, wa, 'N.SMITH/JOHN MR');
  console.log(
    `    liveTravelerIds: ${wa.liveTravelerIds === undefined ? '(not posted yet — correct)' : JSON.stringify(wa.liveTravelerIds)}`
  );

  // 4) Phone — triggers addTraveler (with embedded Telephone) + addPrimaryContact.
  await run(host, wa, 'P.LON*02012345678');
  console.log(
    `    liveTravelerIds: ${wa.liveTravelerIds === undefined ? '(NOT POSTED — BUG)' : JSON.stringify(wa.liveTravelerIds)}`
  );

  // 5) Received-from and ticketing — local-only fields needed for end-tx.
  await run(host, wa, 'R.AGT');
  await run(host, wa, 'T.TAU/10JUN');

  // 6) End transaction — the moment of truth.
  const er = await run(host, wa, 'ER');
  // commitGalileoLive resets the slot after end-tx (correct Galileo
  // semantics — the work area empties for the next BF build), so
  // `wa.pnr.locator` is gone by design. Parse the locator out of the
  // rendered BF response — it's the 6-char alphanumeric in the
  // signature line (e.g. `GZTY6M  7K9S/HA`).
  const locatorMatch = /\b([A-Z0-9]{6})\b\s+\S+\/\S+/.exec(er);
  const locator = locatorMatch?.[1];
  console.log(`\nLocator (parsed from ER response): ${locator ?? '(none — handler regression)'}`);
  console.log(
    `workbench cleared on commit: ${wa.liveWorkbenchId === undefined ? 'yes ✓' : 'NO — still ' + wa.liveWorkbenchId}`
  );

  // Cleanup: if we got a locator, cancel the BF so it doesn't leave
  // residue in pre-prod queues. Cancellation via the cryptic cancel
  // (X) doesn't have a live wire today, so go through the backend.
  if (locator) {
    console.log(`\nCleanup: cancelling ${locator}…`);
    if (backend instanceof LiveTravelportBackend) {
      try {
        await backend.cancelReservation(locator);
        console.log('  ✓ cancelled');
      } catch (e) {
        console.log(`  △ cancel failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (er.includes('LIVE BACKEND ERROR')) {
    console.log('\n✗ ER returned LIVE BACKEND ERROR — handler refactor regressed.');
    process.exit(1);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\n✗ Unexpected:', err?.message ?? err);
  process.exit(1);
});

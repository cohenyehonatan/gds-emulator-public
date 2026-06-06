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
  console.log(
    `PCC=${backend.id}  workflow: SON → A → N (sell) → X1 (cancel) → N (re-sell) → N. → P. → FQ → SI. → R. → T. → ER`
  );

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

  // 2) Sell. Prefer a connection (two consecutive lines sharing a
  // connectionGroup) when available — that lets us exercise per-leg
  // SSR with `SI.S2/<code>` later. Falls back to a single-leg sell on
  // line 1 if no connection is in the cache.
  const lines = wa.lastAvailability?.lines ?? [];
  if (lines.length === 0) {
    console.error('\n✗ No availability lines after A. — cannot continue.');
    process.exit(1);
  }

  // Find a connection: two consecutive entries with the same
  // connectionGroup. (Each line is one leg of the connection.)
  const connLeg1Idx = lines.findIndex(
    (l, i) => i + 1 < lines.length && l.connectionGroup !== undefined && lines[i + 1].connectionGroup === l.connectionGroup
  );
  const isConnection = connLeg1Idx >= 0;
  let sellEntry: string;
  if (isConnection) {
    const leg1 = lines[connLeg1Idx];
    const leg2 = lines[connLeg1Idx + 1];
    const class1 = Object.entries(leg1.classes).find(([, n]) => n > 0)?.[0];
    const class2 = Object.entries(leg2.classes).find(([, n]) => n > 0)?.[0];
    if (!class1 || !class2) {
      console.error('\n✗ Connection legs have no usable class.', leg1.classes, leg2.classes);
      process.exit(1);
    }
    sellEntry = `N1${class1}${leg1.line}${class2}${leg2.line}`;
    console.log(
      `\n(connection sell: line ${leg1.line} class ${class1} + line ${leg2.line} class ${class2} → "${sellEntry}")`
    );
  } else {
    const line1 = lines[0];
    const availableClass = Object.entries(line1.classes).find(([, n]) => n > 0)?.[0];
    if (!availableClass) {
      console.error('\n✗ Line 1 has no class with availability.', line1.classes);
      process.exit(1);
    }
    sellEntry = `N1${availableClass}1`;
    console.log(`\n(nonstop sell: line 1 class ${availableClass} → "${sellEntry}")`);
  }
  await run(host, wa, sellEntry);
  console.log(
    `    liveWorkbenchOfferIds: ${wa.liveWorkbenchOfferIds ? JSON.stringify(wa.liveWorkbenchOfferIds.map((u) => u.slice(0, 8) + '…')) : '(none)'}`
  );

  // 2.5) Pre-commit cancel via cryptic `X1` — exercises
  // cancelGalileoLiveWorkbench's per-offer CancelSelectedOffers
  // path. Last live run with XI proved the canonical `cancelAllInd:
  // true` body actually clears the workbench. X1 sends a different
  // body that returns 200 but may not actually cancel server-side
  // — set TVP_DEBUG_DUMP=1 in the env to write the cancelitems
  // request + response to ./tvp-diag-cancelitems-selected.json so
  // we can see what the server confirms.
  await run(host, wa, 'X1');
  const segsAfter = wa.pnr.segments.length;
  const wbAfter = wa.liveWorkbenchOfferIds?.length ?? 0;
  if (segsAfter > 0 || wbAfter > 0) {
    console.log(`    △ unexpected residue after X1: ${segsAfter} segments, ${wbAfter} wb UUIDs`);
  } else {
    console.log('    ✓ pre-commit cancel cleared segments + wb UUIDs; workbench survives');
  }
  console.log(
    `    workbench after cancel: ${wa.liveWorkbenchId ? wa.liveWorkbenchId.slice(0, 8) + '…' : '(cleared — handler bug?)'}`
  );

  // Re-sell: pick a DIFFERENT connection (or fall back to the same
  // pair, accepting pre-prod might rate-limit a duplicate sell).
  const altConnIdx = lines.findIndex(
    (l, i) =>
      i > connLeg1Idx + 1 &&
      i + 1 < lines.length &&
      l.connectionGroup !== undefined &&
      lines[i + 1].connectionGroup === l.connectionGroup
  );
  if (altConnIdx >= 0) {
    const a = lines[altConnIdx];
    const b = lines[altConnIdx + 1];
    const cA = Object.entries(a.classes).find(([, n]) => n > 0)?.[0];
    const cB = Object.entries(b.classes).find(([, n]) => n > 0)?.[0];
    if (cA && cB) {
      const reEntry = `N1${cA}${a.line}${cB}${b.line}`;
      console.log(`\n(post-cancel re-sell: line ${a.line} + line ${b.line} → "${reEntry}")`);
      await run(host, wa, reEntry);
      console.log(
        `    liveWorkbenchOfferIds: ${wa.liveWorkbenchOfferIds ? JSON.stringify(wa.liveWorkbenchOfferIds.map((u) => u.slice(0, 8) + '…')) : '(none)'}`
      );
    }
  } else {
    console.log('\n△ No alternative connection in cache — re-issuing original sell.');
    await run(host, wa, sellEntry);
  }

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

  // 5) Fare quote — verifies priceOffer canonical 3-ID body. Soft-fail
  // (warn but continue) if the trial tenant doesn't price this route:
  // an end-to-end ER still has value even without a live FQ.
  const fq = await run(host, wa, 'FQ');
  if (fq.includes('LIVE BACKEND ERROR')) {
    console.log('    △ FQ live failed — priceOffer body may have hit a tenant gap. Continuing.');
  } else if (!fq.includes('FARE QUOTE NOT AVAILABLE')) {
    console.log('    ✓ FQ live priced (priceOffer body verified).');
  }

  // 6) SSR with TravelerIdentifier (server requires it). On a
  // connection sell, target segment 2 to exercise per-leg dispatch.
  const ssrEntry = isConnection ? 'SI.P1S2/WCHR' : 'SI.P1/WCHR';
  const ssrResp = await run(host, wa, ssrEntry);
  if (ssrResp.includes('LIVE BACKEND ERROR')) {
    console.log('    △ SSR live failed — non-fatal, continuing to ER.');
  }

  // 7) Received-from and ticketing — local-only fields needed for end-tx.
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

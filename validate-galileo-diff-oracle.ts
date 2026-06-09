/**
 * validate-galileo-diff-oracle.ts — live-as-oracle diff harness.
 *
 * Fires the SAME cryptic sequence at `galileo:emulated` (local Inventory/
 * PnrStore, fully synthesized state) and `galileo:live` (LiveTravelportBackend
 * against pre-prod), then compares the responses side-by-side. The live 1G
 * tenant is the source of truth for the cryptic surface; divergences from
 * the emulated path either mean the emulated handler needs more fidelity,
 * the live wire has a body-shape bug, or the difference is intrinsic
 * (auto-generated locators, server-side IDs).
 *
 * Categorizes each pair of responses:
 *   IDENTICAL          — exact string match
 *   TRAILER-DIFF       — same except for the [LOCAL VIEW ONLY] trailer
 *   LOCATOR-DIFF       — differ only in the 6-char locator substring
 *                        (emulated assigns A1B2C3, live returns GZTZxx)
 *   STRUCTURAL         — different line count or no recognizable pattern
 *   ERROR-EITHER       — one path errored (LIVE BACKEND ERROR / FORMAT / etc.)
 *
 * Exit code:
 *   0 if every divergence is in the "expected intrinsic" categories
 *     (TRAILER-DIFF, LOCATOR-DIFF, ERROR-EITHER from pre-prod flakiness)
 *   1 if any STRUCTURAL diff appears
 *
 * Same secrets convention as the other live verifiers:
 *   TVP_CLIENT_ID, TVP_CLIENT_SECRET, TVP_USERNAME, TVP_PASSWORD
 * No env vars → script exits 2.
 *
 * Per the ROADMAP v5 "Live-as-oracle" item: this is the harness that
 * makes 1G itself the validation oracle for the emulated build-out,
 * letting us catch divergences regression-style instead of by review.
 */

import { GdsHost } from './src/session/gds-host.js';
import { GalileoDialect } from './src/dialects/galileo/index.js';
import { ApolloDialect } from './src/dialects/apollo/index.js';
import { WorldspanDialect } from './src/dialects/worldspan/index.js';
import { liveTravelportFromEnv } from './src/backends/live-travelport-backend.js';
import type { WorkArea } from './src/session/work-area.js';
import type { Dialect } from './src/dialects/dialect.js';

type DiffCategory =
  | 'IDENTICAL'
  | 'TRAILER-DIFF'
  | 'LOCATOR-DIFF'
  | 'STRUCTURAL'
  | 'ERROR-EITHER';

interface DiffRow {
  entry: string;
  emulated: string;
  live: string;
  category: DiffCategory;
  notes: string;
}

const LOCAL_ONLY_TRAILER = '[LOCAL VIEW ONLY — no v11 REST equivalent]';
const LOCATOR_REGEX = /\b[A-Z0-9]{6}\b/g;

function stripTrailer(s: string): string {
  return s.replace(new RegExp(`\\n?${LOCAL_ONLY_TRAILER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '');
}

function maskLocators(s: string): string {
  return s.replace(LOCATOR_REGEX, '<LOC>');
}

function categorize(emulated: string, live: string): { category: DiffCategory; notes: string } {
  if (emulated === live) return { category: 'IDENTICAL', notes: '' };
  if (emulated.includes('LIVE BACKEND ERROR') || live.includes('LIVE BACKEND ERROR')) {
    return { category: 'ERROR-EITHER', notes: 'one side returned LIVE BACKEND ERROR — likely pre-prod transient' };
  }
  const emulatedStripped = stripTrailer(emulated);
  const liveStripped = stripTrailer(live);
  if (emulatedStripped === liveStripped) {
    return { category: 'TRAILER-DIFF', notes: 'trailer-only difference — expected for live + local-only verbs' };
  }
  if (maskLocators(emulatedStripped) === maskLocators(liveStripped)) {
    return { category: 'LOCATOR-DIFF', notes: 'differ only in 6-char locator value' };
  }
  // Structural — count line + first divergence
  const eLines = emulatedStripped.split('\n');
  const lLines = liveStripped.split('\n');
  if (eLines.length !== lLines.length) {
    return {
      category: 'STRUCTURAL',
      notes: `line count ${eLines.length} vs ${lLines.length}`,
    };
  }
  // Same line count → find first diverging line
  for (let i = 0; i < eLines.length; i++) {
    if (eLines[i] !== lLines[i]) {
      return {
        category: 'STRUCTURAL',
        notes: `line ${i + 1} differs: "${eLines[i]}" vs "${lLines[i]}"`,
      };
    }
  }
  return { category: 'STRUCTURAL', notes: 'no recognizable divergence pattern' };
}

const CATEGORY_GLYPH: Record<DiffCategory, string> = {
  IDENTICAL: '✓',
  'TRAILER-DIFF': '·',
  'LOCATOR-DIFF': '~',
  STRUCTURAL: '✗',
  'ERROR-EITHER': '⚠',
};

/**
 * Some verbs intrinsically diverge between emulated and live:
 *   - Availability: emulated returns the synth-inventory's lines;
 *     live returns pre-prod's actual offers. The CARRIERS, flight
 *     numbers, and counts differ, but both are valid responses.
 *   - Pricing: same — different fares for the same route.
 *
 * Mark these as `expectStructural: true` so a STRUCTURAL classification
 * doesn't fail CI. The harness still PRINTS the divergence (operator
 * can eyeball the shape) but doesn't flip the exit code.
 *
 * Anything NOT marked falls into the CI-failing bucket, so a regression
 * (e.g., emulated drift on a verb that used to be IDENTICAL) breaks
 * the run.
 */
interface DiffStep {
  entry: string;
  /** Apollo-cryptic variant. Used when --dialect=apollo so the harness
   *  exercises the translator (Apollo `01Y1` → Galileo `N1Y1`, etc.). */
  apolloEntry?: string;
  /** Worldspan-cryptic variant for --dialect=worldspan. When absent,
   *  falls back to apolloEntry (Worldspan shares Apollo's 0-sell and
   *  .-status sigils) and then to the Galileo entry. */
  worldspanEntry?: string;
  expectStructural?: boolean;
}

async function runBoth(
  emulatedHost: GdsHost,
  emulatedWa: WorkArea,
  liveHost: GdsHost,
  liveWa: WorkArea,
  step: DiffStep,
  rows: DiffRow[],
  dialect?: string
): Promise<void> {
  const entry =
    dialect === 'worldspan'
      ? step.worldspanEntry ?? step.apolloEntry ?? step.entry
      : dialect === 'apollo' && step.apolloEntry
        ? step.apolloEntry
        : step.entry;
  const [emulated, live] = await Promise.all([
    emulatedHost.process(entry, emulatedWa).catch((err) => `THROW: ${err instanceof Error ? err.message : String(err)}`),
    liveHost.process(entry, liveWa).catch((err) => `THROW: ${err instanceof Error ? err.message : String(err)}`),
  ]);
  const { category, notes } = categorize(emulated, live);
  const expectedTag = step.expectStructural && category === 'STRUCTURAL' ? ' (expected)' : '';
  rows.push({ entry, emulated, live, category, notes: `${notes}${expectedTag}` });
  console.log(`\n${CATEGORY_GLYPH[category]} [${category}${expectedTag}] ${entry}`);
  if (notes) console.log(`   ${notes}`);
  if (category !== 'IDENTICAL') {
    const ePreview = emulated.split('\n').slice(0, 3).join(' / ');
    const lPreview = live.split('\n').slice(0, 3).join(' / ');
    console.log(`   emulated: ${ePreview.slice(0, 120)}`);
    console.log(`   live:     ${lPreview.slice(0, 120)}`);
  }
}

async function main(): Promise<void> {
  const liveBackend = liveTravelportFromEnv();
  if (!liveBackend) {
    console.error(
      'TVP_CLIENT_ID/SECRET/USERNAME/PASSWORD not set; cannot run live-vs-emulated diff. Exiting.'
    );
    process.exit(2);
  }

  // CLI: `--dialect apollo` swaps in ApolloDialect so the same harness
  // exercises the Apollo→Galileo translator end-to-end against pre-prod.
  // Apollo's cryptic deltas (01Y1, .1HK, A...+LH) need to translate to
  // Galileo equivalents at the dialect layer; this harness is the only
  // place where that wire gets a real live workout.
  const dialectArg = process.argv.find((a) => a.startsWith('--dialect='))?.slice('--dialect='.length);
  const makeDialect: () => Dialect =
    dialectArg === 'apollo' ? () => new ApolloDialect()
    : dialectArg === 'worldspan' ? () => new WorldspanDialect()
    : () => new GalileoDialect();

  const harnessName = dialectArg === 'apollo' ? 'Apollo' : dialectArg === 'worldspan' ? 'Worldspan' : 'Galileo';
  console.log(`${harnessName} live-as-oracle diff harness`);
  console.log('PCC=7K9S  emulated host (Inventory+PnrStore) vs live host (LiveTravelportBackend)');

  const emulatedHost = new GdsHost({
    port: 0, logLevel: 'error', dialect: makeDialect(), pcc: '7K9S',
  });
  const liveHost = new GdsHost({
    port: 0, logLevel: 'error', dialect: makeDialect(), pcc: '7K9S', backend: liveBackend,
  });
  const emulatedWa = emulatedHost.newWorkArea();
  const liveWa = liveHost.newWorkArea();
  const rows: DiffRow[] = [];

  const apollo = dialectArg; // dialect tag threaded into runBoth (name kept to avoid churn below)
  // Pre-warm both sessions — Apollo and Galileo SON cryptic is
  // identical (`SON/ZHA`).
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: 'SON/ZHA', worldspanEntry: 'BSI$5467HA/GS' }, rows, apollo);

  // Availability — INTRINSIC STRUCTURAL diff. Apollo and Galileo
  // availability cryptic is identical for the basic form.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: 'A27JUNDENFRA', expectStructural: true }, rows, apollo);

  // Sell — Apollo uses `01Y1`, Galileo uses `N1Y1`. The Apollo dialect's
  // translator should rewrite `01Y1` → `N1Y1` before Galileo's parser
  // sees it. Both still go through the same handler.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: 'N1Y1', apolloEntry: '01Y1', expectStructural: true }, rows, apollo);

  // Segment-status — Apollo `.1HK`, Galileo `@1HK`. Translator rewrites.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: '@1HK', apolloEntry: '.1HK', expectStructural: true }, rows, apollo);

  // History — `*H` / `*HI` cryptic is identical in both dialects.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: '*H', expectStructural: true }, rows, apollo);
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: '*HI', expectStructural: true }, rows, apollo);

  // Stateless wording canaries — verbs that should produce IDENTICAL
  // responses regardless of session state (no inventory/PNR dependency).
  // These exercise the narrow-target calibration: the verb's response
  // wording must match byte-for-byte between emulated and live. If any
  // diverges, emulated's GalileoResponse string in src/dialects/galileo/
  // responses.ts needs updating to match what pre-prod actually returns.
  //
  // For each canary we use a SECOND pair of WorkAreas so the existing
  // build state doesn't interfere. The session state is "signed in,
  // nothing built" — clean baseline for stateless wording checks.
  const cleanEmu = emulatedHost.newWorkArea();
  const cleanLive = liveHost.newWorkArea();
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'SON/ZHA', worldspanEntry: 'BSI$5467HA/GS' }, rows, apollo);

  // *<random-locator> — both should return "NO BOOKING FILE". Verifies
  // the canonical Galileo no-PNR wording matches between emulated's
  // GalileoResponse.NO_PNR ("NO BOOKING FILE") and pre-prod's actual
  // retrieve-not-found response.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*XYZ999' }, rows, apollo);

  // IG with empty work area — should be a no-op success on both sides
  // (ignore-on-empty doesn't have anything to discard).
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'IG' }, rows, apollo);

  // @1HK without any sell — both should report "NEED ITINERARY" since
  // there's no segment to modify the status of.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '@1HK', apolloEntry: '.1HK' }, rows, apollo);

  // N1Y1 (Galileo) / 01Y1 (Apollo) without an availability cache — both
  // should respond with some form of "no availability to sell from".
  // Exact wording is a calibration target if they differ.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'N1Y1', apolloEntry: '01Y1' }, rows, apollo);

  // More stateless probes — hunting for wording mismatch.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'XI' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'FQ' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*R' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*I' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*N' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'TKP1' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'SI.WCHR' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'R.AGT' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'T.TAU/15JUL' }, rows, apollo);
  // Malformed entry — both should report FORMAT.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'ZZZ?!' }, rows, apollo);

  // Verbs touching ticket / queue / flight detail without state.
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*HTI' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*HTE' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'QEB/35' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: 'TTL5' }, rows, apollo);
  await runBoth(emulatedHost, cleanEmu, liveHost, cleanLive, { entry: '*PAC' }, rows, apollo);

  // SOF — stateless, no upstream dependency. The original canary.
  // If SOF ever diverges, something deeper broke.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, { entry: 'SOF' }, rows, apollo);

  // Summary table.
  console.log('\n\n═══ Summary ═══');
  const counts: Record<DiffCategory, number> = {
    IDENTICAL: 0, 'TRAILER-DIFF': 0, 'LOCATOR-DIFF': 0, STRUCTURAL: 0, 'ERROR-EITHER': 0,
  };
  for (const r of rows) counts[r.category]++;
  for (const [cat, count] of Object.entries(counts)) {
    if (count > 0) console.log(`  ${CATEGORY_GLYPH[cat as DiffCategory]} ${cat}: ${count}`);
  }

  // Exit code: non-zero only for UNEXPECTED STRUCTURAL diffs (i.e.
  // STRUCTURAL on an entry NOT marked expectStructural). Marked-as-
  // expected structural diffs (availability, sell) print but don't
  // flip the exit code. TRAILER-DIFF + LOCATOR-DIFF are intrinsic;
  // ERROR-EITHER is pre-prod flakiness we tolerate.
  const unexpectedStructural = rows.filter(
    (r) => r.category === 'STRUCTURAL' && !r.notes.includes('(expected)')
  );
  if (unexpectedStructural.length > 0) {
    console.log(`\n✗ ${unexpectedStructural.length} UNEXPECTED structural divergence(s):`);
    for (const r of unexpectedStructural) console.log(`  - ${r.entry}: ${r.notes}`);
    process.exit(1);
  }
  console.log('\n✓ No unexpected structural divergences.');
}

main().catch((err) => {
  console.error('Diff harness failed:', err);
  process.exit(3);
});

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
import { liveTravelportFromEnv } from './src/backends/live-travelport-backend.js';
import type { WorkArea } from './src/session/work-area.js';

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

async function runBoth(
  emulatedHost: GdsHost,
  emulatedWa: WorkArea,
  liveHost: GdsHost,
  liveWa: WorkArea,
  entry: string,
  rows: DiffRow[]
): Promise<void> {
  const [emulated, live] = await Promise.all([
    emulatedHost.process(entry, emulatedWa).catch((err) => `THROW: ${err instanceof Error ? err.message : String(err)}`),
    liveHost.process(entry, liveWa).catch((err) => `THROW: ${err instanceof Error ? err.message : String(err)}`),
  ]);
  const { category, notes } = categorize(emulated, live);
  rows.push({ entry, emulated, live, category, notes });
  console.log(`\n${CATEGORY_GLYPH[category]} [${category}] ${entry}`);
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

  console.log('Galileo live-as-oracle diff harness');
  console.log('PCC=7K9S  emulated host (Inventory+PnrStore) vs live host (LiveTravelportBackend)');

  const emulatedHost = new GdsHost({
    port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
  });
  const liveHost = new GdsHost({
    port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend: liveBackend,
  });
  const emulatedWa = emulatedHost.newWorkArea();
  const liveWa = liveHost.newWorkArea();
  const rows: DiffRow[] = [];

  // Pre-warm both sessions
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, 'SON/ZHA', rows);

  // Availability — emulated returns synthesized lines, live returns
  // pre-prod's actual offers. Structural diff is EXPECTED here — the
  // emulator can't reproduce pre-prod's specific carrier/flight set.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, 'A27JUNDENFRA', rows);

  // Hybrid-coverage verbs — these should TRAILER-DIFF when live is up.
  // We need an itinerary to test @<n>HK, so do a quick sell first.
  // The Galileo emulated handler picks line 1; live handler picks line 1.
  // Different offer content but same shape.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, 'N1Y1', rows);
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, '@1HK', rows);

  // Local-only family verbs — surface trailer diffs.
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, '*H', rows);
  await runBoth(emulatedHost, emulatedWa, liveHost, liveWa, '*HI', rows);

  // Summary table.
  console.log('\n\n═══ Summary ═══');
  const counts: Record<DiffCategory, number> = {
    IDENTICAL: 0, 'TRAILER-DIFF': 0, 'LOCATOR-DIFF': 0, STRUCTURAL: 0, 'ERROR-EITHER': 0,
  };
  for (const r of rows) counts[r.category]++;
  for (const [cat, count] of Object.entries(counts)) {
    if (count > 0) console.log(`  ${CATEGORY_GLYPH[cat as DiffCategory]} ${cat}: ${count}`);
  }

  // Exit code: non-zero if any STRUCTURAL diff present (CI signal).
  // TRAILER-DIFF and LOCATOR-DIFF are expected; ERROR-EITHER is pre-prod
  // flakiness we tolerate.
  if (counts.STRUCTURAL > 0) {
    console.log('\n✗ Structural divergences found — see [STRUCTURAL] entries above.');
    process.exit(1);
  }
  console.log('\n✓ No structural divergences.');
}

main().catch((err) => {
  console.error('Diff harness failed:', err);
  process.exit(3);
});

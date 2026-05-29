/**
 * Galileo green-screen response rendering — the dialect-specific tail
 * of `processEntry`. Sabre's serializer (`src/protocol/serializer.ts`)
 * stays Sabre-specific; Galileo grows its own here.
 *
 * **Fidelity caveat.** The Travelport+ Mini Format Guide v2 (Oct 2025,
 * canonical) documents Galileo *entries* but routes responses through
 * Smartpoint pop-ups, so the host text isn't published. Every renderer
 * here is **reconstructed** at the queue-prompt fidelity bar — the
 * shapes follow common 1G conventions (`<usercode> SIGNED ON AT <PCC>`
 * style, all-caps, single-line) but the wording isn't source-verified.
 * Replace verbatim when a live-1G capture against 7K9S surfaces the
 * real response strings.
 */

export interface GalileoSignature {
  /** Pseudo City Code (e.g. "7K9S" — the Travelport pre-prod tenant). */
  pcc: string;
  /** User code captured from `SON/Z<rest>`. May embed a PCC override. */
  agent?: string;
}

/**
 * Render the sign-on response (`SON/Z<usercode>`).
 * Reconstructed — no source documents the exact host wording.
 */
export function renderGalileoSignInResponse(sig: GalileoSignature): string {
  const code = sig.agent ?? 'AGT';
  return `${code} SIGNED ON AT ${sig.pcc}`; // reconstructed
}

/**
 * Render the sign-off response (`SOF`).
 * Reconstructed — no source documents the exact host wording.
 */
export function renderGalileoSignOffResponse(sig: GalileoSignature): string {
  const code = sig.agent ?? 'AGT';
  return `${code} SIGNED OFF AT ${sig.pcc}`; // reconstructed
}

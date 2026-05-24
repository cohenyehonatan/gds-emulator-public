/**
 * Agent sign-in / sign-out.  (workbook "SIGN IN" / "SIGN OUT")
 *   SI*(id)  sign in / open the work area, e.g. SI*000000
 *   SO       sign out of the current work area  → "<area> SIGNED OUT"
 *   SO*      sign out of all work areas          → "A.B.C.D.E.F..SIGNED OUT"
 *
 * v1 treats sign-in as opening the AAA work area for the session; agent
 * credential / passcode validation is a later phase.
 */

import type { SignInEntry, SignOutEntry } from '../entry.js';

export function parseSignIn(raw: string): SignInEntry {
  // After "SI", drop a leading "*" so SI*4321 → agent "4321".
  const argument = raw.slice(2).replace(/^\*/, '').trim();
  return { kind: 'sign_in', raw, timestamp: new Date(), argument };
}

export function parseSignOut(raw: string): SignOutEntry {
  return { kind: 'sign_out', raw, timestamp: new Date(), allAreas: raw.toUpperCase() === 'SO*' };
}

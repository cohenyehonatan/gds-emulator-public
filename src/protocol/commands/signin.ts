/**
 * Agent sign-in / sign-out.
 *   SI...   sign in / open the work area (real Sabre uses agent sine + EPR)
 *   SO      sign out
 *
 * v1 treats sign-in as opening the AAA work area for the session; agent
 * credential validation is a later phase.
 */

import type { SignInEntry, SignOutEntry } from '../entry.js';

export function parseSignIn(raw: string): SignInEntry {
  return { kind: 'sign_in', raw, timestamp: new Date(), argument: raw.slice(2).trim() };
}

export function parseSignOut(raw: string): SignOutEntry {
  return { kind: 'sign_out', raw, timestamp: new Date() };
}

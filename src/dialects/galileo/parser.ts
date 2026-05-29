/**
 * Galileo cryptic-entry parser.
 *
 * Mirrors the architecture of `src/protocol/parser.ts` (Sabre): an ordered
 * prefix-match dispatch table feeding per-verb parsers. Returns the same
 * `ParsedEntry` discriminated kinds Sabre uses — sign_in, sign_out, etc.
 * Galileo and Sabre share the semantic operation set but parse different
 * cryptic surface syntax.
 *
 * Source: `references/galileo/Travelport-Mini-Format-Guide-v2.pdf` (Oct
 * 2025, canonical) and `Galileo-Pocket-Guide.pdf` (2009, supplementary
 * legacy verbs). Forms implemented here:
 *
 *   SON / Z<usercode>       Sign on at own office (Mini Guide p.5)
 *   SOF                     Sign off (Mini Guide p.6)
 *   SOF / Z<override>       Sign off with override (Pocket Guide p.2)
 *
 * Whitespace tolerance: the source examples sometimes show `SON / ZHA`
 * with spaces around the slash for readability. The parser strips
 * whitespace inside the entry before matching.
 *
 * Unimplemented Galileo verbs (deferred): SAI (sign back in), SB/SA/SC/...
 * (work-area switch), OP/W* (active work area), SEM (emulate PCC),
 * STD/Z... (security profile), #RESTART, #DELETEPLUGIN — all land as a
 * `ParseError` which the dialect surfaces as `FORMAT` until they're wired.
 */

import type { ParsedEntry, SignInEntry, SignOutEntry } from '../../protocol/entry.js';
import { ParseError } from '../../protocol/errors.js';

export function parseGalileoEntry(raw: string): ParsedEntry {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ParseError('Empty entry');

  // Strip whitespace inside the entry — sources show `SON / ZHA` formatted
  // for readability; the wire form is `SON/ZHA`. Once we accept more verbs
  // that *do* keep internal spaces (e.g. name fields), this collapses to
  // a more targeted whitespace strip.
  const u = trimmed.replace(/\s+/g, '').toUpperCase();

  if (u.startsWith('SON/Z')) return parseSignOn(trimmed, u);
  if (u === 'SOF' || u.startsWith('SOF/Z')) return parseSignOff(trimmed, u);

  throw new ParseError(`Galileo: unrecognized entry "${trimmed}"`);
}

function parseSignOn(raw: string, u: string): SignInEntry {
  // u is "SON/Z<rest>"; capture rest (usercode, possibly preceded by PCC).
  // The 2009 Pocket Guide documents `SON/ZGL4HA` (PCC + initials); the
  // 2025 Mini Guide simplifies to `SON/Z<usercode>` (own office). For v1
  // we capture the raw remainder as `argument` — handlers can later split
  // PCC from initials if a downstream verb cares.
  const argument = u.slice('SON/Z'.length);
  if (argument.length === 0) throw new ParseError(`Galileo SON/Z: missing user code in "${raw}"`);
  return { kind: 'sign_in', raw, timestamp: new Date(), argument };
}

function parseSignOff(raw: string, u: string): SignOutEntry {
  // Plain `SOF` = sign off the current work area. `SOF/Z<override>` is the
  // override form from the Pocket Guide; the override token isn't acted
  // on (we don't model multi-area sign-on credentials yet), but parsing
  // it lets transcript replay survive.
  if (u !== 'SOF' && !u.startsWith('SOF/Z')) {
    throw new ParseError(`Galileo SOF: bad form "${raw}"`);
  }
  return { kind: 'sign_out', raw, timestamp: new Date(), allAreas: false };
}

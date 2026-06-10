/**
 * Encode/decode rendering shared by Galileo (.CD/.CE/.AD/.AE) and
 * Worldspan (KC//KD//KAC//KAD, translated). Wording reconstructed —
 * no public source shows either host's encode/decode screens.
 */

import { decodeCity, encodeCity, decodeAirline, encodeAirline } from '../../models/reference-data.js';

export function renderEncodeDecode(domain: 'C' | 'A', dir: 'D' | 'E', arg: string): string {
  const term = arg.trim();
  if (domain === 'C') {
    if (dir === 'D') {
      const name = decodeCity(term);
      return name ? `${term}  ${name}` : 'CODE NOT FOUND';
    }
    const hits = encodeCity(term);
    if (hits.length === 0) return 'NAME NOT FOUND';
    return hits.map(([code, name]) => `${code}  ${name}`).join('\n');
  }
  if (dir === 'D') {
    const name = decodeAirline(term);
    return name ? `${term}  ${name}` : 'CODE NOT FOUND';
  }
  const hits = encodeAirline(term);
  if (hits.length === 0) return 'NAME NOT FOUND';
  return hits.map(([code, name]) => `${code}  ${name}`).join('\n');
}

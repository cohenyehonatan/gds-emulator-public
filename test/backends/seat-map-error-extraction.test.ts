/**
 * Tests for `extractSeatMapError` — chunk 7 deferred follow-up #2.
 *
 * Travelport JSON Air v11 returns HTTP 200 + `Result.Error[]` for
 * semantic errors. The extractor maps known GWS error codes (from
 * `references/galileo/Travelport-API-Dev-Notes-Seat-Maps.pdf` p.13)
 * to friendly response strings, with a message-substring fallback
 * for v11 responses that use text-based codes.
 */

import { describe, it, expect } from 'vitest';
import { extractSeatMapError } from '../../src/backends/travelport-mapper.js';

function envelopeWithError(code: string, message: string) {
  return {
    CatalogOfferingsAncillaryListResponse: {
      Result: {
        Error: [{ Code: code, Message: message }],
      },
    },
  };
}

describe('extractSeatMapError — numeric GWS code mapping', () => {
  it('returns undefined when no Result.Error[] is present', () => {
    expect(extractSeatMapError({ CatalogOfferingsAncillaryListResponse: {} })).toBeUndefined();
    expect(extractSeatMapError({ CatalogOfferingsAncillaryListResponse: { Result: {} } })).toBeUndefined();
    expect(extractSeatMapError({ CatalogOfferingsAncillaryListResponse: { Result: { Error: [] } } })).toBeUndefined();
  });

  it('maps code 26 → SEAT MAP UNAVAILABLE', () => {
    const err = extractSeatMapError(envelopeWithError('26', 'Seat Map Unavailable'));
    expect(err?.message).toBe('SEAT MAP UNAVAILABLE');
    expect(err?.rawCode).toBe('26');
  });

  it('maps code 197 → NO SEATS AVAILABLE', () => {
    const err = extractSeatMapError(envelopeWithError('197', 'no seats available for this flight'));
    expect(err?.message).toBe('NO SEATS AVAILABLE');
  });

  it('maps code 200 → NO SEATING THIS FLIGHT', () => {
    const err = extractSeatMapError(envelopeWithError('200', 'No seating'));
    expect(err?.message).toBe('NO SEATING THIS FLIGHT');
  });

  it('maps code 225 → SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT', () => {
    const err = extractSeatMapError(envelopeWithError('225', 'codeshare flight'));
    expect(err?.message).toBe('SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT');
  });

  it('maps code 100 → INVALID BOARD POINT', () => {
    const err = extractSeatMapError(envelopeWithError('100', 'Invalid Board Point'));
    expect(err?.message).toBe('INVALID BOARD POINT');
  });
});

describe('extractSeatMapError — message-fragment fallback', () => {
  it('matches code-share message even without numeric code 225', () => {
    const err = extractSeatMapError(envelopeWithError('VALIDATION', 'Seat map unavailable on code share flight'));
    expect(err?.message).toBe('SEAT MAP UNAVAILABLE - CODE SHARE FLIGHT');
  });

  it('matches "No Seating" message even without numeric code 200', () => {
    const err = extractSeatMapError(envelopeWithError('VALIDATION', 'No seating this flight'));
    expect(err?.message).toBe('NO SEATING THIS FLIGHT');
  });

  it('matches "Invalid Flight Number" message text', () => {
    const err = extractSeatMapError(envelopeWithError('VALIDATION', 'Invalid flight number provided'));
    expect(err?.message).toBe('INVALID FLIGHT NUMBER');
  });

  it('matches "Invalid Class Code" message text', () => {
    const err = extractSeatMapError(envelopeWithError('VALIDATION', 'Invalid class code'));
    expect(err?.message).toBe('INVALID CLASS CODE');
  });
});

describe('extractSeatMapError — unknown code fallback', () => {
  it('surfaces the raw message verbatim when no code or pattern matches', () => {
    const err = extractSeatMapError(envelopeWithError('OBSCURE', 'Some obscure carrier-specific error'));
    expect(err?.message).toBe('Some obscure carrier-specific error');
    expect(err?.rawCode).toBe('OBSCURE');
  });

  it('falls back to a generic message with the code when the message is empty', () => {
    const err = extractSeatMapError(envelopeWithError('999', ''));
    expect(err?.message).toBe('SEAT MAP ERROR (999)');
  });
});

describe('extractSeatMapError — defensive parsing', () => {
  it('accepts lowercase keys (code/message instead of Code/Message)', () => {
    const env = {
      CatalogOfferingsAncillaryListResponse: {
        Result: { Error: [{ code: '197', message: 'No seats' }] },
      },
    };
    const err = extractSeatMapError(env);
    expect(err?.message).toBe('NO SEATS AVAILABLE');
  });

  it('accepts response without the CatalogOfferingsAncillaryListResponse wrapper', () => {
    const env = { Result: { Error: [{ Code: '26', Message: 'unavail' }] } };
    const err = extractSeatMapError(env);
    expect(err?.message).toBe('SEAT MAP UNAVAILABLE');
  });
});

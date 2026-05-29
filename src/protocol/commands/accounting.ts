/**
 * Accounting-line parser (`AC…`). Two forms today:
 *
 *   AC¤…    soft-delete (line / ALL / range / list)
 *   AC/…    add a manual accounting line
 *
 * Sources: Sabre Accounting Lines QR p.1 verbatim — both forms quoted.
 *
 * Modify forms (AC<n>/<carrier>, AC<n>/<carrier>/<commission>,
 * AC<n>¤O/<text>) are deferred to a follow-up.
 */

import type { AccountingDeleteEntry, AccountingAddEntry } from '../entry.js';
import { ParseError } from '../errors.js';

export function parseAccounting(raw: string): AccountingDeleteEntry | AccountingAddEntry {
  if (raw.startsWith('AC¤')) return parseDelete(raw);
  if (raw.startsWith('AC/')) return parseAdd(raw);
  throw new ParseError(`Accounting: expected AC¤<…> or AC/<…> in "${raw}"`);
}

function parseDelete(raw: string): AccountingDeleteEntry {
  const body = raw.slice(3).toUpperCase();
  const base = { kind: 'accounting_delete' as const, raw, timestamp: new Date() };

  if (body === 'ALL') return { ...base, mode: 'all', lines: [] };

  const range = /^(\d+)-(\d+)$/.exec(body);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (to < from) throw new ParseError(`Accounting: bad range "${raw}"`);
    const lines = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return { ...base, mode: 'lines', lines };
  }

  if (/^\d+(,\d+)*$/.test(body)) {
    return { ...base, mode: 'lines', lines: body.split(',').map((n) => parseInt(n, 10)) };
  }

  throw new ParseError(`Accounting: unsupported AC¤ selection "${body}" in "${raw}"`);
}

/**
 * Parse the manual AC create grammar — slash-delimited fields per the
 * QR's verbatim shape. The optional trailing `-<freetext>` is captured
 * after splitting on the first `-` that isn't inside a field.
 */
function parseAdd(raw: string): AccountingAddEntry {
  // Strip the leading "AC/"; split body into "main" and optional "-freetext".
  const body = raw.slice(3);
  const dashAt = body.indexOf('-');
  const main = dashAt === -1 ? body : body.slice(0, dashAt);
  const freeText = dashAt === -1 ? undefined : body.slice(dashAt + 1);

  const fields = main.split('/');
  if (fields.length !== 9) {
    throw new ParseError(`Accounting: expected 9 slash-fields in "${raw}" (got ${fields.length})`);
  }
  const [carrier, ticket, comm, base, taxes, fareApp, fop, docs, tariff] = fields;

  if (!/^[A-Z0-9]{2}$/i.test(carrier)) throw new ParseError(`Accounting: bad carrier "${carrier}" in "${raw}"`);
  if (!/^\d{10,11}$/.test(ticket)) throw new ParseError(`Accounting: bad ticket number "${ticket}" in "${raw}"`);

  // Commission: `P<n>` percent, or a decimal amount.
  let commission: number;
  let commissionPercent = false;
  const pctMatch = /^P(\d+(?:\.\d+)?)$/.exec(comm);
  if (pctMatch) {
    commission = parseFloat(pctMatch[1]);
    commissionPercent = true;
  } else if (/^\d+(?:\.\d+)?$/.test(comm)) {
    commission = parseFloat(comm);
  } else {
    throw new ParseError(`Accounting: bad commission "${comm}" in "${raw}"`);
  }

  if (!/^\d+(?:\.\d+)?$/.test(base)) throw new ParseError(`Accounting: bad base fare "${base}" in "${raw}"`);
  if (!/^\d+(?:\.\d+)?$/.test(taxes)) throw new ParseError(`Accounting: bad taxes "${taxes}" in "${raw}"`);
  if (!['ONE', 'PER', 'ALL'].includes(fareApp.toUpperCase())) {
    throw new ParseError(`Accounting: bad fare application "${fareApp}" in "${raw}"`);
  }
  if (!/^\d+$/.test(docs)) throw new ParseError(`Accounting: bad doc count "${docs}" in "${raw}"`);
  if (!['D', 'F', 'T'].includes(tariff.toUpperCase())) {
    throw new ParseError(`Accounting: bad tariff "${tariff}" in "${raw}"`);
  }

  return {
    kind: 'accounting_add',
    raw,
    timestamp: new Date(),
    line: {
      validatingCarrier: carrier.toUpperCase(),
      ticketNumber: ticket,
      commission,
      commissionPercent,
      baseFare: parseFloat(base),
      taxes: parseFloat(taxes),
      fareApplication: fareApp.toUpperCase() as 'ONE' | 'PER' | 'ALL',
      formOfPayment: fop,
      conjunctDocs: parseInt(docs, 10),
      tariff: tariff.toUpperCase() as 'D' | 'F' | 'T',
      freeText,
    },
  };
}

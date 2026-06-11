/**
 * Sabre back-office interface control — DX / DW / DV families + TJR
 * toggles. Entry forms VERBATIM from the Tres Technologies guide
 * "Sabre GDS Integration for Tres — Setup and Interface" (Zendesk
 * article 13959576143763); response wording RECONSTRUCTED (the guide
 * documents behavior — hold/active states, the TMO NO ACK RCVD
 * reason code, the DWLIST flow — but not the host screens).
 *
 * Returns null for entries that aren't interface control, so the
 * dialect falls through to the normal parser.
 */

import type { HandlerContext } from '../../session/handlers/index.js';

let dwAllPending = false;

export function handleSabreInterfaceControl(u: string, ctx: HandlerContext): string | null {
  const pos = ctx.backend.interfacePos;

  // ── DX family: POS queue control ──
  if (u === 'DX STATUS') {
    const pending = pos.pending().length;
    return [
      'POS QUEUE STATUS',
      `Q1  ${pos.status}`,
      `Q2  ${pos.status}  ${pending} MSG${pending === 1 ? '' : 'S'}`, // Q2 = normal interface records
    ].join('\n');
  }
  if (u === 'DX TRANSMIT') {
    const { sent, error } = pos.transmit();
    if (error) {
      pos.status = 'ON HOLD';
      return 'TMO NO ACK RCVD - CHECK SJPM'; // the guide's most common failure, verbatim reason code
    }
    pos.status = 'ACTIVE';
    return `TRANSMISSION STARTED - ${sent} RECORD${sent === 1 ? '' : 'S'} SENT`;
  }
  if (u === 'DX END') {
    const { sent } = pos.transmit(); // "transmit all pending records, then place back on hold"
    pos.status = 'ON HOLD';
    return `TRANSMISSION ENDED - ${sent} PENDING RECORD${sent === 1 ? '' : 'S'} SENT - Q ON HOLD`;
  }
  if (u === 'DX HOLD') {
    pos.status = 'ON HOLD'; // immediate stop; pending records stay queued
    return `TRANSMISSION HELD - ${pos.pending().length} RECORD(S) REMAIN ON QUEUE`;
  }
  if (u === 'DX HISTORY') {
    if (pos.history.length === 0) return 'NO INTERFACE ACTIVITY';
    return ['INTERFACE HISTORY', ...pos.history.slice(-12).map((h) => {
      const hh = String(h.at.getUTCHours()).padStart(2, '0');
      const mm = String(h.at.getUTCMinutes()).padStart(2, '0');
      return ` ${hh}${mm}Z ${h.text}`;
    })].join('\n');
  }

  // ── DW family: daily work list + retransmission ──
  if (u === 'DWLIST') {
    const list = pos.dwlist();
    if (list.length === 0) return 'DWLIST EMPTY';
    return ['DAILY WORK LIST', ...list.map((r, i) =>
      ` ${i + 1}  INV ${String(r.invoiceNumber).padStart(7, '0')}  ${r.locator}  ${r.passenger}`,
    )].join('\n');
  }
  const dwOne = /^DW(\d{1,3})$/.exec(u);
  if (dwOne) {
    const list = pos.dwlist();
    const rec = list[parseInt(dwOne[1], 10) - 1];
    if (!rec) return 'NOT ON DWLIST';
    rec.transmitted = false; // requeue…
    const { sent, error } = pos.transmit(); // …and resend immediately
    return error ? 'TMO NO ACK RCVD - CHECK SJPM' : `RETRANSMITTED ${sent} RECORD`;
  }
  if (u === 'DWALL') {
    dwAllPending = true;
    return `RETRANSMIT ALL ${pos.dwlist().length} DWLIST RECORDS - CONFIRM WITH DWYES`;
  }
  if (u === 'DWYES') {
    if (!dwAllPending) return 'NOTHING TO CONFIRM - USE DWALL FIRST';
    dwAllPending = false;
    for (const r of pos.dwlist()) r.transmitted = false;
    const { sent, error } = pos.transmit();
    return error ? 'TMO NO ACK RCVD - CHECK SJPM' : `RETRANSMITTED ${sent} RECORD${sent === 1 ? '' : 'S'}`;
  }

  // ── DV family: invoice numbering ──
  if (u === 'DV*PTR') {
    return `NEXT INVOICE NBR ${String(pos.nextInvoice).padStart(7, '0')}`;
  }
  const dvSet = /^DV(\d{1,7})$/.exec(u);
  if (dvSet) {
    pos.nextInvoice = parseInt(dvSet[1], 10);
    return `OK - NEXT INVOICE NBR ${String(pos.nextInvoice).padStart(7, '0')}`;
  }

  // ── TJR toggles (the guide's table, entry forms verbatim) ──
  const tjr = /^W\/(VOD|ETN|RFD|EVOID|IURCCMASK)¥(ON|OFF)$/.exec(u);
  if (tjr) {
    pos.settings.set(tjr[1], tjr[2]);
    return `OK - ${tjr[1]} ${tjr[2]}`;
  }

  // PE*<pcc> — agency options display (the guide: "view your agency
  // options by typing PE*{pcc}").
  const pe = /^PE\*([A-Z0-9]{3,4})$/.exec(u);
  if (pe) {
    const rows = [
      `AGENCY OPTIONS - ${pe[1]}`,
      ' BRNCH (INTERFACE OPTION LEVEL)  6', // Option 6 = interface records (the guide's prerequisite)
      ` INTERFACE QUEUE                 ${ctx.backend.interfacePos.status}`,
    ];
    for (const [k, v] of pos.settings) rows.push(` ${k.padEnd(30)} ${v}`);
    return rows.join('\n');
  }

  return null;
}

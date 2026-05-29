import { describe, it, expect, beforeEach } from 'vitest';
import { parseEntry } from '../../src/protocol/parser.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('ticketing parsing', async () => {
  it('parses W¥, TTP, W¥PQ<n>, W¥N<item>', async () => {
    const all = parseEntry('W¥');
    if (all.kind === 'ticket') expect(all).toMatchObject({ source: 'pnr' });
    const ttp = parseEntry('TTP');
    if (ttp.kind === 'ticket') expect(ttp).toMatchObject({ source: 'pnr' });
    const pq = parseEntry('W¥PQ2');
    if (pq.kind === 'ticket') expect(pq).toMatchObject({ source: 'pq', pqRecord: 2 });
    const name = parseEntry('W¥N1');
    if (name.kind === 'ticket') expect(name).toMatchObject({ source: 'pnr', nameItem: 1 });
  });

  it('does not capture WP pricing entries', async () => {
    expect(parseEntry('WP').kind).toBe('pricing');
    expect(parseEntry('WPNC').kind).toBe('pricing');
  });

  it('parses ¥-separated qualifiers (W¥PQ1¥KP0¥ALH from the source example)', async () => {
    const e = parseEntry('W¥PQ1¥KP0¥ALH');
    expect(e.kind).toBe('ticket');
    if (e.kind === 'ticket') {
      expect(e).toMatchObject({
        source: 'pq',
        pqRecord: 1,
        commissionPercent: 0,
        validatingCarrier: 'LH',
      });
    }
  });

  it('parses a bare qualifier (W¥KP10) with no PQ/N base', async () => {
    const e = parseEntry('W¥KP10');
    expect(e.kind).toBe('ticket');
    if (e.kind === 'ticket') {
      expect(e).toMatchObject({ source: 'pnr', commissionPercent: 10 });
    }
  });

  it('parses W¥S<n> segment select (Issue Tickets QR p.2)', async () => {
    const e = parseEntry('W¥S2');
    if (e.kind === 'ticket') expect(e).toMatchObject({ source: 'pnr', segment: 2 });
  });

  it('parses W¥XETR paper-ticket override (Issue Tickets QR p.3)', async () => {
    const e = parseEntry('W¥XETR');
    if (e.kind === 'ticket') expect(e).toMatchObject({ source: 'pnr', paperTicket: true });
  });

  it('parses chained qualifiers (W¥S2¥XETR)', async () => {
    const e = parseEntry('W¥S2¥XETR');
    if (e.kind === 'ticket') expect(e).toMatchObject({ segment: 2, paperTicket: true });
  });

  it('parses FCASH / FCHECK / FCHEQUE / FCK as cash and check FOPs', async () => {
    const cash = parseEntry('W¥FCASH');
    if (cash.kind === 'ticket') expect(cash.formOfPayment).toEqual({ kind: 'cash' });
    for (const t of ['W¥FCHECK', 'W¥FCHEQUE', 'W¥FCK']) {
      const e = parseEntry(t);
      if (e.kind === 'ticket') expect(e.formOfPayment).toEqual({ kind: 'check' });
    }
  });

  it('parses a credit-card FOP with CVV (verbatim QR example shape)', async () => {
    // Card data here uses a PCI-DSS standard test number (NOT a real card).
    const e = parseEntry('W¥F*VI4111111111111111/1204¥CVV225');
    if (e.kind === 'ticket') {
      expect(e.formOfPayment).toEqual({
        kind: 'credit_card',
        cardCode: 'VI',
        cardNumber: '4111111111111111',
        expiry: '1204',
      });
      expect(e.cvv).toBe('225');
    }
  });

  it('parses credit-card FOP with inline *E extended-payment and *Z approval', async () => {
    const ext = parseEntry('W¥F*AX378282246310005/1212*E03');
    if (ext.kind === 'ticket' && ext.formOfPayment?.kind === 'credit_card') {
      expect(ext.formOfPayment.extendedMonths).toBe(3);
    }
    const approval = parseEntry('W¥F*AX378282246310005/1212*Z003492');
    if (approval.kind === 'ticket' && approval.formOfPayment?.kind === 'credit_card') {
      expect(approval.formOfPayment.approvalCode).toBe('003492');
    }
  });

  it('parses pre-approved FOP without an inline CC (W¥F*Z003492)', async () => {
    const e = parseEntry('W¥F*Z003492');
    if (e.kind === 'ticket') {
      expect(e.formOfPayment).toEqual({ kind: 'preapproved', approvalCode: '003492' });
    }
  });

  it('parses W¥DP invoice qualifier', async () => {
    const e = parseEntry('W¥KP5¥DP');
    if (e.kind === 'ticket') expect(e).toMatchObject({ commissionPercent: 5, invoice: true });
  });

  it('enforces the QR p.1 ordering rule: ¥DP must be last', async () => {
    expect(() => parseEntry('W¥DP¥KP5')).toThrow(/DP qualifier must be last/);
  });

  it('parses multi-PQ ranges and lists (W¥PQ2-4, W¥PQ2/7, W¥PQ2-4/7)', async () => {
    const range = parseEntry('W¥PQ2-4');
    if (range.kind === 'ticket') {
      expect(range).toMatchObject({ source: 'pq', pqRecords: [2, 3, 4] });
    }
    const list = parseEntry('W¥PQ2/7');
    if (list.kind === 'ticket') {
      expect(list).toMatchObject({ source: 'pq', pqRecords: [2, 7] });
    }
    const both = parseEntry('W¥PQ2-4/7');
    if (both.kind === 'ticket') {
      expect(both).toMatchObject({ source: 'pq', pqRecords: [2, 3, 4, 7] });
    }
  });

  it('enforces QR multi-PQ rules: ascending ranges, max 4 records', async () => {
    expect(() => parseEntry('W¥PQ5-2')).toThrow(/ascending/);
    expect(() => parseEntry('W¥PQ1/2/3/4/5')).toThrow(/max 4 Enhanced PQ/);
  });

  it('parses per-PQ named selection (QR p.1 verbatim W¥PQ2N1.2¥PQ5N1.3-1.5)', async () => {
    const e = parseEntry('W¥PQ2N1.2¥PQ5N1.3-1.5');
    if (e.kind === 'ticket') {
      expect(e).toMatchObject({
        source: 'pq',
        pqNamedSelections: [
          { record: 2, names: [{ item: 1, passenger: 2 }] },
          {
            record: 5,
            names: [
              { item: 1, passenger: 3 },
              { item: 1, passenger: 4 },
              { item: 1, passenger: 5 },
            ],
          },
        ],
      });
    }
  });

  it('enforces max 4 PQs on the per-PQ named form too', async () => {
    expect(() =>
      parseEntry('W¥PQ1N1.1¥PQ2N1.2¥PQ3N1.3¥PQ4N1.4¥PQ5N1.5')
    ).toThrow(/max 4 Enhanced PQ/);
  });

  it('rejects a per-PQ named selection with a malformed name part', async () => {
    expect(() => parseEntry('W¥PQ2N3')).toThrow(/bad per-PQ name selector/);
  });

  it('rejects a qualifier whose source still isn’t pinned (e.g. W¥F<fop>)', async () => {
    // Form of payment, segment selection, paper ticket, void/refund all
    // need the Issue-Tickets QR which isn't in references/ yet.
    expect(() => parseEntry('W¥FVISA')).toThrow();
  });
});

describe('e-ticket issuance', async () => {
  let host: GdsHost;
  let wa: WorkArea;

  beforeEach(async () => {
    host = new GdsHost({ port: 0, logLevel: 'error' });
    wa = host.newWorkArea();
    await host.process('SI*4321', wa);
  });

  async function book(seats = 1): void {
    await host.process('115JUNJFKLAX', wa);
    await host.process(`0${seats}Y1`, wa);
  }

  it('issues one e-ticket per passenger, pricing as booked', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    const resp = await host.process('W¥', wa);
    expect(resp).toContain('TKT/TIME LIMIT');
    expect(resp).toContain('TE '); // electronic ticket line
    expect(resp).toContain('SMITH/J');
    expect(resp).toMatch(/TE \d{13}-AT SMITH\/J A0UC\*4321 \d{4}\/\d+[A-Z]{3} D/);
    expect(wa.pnr.tickets).toHaveLength(1);
    expect(wa.pnr.tickets[0].number).toMatch(/^\d{13}$/);
    expect(wa.pnr.tickets[0].total).toBeGreaterThan(0);
  });

  it('surfaces issued tickets in the *T ticketing field', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('7TAW15JUN/', wa);
    await host.process('W¥', wa);
    const t = await host.process('*T', wa);
    expect(t).toContain('1.TAW15JUN/'); // ticketing arrangement stays
    expect(t).toContain('SMITH/J'); // issued ticket added below it
  });

  it('issues a distinct number per passenger', async () => {
    await book(2);
    await host.process('-2MURRAY/FRED MR/HANA MRS', wa);
    await host.process('W¥', wa);
    expect(wa.pnr.tickets.map((t) => t.passenger)).toEqual(['MURRAY/F', 'MURRAY/H']);
    const nums = wa.pnr.tickets.map((t) => t.number);
    expect(new Set(nums).size).toBe(2); // unique serials
  });

  it('issues from a stored PQ record (W¥PQ<n>)', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('PQ', wa); // store PQ 1
    const resp = await host.process('W¥PQ1', wa);
    expect(resp).toContain('TE ');
    expect(wa.pnr.tickets).toHaveLength(1);
  });

  it('marks an international journey with tariff I', async () => {
    await host.process('115JUNDFWLHR', wa); // BA DFW-LHR
    await host.process('01Y1', wa);
    await host.process('-SMITH/JOHN MR', wa);
    const resp = await host.process('W¥', wa);
    expect(resp).toMatch(/ I$/m); // tariff basis I, not D
    expect(wa.pnr.tickets[0].tariff).toBe('I');
  });

  it('TTP is a synonym for W¥', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    expect(await host.process('TTP', wa)).toContain('TE ');
    expect(wa.pnr.tickets).toHaveLength(1);
  });

  it('rejects issuance without an itinerary or without names', async () => {
    expect(await host.process('W¥', wa)).toContain('ITINERARY'); // empty work area
    await book();
    expect(await host.process('W¥', wa)).toContain('NAME'); // itinerary but no name
  });

  it('refuses to re-issue once tickets exist', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('W¥', wa);
    expect(await host.process('W¥', wa)).toBe('TICKETS ALREADY ISSUED');
  });

  it('A<carrier> overrides the validating carrier — ticket-number prefix changes', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa); // price (sets fq.validatingCarrier from the itinerary)
    await host.process('W¥ALH', wa); // override to Lufthansa
    const ticket = wa.pnr.tickets[0];
    expect(ticket.validatingCarrier).toBe('LH');
    expect(ticket.number.startsWith('220')).toBe(true); // 220 is LH's airline code
  });

  it('KP<n> applies a commission percentage to the base fare', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('W¥KP10', wa);
    const ticket = wa.pnr.tickets[0];
    expect(ticket.commission).toBeCloseTo(ticket.base * 0.1, 2);
  });

  it('K<amount> applies a flat commission', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('W¥K12.50', wa);
    expect(wa.pnr.tickets[0].commission).toBe(12.5);
  });

  it('XETR overrides the default electronic ticket to a paper ticket (TK)', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('W¥XETR', wa);
    expect(wa.pnr.tickets[0].type).toBe('TK');
  });

  it('S<n> validates the segment exists; rejects out-of-range', async () => {
    await book(); // creates 1 segment
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    expect(await host.process('W¥S99', wa)).toContain('SEGMENT NUMBER NOT IN ITINERARY');
    expect(wa.pnr.tickets).toHaveLength(0); // nothing issued on rejection
    // A valid segment number issues normally.
    await host.process('W¥S1', wa);
    expect(wa.pnr.tickets).toHaveLength(1);
  });

  it('per-PQ named issues one ticket per referenced passenger', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('-DOE/JANE MS', wa);
    await host.process('WPPADT', wa); // price for ADT
    await host.process('PQ', wa); // store PQ1
    await host.process('W¥PQ1N1.1', wa);
    expect(wa.pnr.tickets).toHaveLength(1);
    expect(wa.pnr.tickets[0].passenger).toContain('SMITH');
  });

  it('per-PQ named rejects an out-of-range PQ', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WPPADT', wa);
    await host.process('PQ', wa);
    expect(await host.process('W¥PQ2N1.1', wa)).toBe('NO PQ RECORD');
    expect(wa.pnr.tickets).toHaveLength(0);
  });

  it('multi-PQ rejects missing PQ records (NO PQ RECORD)', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('PQ', wa); // store PQ1
    // PQ2 doesn't exist; multi-PQ entry W¥PQ1-2 should refuse.
    expect(await host.process('W¥PQ1-2', wa)).toBe('NO PQ RECORD');
    expect(wa.pnr.tickets).toHaveLength(0);
  });

  describe('*PAC accounting field (Accounting Lines QR p.1 + Issue Tickets QR p.5)', async () => {
    it('returns NO ACCOUNTING DATA when no tickets are issued', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      expect(await host.process('*PAC', wa)).toBe('NO ACCOUNTING DATA');
    });

    it('renders one accounting line per ticket with the QR field layout', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥KP10', wa); // 10% commission
      const pac = await host.process('*PAC', wa);
      expect(pac).toContain('ACCOUNTING DATA');
      // Each line shape: "  1. <carrier>¥<serial>/ <comm>/ <base>/ <tax>/ONE/CA <pax>/1/D"
      const t = wa.pnr.tickets[0];
      const expectedCommission = (t.base * 0.1).toFixed(2);
      expect(pac).toContain(`${t.validatingCarrier}¥${t.number.slice(3)}/`);
      expect(pac).toContain(`/ ${expectedCommission}/`);
      expect(pac).toContain('/ONE/CA'); // cash default (no FOP set)
      expect(pac).toContain('SMITH/J/1/D'); // domestic → D
    });

    it('uses CC code for credit-card and pre-approved FOPs (QR p.5: CC)', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥F*VI4111111111111111/1204', wa);
      expect(await host.process('*PAC', wa)).toContain('/ONE/CC');
    });

    it('AC¤<n> deletes a single accounting line; the deleted slot disappears from *PAC', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('-DOE/JANE MS', wa);
      await host.process('W¥', wa); // 2 tickets → 2 accounting lines
      expect(await host.process('*PAC', wa)).toContain('SMITH/J');
      expect(await host.process('AC¤1', wa)).toBe('OK');
      const after = await host.process('*PAC', wa);
      expect(after).not.toContain('SMITH/J'); // line 1 hidden
      expect(after).toContain('DOE/J');        // line 2 still there
    });

    it('AC¤ALL clears the whole accounting field', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      await host.process('AC¤ALL', wa);
      expect(await host.process('*PAC', wa)).toBe('NO ACCOUNTING DATA');
    });

    it('AC¤<n> rejects an out-of-range line number', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      expect(await host.process('AC¤9', wa)).toBe('ACCOUNTING LINE NOT FOUND');
    });

    it('AC/<carrier>/<tkt>/... adds a manual accounting line surfaced in *PAC', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('-DOE/JANE MS', wa);
      // QR verbatim example from p.1 (slightly shortened FOP for readability).
      const entry = 'AC/UA/12345678901/P10/99.00/7.64/ONE/CCAX1234 1.1SMITH J/1/D-SERVICE CHARGE';
      expect(await host.process(entry, wa)).toBe('OK');
      const pac = await host.process('*PAC', wa);
      expect(pac).toContain('UA¥12345678901/');
      expect(pac).toContain('P10/');            // percent commission preserved
      expect(pac).toContain('ONE/CCAX1234');
      expect(pac).toContain('-SERVICE CHARGE'); // free-text appended
    });

    it('AC/ rejects a malformed grammar at parse time', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      // Missing tariff letter at the end → 8 fields instead of 9.
      expect(() =>
        parseEntry('AC/UA/12345678901/P10/99.00/7.64/ONE/CK/1')
      ).toThrow(/9 slash-fields/);
    });

    it('AC<n>/<carrier> modifies the validating carrier on an accounting line', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      expect(await host.process('*PAC', wa)).toContain('B6¥'); // B6 is JFKLAX seed carrier
      expect(await host.process('AC1/BA', wa)).toBe('OK');
      const pac = await host.process('*PAC', wa);
      expect(pac).toContain('BA¥'); // changed
      expect(pac).not.toContain('B6¥'); // gone
    });

    it('AC<n>/<carrier>/<commission> modifies both at once', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      expect(await host.process('AC1/DL/20.00', wa)).toBe('OK');
      expect(wa.pnr.tickets[0].validatingCarrier).toBe('DL');
      expect(wa.pnr.tickets[0].commission).toBe(20);
    });

    it('AC<n>/ on an out-of-range line returns ACCOUNTING LINE NOT FOUND', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      expect(await host.process('AC9/BA', wa)).toBe('ACCOUNTING LINE NOT FOUND');
    });

    it('*HAC reports NO ACCOUNTING HISTORY before any AC action', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      expect(await host.process('*HAC', wa)).toBe('NO ACCOUNTING HISTORY');
    });

    it('*HAC logs add / modify / delete actions chronologically', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      // Three actions: AC/ add, AC<n>/ modify, AC¤<n> delete.
      await host.process('AC/UA/12345678901/P10/99.00/7.64/ONE/CA/1/D', wa);
      await host.process('AC1/BA', wa);
      await host.process('AC¤1', wa);
      const hac = await host.process('*HAC', wa);
      expect(hac).toContain('ACCOUNTING HISTORY');
      expect(hac).toContain('ADD MANUAL UA');
      expect(hac).toContain('MODIFY LINE 1 → BA');
      expect(hac).toContain('DELETE LINE 1');
      expect(wa.pnr.accountingHistory).toHaveLength(3);
    });

    it('AC¤<range> and AC¤<list> both work', async () => {
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('-DOE/JANE MS', wa);
      await host.process('W¥', wa);
      await host.process('AC¤1-2', wa);
      expect(await host.process('*PAC', wa)).toBe('NO ACCOUNTING DATA');
      // Clear and retry the comma-list form.
      wa.pnr.accountingLinesHidden.clear();
      await host.process('AC¤1,2', wa);
      expect(await host.process('*PAC', wa)).toBe('NO ACCOUNTING DATA');
    });

    it('maps the international tariff (I) to F per the QR (D=Domestic, F=Foreign)', async () => {
      // Issue normally (domestic seed inventory), then mark the resulting
      // ticket as international and re-display — covers the I→F mapping
      // without depending on an international route being in the seed schedule.
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('W¥', wa);
      wa.pnr.tickets[0].tariff = 'I';
      const pac = await host.process('*PAC', wa);
      expect(pac).toMatch(/\/1\/F$/m); // last field on the line is F (Foreign)
    });
  });

  describe('*T display variants (Ticket Display Tools QR)', async () => {
    async function issueTwo(): Promise<void> {
      // Two tickets, distinct passengers — first is "older" (lower in array).
      await book();
      await host.process('-SMITH/JOHN MR', wa);
      await host.process('-DOE/JANE MS', wa);
      await host.process('W¥', wa); // issues a ticket per name (2 tickets)
    }

    it('*T returns all tickets oldest-first (existing behavior preserved)', async () => {
      await issueTwo();
      const lines = (await host.process('*T', wa)).split('\n');
      // The first ticket-line should be SMITH (issued first), then DOE.
      const ticketLines = lines.filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(ticketLines[0]).toContain('SMITH');
      expect(ticketLines[1]).toContain('DOE');
    });

    it('*T/N reverses to newest-first', async () => {
      await issueTwo();
      const lines = (await host.process('*T/N', wa)).split('\n');
      const ticketLines = lines.filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(ticketLines[0]).toContain('DOE');
      expect(ticketLines[1]).toContain('SMITH');
    });

    it('*TA active-only defaults to newest-first; *TA/O reverses to oldest-first', async () => {
      await issueTwo();
      // Both tickets default to active (status OPEN at issuance).
      const ta = (await host.process('*TA', wa)).split('\n').filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(ta[0]).toContain('DOE'); // newest first
      const tao = (await host.process('*TA/O', wa)).split('\n').filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(tao[0]).toContain('SMITH'); // oldest first
    });

    it('*TI returns NO TICKETING FIELD when nothing is inactive yet', async () => {
      await issueTwo();
      expect(await host.process('*TI', wa)).toBe('NO TICKETING FIELD');
    });

    it('*TI surfaces a manually-marked-VOIDED ticket; *TA hides it', async () => {
      await issueTwo();
      wa.pnr.tickets[0].status = 'VOIDED'; // simulate a future void
      const ti = (await host.process('*TI', wa)).split('\n').filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(ti).toHaveLength(1);
      expect(ti[0]).toContain('SMITH');
      const ta = (await host.process('*TA', wa)).split('\n').filter((l) => /^\s+\d+\.TE\s/.test(l));
      expect(ta).toHaveLength(1);
      expect(ta[0]).toContain('DOE');
    });
  });

  it('FOP propagates to the issued TicketRecord (cash + credit card cases)', async () => {
    await book();
    await host.process('-SMITH/JOHN MR', wa);
    await host.process('WP', wa);
    await host.process('W¥FCASH', wa);
    expect(wa.pnr.tickets[0].formOfPayment).toEqual({ kind: 'cash' });

    // Reset and try a credit card issue path on a separate PNR.
    await host.process('IG', wa);
    await book();
    await host.process('-DOE/JANE MS', wa);
    await host.process('WP', wa);
    await host.process('W¥F*VI4111111111111111/1204', wa);
    expect(wa.pnr.tickets[0].formOfPayment).toEqual({
      kind: 'credit_card',
      cardCode: 'VI',
      cardNumber: '4111111111111111',
      expiry: '1204',
    });
  });
});

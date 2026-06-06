import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

describe('Galileo live P.<phone> — primary contact', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let host: GdsHost;
  let wa: WorkArea;

  function tokenResponse(): Response {
    return new Response(
      JSON.stringify({ access_token: 'TKN', token_type: 'Bearer', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const createWb = () =>
    new Response(JSON.stringify({ ReservationWorkbench: { Identifier: { value: 'WB-P' } } }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const backend = new LiveTravelportBackend({
      clientId: 'x', clientSecret: 'y', username: 'z', password: 'w',
    });
    host = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S', backend,
    });
    wa = host.newWorkArea();
    await host.process('SON/ZHA', wa);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('P.<phone> with no prior workbench creates one then POSTs primarycontact', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    const resp = await host.process('P.LON*02012345678', wa);
    expect(resp).toBe('OK');
    expect(wa.liveWorkbenchId).toBe('WB-P');
    expect(wa.pnr.phones[0]?.number).toBe('LON*02012345678');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [pcUrl, pcInit] = fetchSpy.mock.calls[2];
    expect(pcUrl).toContain('/primarycontact/reservationworkbench/WB-P/primarycontacts');
    const body = JSON.parse((pcInit?.body as string) ?? '{}');
    // parseCrypticPhone splits the cryptic `<city>*<digits>` form so
    // Travelport's validator (PHONE FIELD CONTAINS INVALID CHARACTER)
    // sees a clean phoneNumber; the city goes on cityCode.
    expect(body.Telephone?.phoneNumber).toBe('02012345678');
    expect(body.Telephone?.cityCode).toBe('LON');
    expect(body.Telephone?.role).toBe('Mobile');
  });

  it('second P.<phone> reuses the existing workbench', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok()); // second primaryContact only — no second createWb

    await host.process('P.LON*1111', wa);
    await host.process('P.NYC*2222', wa);
    expect(wa.pnr.phones.length).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(4);  // not 5
  });

  it('cryptic-strips the raw text before posting (Travelport rejects non-digits)', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(ok());

    // Agency-T* form per Mini Guide v2 p.16. The `*` separator is the
    // cryptic city/digits split; "-JAN" and the embedded space have
    // no place in Travelport's `phoneNumber` field — strip them.
    await host.process('P.T*0793 888184-JAN', wa);
    const [, init] = fetchSpy.mock.calls[2];
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.Telephone.phoneNumber).toBe('0793888184');
    expect(body.Telephone.cityCode).toBe('T');
    // Local pnr.phones still keeps the raw text — Galileo's *R
    // renderer prints whatever the agent typed.
    expect(wa.pnr.phones[0]?.number).toBe('T*0793 888184-JAN');
  });

  it('REST failure surfaces as LIVE BACKEND ERROR; local pnr.phones NOT updated', async () => {
    fetchSpy
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(createWb())
      .mockResolvedValueOnce(new Response('"bad phone"', { status: 400, statusText: 'Bad Request' }));

    const resp = await host.process('P.LON*X', wa);
    expect(resp).toContain('LIVE BACKEND ERROR');
    expect(resp).toContain('400');
    expect(wa.pnr.phones.length).toBe(0);
  });

  it('emulated backend (no live discrimination) still works unchanged', async () => {
    // Emulated regression: spin up a fresh host with no backend override.
    const emulatedHost = new GdsHost({
      port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: '7K9S',
    });
    const ewa = emulatedHost.newWorkArea();
    await emulatedHost.process('SON/ZHA', ewa);
    const resp = await emulatedHost.process('P.LON*02012345678', ewa);
    expect(resp).toBe('OK');
    expect(ewa.pnr.phones[0]?.number).toBe('LON*02012345678');
    expect(ewa.liveWorkbenchId).toBeUndefined();
    // No fetches happened (emulated path doesn't go live).
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

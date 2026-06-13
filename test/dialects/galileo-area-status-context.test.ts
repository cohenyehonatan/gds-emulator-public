import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import { LiveTravelportBackend } from '../../src/backends/live-travelport-backend.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * OP/W* context header. The work-area status now names the PCC and the
 * backend kind, so an operator can tell at the cryptic surface whether
 * they're driving the SHARED pre-prod tenant (LIVE) or local data
 * (EMULATED) — the forensic context for "is the BF on screen mine?".
 */
describe('Galileo OP/W* — PCC + backend-kind context header', () => {
  it('EMULATED backend: header names the PCC and tags EMULATED', async () => {
    const host = new GdsHost({
      port: 0,
      logLevel: 'error',
      dialect: new GalileoDialect(),
      pcc: '7K9S',
    });
    const wa = host.newWorkArea();
    await host.process('SON/Z01UC', wa);
    const resp = await host.process('OP/W*', wa);
    expect(resp).toContain('WORK AREAS  PCC 7K9S  EMULATED');
    expect(resp).not.toContain('LIVE');
    // Active-area row still rendered.
    expect(resp).toMatch(/\*A\s/);
  });

  describe('LIVE backend', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let host: GdsHost;
    let wa: WorkArea;

    beforeEach(async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
      const backend = new LiveTravelportBackend({
        clientId: 'x',
        clientSecret: 'y',
        username: 'z',
        password: 'w',
      });
      host = new GdsHost({
        port: 0,
        logLevel: 'error',
        dialect: new GalileoDialect(),
        pcc: '7K9S',
        backend,
      });
      wa = host.newWorkArea();
      await host.process('SON/Z01UC', wa);
    });

    afterEach(() => fetchSpy.mockRestore());

    it('tags LIVE so the shared-tenant context is visible — no fetch needed', async () => {
      const resp = await host.process('OP/W*', wa);
      expect(resp).toContain('WORK AREAS  PCC 7K9S  LIVE');
      // OP/W* is a local status display — it must not hit the wire.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

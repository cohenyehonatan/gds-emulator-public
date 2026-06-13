import { describe, it, expect, beforeEach } from 'vitest';
import { GalileoDialect } from '../../src/dialects/galileo/index.js';
import { SabreDialect } from '../../src/dialects/sabre/index.js';
import { GdsHost } from '../../src/session/gds-host.js';
import type { WorkArea } from '../../src/session/work-area.js';

/**
 * Area switching presupposes a signed-on session. Before this gate,
 * S<a> (Galileo) / ¤<a> (Sabre) flipped the active area with no session
 * behind it, rendering the "no agent" placeholder (AGT). Now it's gated
 * on wa.agent like sell (FSM) and Amadeus JM, and sign-off clears the
 * agent so the gate re-blocks.
 */
describe('area switch — sign-on gate', () => {
  describe('Galileo S<a>', () => {
    let host: GdsHost;
    let wa: WorkArea;
    beforeEach(() => {
      host = new GdsHost({ port: 0, logLevel: 'error', dialect: new GalileoDialect(), pcc: 'A0UC' });
      wa = host.newWorkArea();
    });

    it('rejects pre-sign-on with NEED SIGN ON (no AGT placeholder)', async () => {
      const resp = await host.process('SB', wa);
      expect(resp).toBe('NEED SIGN ON - USE SON/Z');
      expect(resp).not.toContain('AGT');
      expect(wa.area).toBe('A'); // did not flip
    });

    it('allows switching once signed on, naming the real agent', async () => {
      await host.process('SON/Z01UC', wa);
      const resp = await host.process('SB', wa);
      expect(resp).toContain('*01UC..B');
      expect(wa.area).toBe('B');
    });

    it('re-blocks after sign-off (agent cleared)', async () => {
      await host.process('SON/Z01UC', wa);
      await host.process('SOF', wa);
      expect(await host.process('SB', wa)).toBe('NEED SIGN ON - USE SON/Z');
    });
  });

  describe('Sabre ¤<a>', () => {
    let host: GdsHost;
    let wa: WorkArea;
    beforeEach(() => {
      host = new GdsHost({ port: 0, logLevel: 'error', dialect: new SabreDialect(), pcc: 'A0UC' });
      wa = host.newWorkArea();
    });

    it('rejects pre-sign-on with NEED SIGN ON', async () => {
      const resp = await host.process('¤B', wa);
      expect(resp).toBe('NEED SIGN ON - USE SI');
      expect(wa.area).toBe('A');
    });

    it('allows switching once signed on', async () => {
      await host.process('SIHA', wa);
      await host.process('¤B', wa);
      expect(wa.area).toBe('B');
    });
  });
});

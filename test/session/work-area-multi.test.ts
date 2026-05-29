import { describe, it, expect } from 'vitest';
import { WorkArea, WorkAreaSlot } from '../../src/session/work-area.js';
import { Pnr } from '../../src/models/pnr.js';
import { SessionState, SessionEvent } from '../../src/session/session-state.js';

describe('WorkArea — multi-area container', () => {
  it('constructs with six areas A-F by default', () => {
    const wa = new WorkArea();
    expect(wa.allAreaLetters()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(wa.area).toBe('A');
  });

  it('constructs with a custom set of letters (e.g. Galileo A-E)', () => {
    const wa = new WorkArea(['A', 'B', 'C', 'D', 'E']);
    expect(wa.allAreaLetters()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('rejects an empty area set', () => {
    expect(() => new WorkArea([])).toThrow();
  });

  it('switchTo(letter) moves the active area; switchTo(unknown) returns false', () => {
    const wa = new WorkArea();
    expect(wa.switchTo('D')).toBe(true);
    expect(wa.area).toBe('D');
    expect(wa.switchTo('Z')).toBe(false);
    expect(wa.area).toBe('D'); // unchanged
  });

  it('each slot has its own PNR — building in one area does not affect another', () => {
    const wa = new WorkArea();
    expect(wa.pnr.names.length).toBe(0);
    wa.pnr.names.push({ surname: 'SMITH', infant: false, count: 1, passengers: [{ firstName: 'JOHN' }] });
    wa.switchTo('B');
    expect(wa.pnr.names.length).toBe(0); // B's PNR is independent
    wa.switchTo('A');
    expect(wa.pnr.names.length).toBe(1); // A's PNR survived
    expect(wa.pnr.names[0].surname).toBe('SMITH');
  });

  it('each slot has its own SessionMachine — FSM state is per-area', () => {
    const wa = new WorkArea();
    wa.machine.transition(SessionEvent.SIGN_IN);
    expect(wa.state()).toBe(SessionState.EMPTY);
    wa.switchTo('B');
    expect(wa.state()).toBe(SessionState.SIGNED_OFF); // B's FSM is fresh
    wa.switchTo('A');
    expect(wa.state()).toBe(SessionState.EMPTY); // A's FSM survived
  });

  it('reset() clears only the active slot and preserves the FSM', () => {
    const wa = new WorkArea();
    wa.machine.transition(SessionEvent.SIGN_IN);
    wa.pnr = new Pnr();
    wa.pnr.locator = 'TEST00';
    wa.switchTo('B');
    wa.machine.transition(SessionEvent.SIGN_IN);
    wa.pnr.locator = 'BBBB00';
    wa.switchTo('A');
    wa.reset();
    expect(wa.pnr.locator).toBeUndefined(); // A reset
    expect(wa.state()).toBe(SessionState.EMPTY); // A's machine preserved (signed in, no PNR)
    wa.switchTo('B');
    expect(wa.pnr.locator).toBe('BBBB00'); // B untouched
  });

  it('resetAll() clears every slot but preserves every machine', () => {
    const wa = new WorkArea();
    wa.machine.transition(SessionEvent.SIGN_IN);
    wa.switchTo('B');
    wa.machine.transition(SessionEvent.SIGN_IN);
    wa.pnr.locator = 'BBBB00';
    wa.resetAll();
    expect(wa.pnr.locator).toBeUndefined(); // B cleared
    wa.switchTo('A');
    expect(wa.pnr.locator).toBeUndefined(); // A cleared
    expect(wa.state()).toBe(SessionState.EMPTY); // A's FSM survived (still signed in)
  });

  it('slot(letter) returns the underlying WorkAreaSlot for direct access', () => {
    const wa = new WorkArea();
    const slotA = wa.slot('A');
    expect(slotA).toBeInstanceOf(WorkAreaSlot);
    expect(wa.slot('Z')).toBeUndefined();
  });

  it('agent is session-level — spans all areas (Sabre QR p.7)', () => {
    const wa = new WorkArea();
    wa.agent = 'ALJ';
    expect(wa.agent).toBe('ALJ');
    wa.switchTo('D');
    expect(wa.agent).toBe('ALJ'); // session-level, not per-slot
  });
});

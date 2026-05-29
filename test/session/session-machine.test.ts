import { describe, it, expect } from 'vitest';
import { SessionMachine, InvalidTransitionError } from '../../src/session/session-machine.js';
import { SessionState, SessionEvent } from '../../src/session/session-state.js';

describe('SessionMachine', async () => {
  it('starts SIGNED_OFF', async () => {
    expect(new SessionMachine().getState()).toBe(SessionState.SIGNED_OFF);
  });

  it('walks the build-and-commit path', async () => {
    const m = new SessionMachine();
    expect(m.transition(SessionEvent.SIGN_IN)).toBe(SessionState.EMPTY);
    expect(m.transition(SessionEvent.SELL)).toBe(SessionState.BUILDING);
    expect(m.transition(SessionEvent.ADD_FIELD)).toBe(SessionState.BUILDING); // self-loop
    expect(m.transition(SessionEvent.END_TX)).toBe(SessionState.EMPTY);
  });

  it('retrieves into DISPLAYED and ignores back to EMPTY', async () => {
    const m = new SessionMachine(SessionState.EMPTY);
    expect(m.transition(SessionEvent.RETRIEVE)).toBe(SessionState.DISPLAYED);
    expect(m.transition(SessionEvent.IGNORE)).toBe(SessionState.EMPTY);
  });

  it('throws on an illegal transition (sell before sign-in)', async () => {
    const m = new SessionMachine();
    expect(() => m.transition(SessionEvent.SELL)).toThrow(InvalidTransitionError);
  });

  it('cannot END_TX from EMPTY', async () => {
    const m = new SessionMachine(SessionState.EMPTY);
    expect(m.canTransition(SessionEvent.END_TX)).toBe(false);
  });
});

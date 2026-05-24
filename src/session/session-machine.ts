/**
 * Table-driven session state machine.
 *
 * Enforces the transitions declared in session-state.ts and emits events for
 * logging/observation. Structurally identical to the printer emulator's
 * StateMachine — only the state/event vocabulary differs.
 */

import { EventEmitter } from 'events';
import { SessionState, SessionEvent, TRANSITIONS } from './session-state.js';
import type { Transition } from './session-state.js';

export class SessionMachine extends EventEmitter {
  private currentState: SessionState;
  private transitionMap: Map<string, Transition>;

  constructor(initialState: SessionState = SessionState.SIGNED_OFF) {
    super();
    this.currentState = initialState;
    this.transitionMap = new Map();
    for (const t of TRANSITIONS) {
      this.transitionMap.set(`${t.from}:${t.event}`, t);
    }
  }

  getState(): SessionState {
    return this.currentState;
  }

  /** Attempt a transition. Throws InvalidTransitionError if not allowed. */
  transition(event: SessionEvent): SessionState {
    const transition = this.transitionMap.get(`${this.currentState}:${event}`);
    if (!transition) throw new InvalidTransitionError(this.currentState, event);

    const previousState = this.currentState;
    this.currentState = transition.to;
    this.emit('transition', { from: previousState, to: this.currentState, event });
    return this.currentState;
  }

  canTransition(event: SessionEvent): boolean {
    return this.transitionMap.has(`${this.currentState}:${event}`);
  }

  getValidEvents(): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const [key] of this.transitionMap) {
      const [state, event] = key.split(':');
      if (state === this.currentState) events.push(event as SessionEvent);
    }
    return events;
  }

  forceState(state: SessionState): void {
    const previous = this.currentState;
    this.currentState = state;
    this.emit('transition', { from: previous, to: state, event: 'FORCE_SET' });
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly fromState: SessionState,
    public readonly event: SessionEvent
  ) {
    super(`Invalid transition: cannot handle event ${event} in state ${fromState}`);
    this.name = 'InvalidTransitionError';
  }
}

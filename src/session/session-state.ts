/**
 * AAA work-area session states and transitions.
 *
 * The GDS analog of the printer FSM. A terminal session moves through these
 * states as the agent signs in, builds or retrieves a PNR, and ends the
 * transaction. Declared as data for table-driven enforcement and easy testing
 * against the spec — same shape as the printer emulator's states.ts.
 *
 * Note: mandatory-field completeness (the PRINT rule) is NOT encoded here.
 * The FSM only governs whether END_TX is structurally legal; the end-tx
 * handler decides whether the PNR is complete enough to commit.
 */

export enum SessionState {
  SIGNED_OFF = 'SIGNED_OFF',
  EMPTY = 'EMPTY', // signed in, work area empty
  BUILDING = 'BUILDING', // assembling a new PNR
  DISPLAYED = 'DISPLAYED', // an existing PNR retrieved into the work area
}

export enum SessionEvent {
  SIGN_IN = 'SIGN_IN',
  SIGN_OFF = 'SIGN_OFF',
  ADD_FIELD = 'ADD_FIELD', // name/phone/ticketing/received-from
  SELL = 'SELL',
  MODIFY = 'MODIFY', // cancel segment / change status — legal only with a PNR present
  RETRIEVE = 'RETRIEVE',
  END_TX = 'END_TX', // success commits + clears the work area
  IGNORE = 'IGNORE',
}

export interface Transition {
  from: SessionState;
  event: SessionEvent;
  to: SessionState;
}

export const TRANSITIONS: Transition[] = [
  // Sign in / out
  { from: SessionState.SIGNED_OFF, event: SessionEvent.SIGN_IN, to: SessionState.EMPTY },
  { from: SessionState.EMPTY, event: SessionEvent.SIGN_OFF, to: SessionState.SIGNED_OFF },
  { from: SessionState.BUILDING, event: SessionEvent.SIGN_OFF, to: SessionState.SIGNED_OFF },
  { from: SessionState.DISPLAYED, event: SessionEvent.SIGN_OFF, to: SessionState.SIGNED_OFF },

  // Start building a new PNR from an empty work area
  { from: SessionState.EMPTY, event: SessionEvent.ADD_FIELD, to: SessionState.BUILDING },
  { from: SessionState.EMPTY, event: SessionEvent.SELL, to: SessionState.BUILDING },

  // Continue building (self-loops, like the printer's MODE_SET → MODE_SET)
  { from: SessionState.BUILDING, event: SessionEvent.ADD_FIELD, to: SessionState.BUILDING },
  { from: SessionState.BUILDING, event: SessionEvent.SELL, to: SessionState.BUILDING },
  { from: SessionState.BUILDING, event: SessionEvent.MODIFY, to: SessionState.BUILDING },

  // Retrieve an existing PNR (also when advancing through a queue, replacing
  // the on-screen PNR with the next one)
  { from: SessionState.EMPTY, event: SessionEvent.RETRIEVE, to: SessionState.DISPLAYED },
  { from: SessionState.DISPLAYED, event: SessionEvent.RETRIEVE, to: SessionState.DISPLAYED },

  // Modify a retrieved PNR
  { from: SessionState.DISPLAYED, event: SessionEvent.ADD_FIELD, to: SessionState.DISPLAYED },
  { from: SessionState.DISPLAYED, event: SessionEvent.SELL, to: SessionState.DISPLAYED },
  { from: SessionState.DISPLAYED, event: SessionEvent.MODIFY, to: SessionState.DISPLAYED },

  // End transaction → back to empty work area
  { from: SessionState.BUILDING, event: SessionEvent.END_TX, to: SessionState.EMPTY },
  { from: SessionState.DISPLAYED, event: SessionEvent.END_TX, to: SessionState.EMPTY },

  // Ignore → discard, back to empty
  { from: SessionState.BUILDING, event: SessionEvent.IGNORE, to: SessionState.EMPTY },
  { from: SessionState.DISPLAYED, event: SessionEvent.IGNORE, to: SessionState.EMPTY },
  { from: SessionState.EMPTY, event: SessionEvent.IGNORE, to: SessionState.EMPTY },
];

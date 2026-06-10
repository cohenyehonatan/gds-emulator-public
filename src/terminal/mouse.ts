/**
 * Mouse-wheel support for the CRT REPL.
 *
 * The terminal reports wheel events as SGR mouse sequences
 * (`\x1b[<64;COL;ROWM` wheel-up, `\x1b[<65;COL;ROWM` wheel-down —
 * enabled by CrtScreen's MOUSE_ON). Those bytes arrive on stdin
 * interleaved with keystrokes; if readline saw them it would treat
 * `<64;12;8M` as typed characters. So stdin is piped through this
 * filter BEFORE readline:
 *
 *   - SGR mouse sequences are stripped from the stream
 *   - wheel events are routed by ROW:
 *       input row    → an arrow-key sequence (`\x1b[A` / `\x1b[B`) is
 *                      substituted into the stream, so readline drives
 *                      its own command history exactly as if the
 *                      arrow key had been pressed
 *       anywhere else → the onScroll callback (the CRT scrollback)
 *   - non-wheel mouse events (clicks) are stripped and dropped
 *   - everything else passes through byte-for-byte
 *
 * Sequences split across stdin chunks are handled with a carry
 * buffer (a chunk ending mid-`\x1b[<…` is held until the next one).
 */

import { Transform } from 'stream';

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
/** A trailing prefix of an SGR sequence that may continue next chunk
 *  (`\x1b`, `\x1b[`, or `\x1b[<` followed by any digits/semicolons). */
const PARTIAL_TAIL = /\x1b(?:\[(?:<[\d;]*)?)?$/;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

export interface MouseFilterOptions {
  /** 1-indexed row of the input line — wheel events here become arrows. */
  inputRow: () => number;
  /** Wheel events anywhere else (dir: 1 = up/older, -1 = down/newer). */
  onScroll: (dir: 1 | -1) => void;
}

/**
 * Build the stdin→readline filter. Pipe raw stdin in; hand the
 * returned stream to readline as its `input` (with `terminal: true` —
 * the filter itself isn't a TTY).
 */
export function createMouseFilter(opts: MouseFilterOptions): Transform {
  let carry = '';
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let data = carry + chunk.toString('binary');
      carry = '';
      let out = '';
      for (;;) {
        const m = SGR_MOUSE.exec(data);
        if (!m) break;
        out += data.slice(0, m.index);
        data = data.slice(m.index + m[0].length);
        if (m[4] !== 'M') continue; // release events: drop
        const button = parseInt(m[1], 10);
        const row = parseInt(m[3], 10);
        if (button !== WHEEL_UP && button !== WHEEL_DOWN) continue; // clicks: drop
        if (row === opts.inputRow()) {
          out += button === WHEEL_UP ? ARROW_UP : ARROW_DOWN;
        } else {
          opts.onScroll(button === WHEEL_UP ? 1 : -1);
        }
      }
      // Hold an incomplete escape tail for the next chunk.
      const partial = PARTIAL_TAIL.exec(data);
      if (partial && partial[0].length > 0) {
        carry = partial[0];
        data = data.slice(0, data.length - partial[0].length);
      }
      out += data;
      cb(null, Buffer.from(out, 'binary'));
    },
  });
}

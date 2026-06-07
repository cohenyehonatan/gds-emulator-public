/**
 * Green-screen CRT renderer — a full-screen framed display for the REPL.
 *
 * Raw ANSI, zero dependencies. Uses the alternate screen buffer so the user's
 * scrollback is preserved, draws a bordered frame (status bar + response area
 * + input row) in phosphor green, and positions every line by absolute cursor
 * address so it never relies on terminal line-wrapping.
 *
 * Layout (1-indexed rows, terminal height H):
 *   1        top border
 *   2        status bar  (AAA / session state / clock)
 *   3        separator
 *   4 .. H-3 response area (tail of the scrollback)
 *   H-2      separator
 *   H-1      input row     (caret drawn here by readline)
 *   H        bottom border
 */

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const BOLD_GREEN = `${ESC}[1;32m`;
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const WRAP_OFF = `${ESC}[?7l`;
const WRAP_ON = `${ESC}[?7h`;
const SHOW_CURSOR = `${ESC}[?25h`;

/** Truncate or space-pad a plain (ANSI-free) string to an exact width. */
function fit(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

export class CrtScreen {
  private lines: string[] = [];

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    /** Short label rendered in the status bar (e.g. 'SABRE GDS', 'GALILEO'). */
    private readonly screenName: string = 'SABRE GDS',
  ) {}

  get cols(): number {
    return this.out.columns ?? 80;
  }
  get rows(): number {
    return this.out.rows ?? 24;
  }

  /** Column / row (1-indexed) where the input caret sits. */
  inputCol(): number {
    return 3; // after "│ "
  }
  inputRow(): number {
    return this.rows - 1;
  }

  enter(): void {
    this.out.write(ALT_ON + WRAP_OFF + GREEN);
  }

  leave(): void {
    this.out.write(WRAP_ON + RESET + ALT_OFF + SHOW_CURSOR);
  }

  /**
   * Redraw the input row's right-border character at column W without
   * disturbing the cursor position. WRAP_OFF means typed characters that
   * would otherwise wrap pile up at column W and overwrite the border
   * `│` — calling this after each keypress restores the border immediately.
   *
   * Uses DEC-style save/restore (`\x1b7` / `\x1b8`) which is wider-
   * supported than the SCO `\x1b[s` / `\x1b[u` variant.
   */
  redrawRightBorder(): void {
    const row = this.inputRow();
    const col = this.cols;
    this.out.write(`${ESC}7${ESC}[${row};${col}H${BOLD_GREEN}│${RESET}${ESC}8`);
  }

  /** Append a host response (or any text block) to the scrollback. */
  print(text: string): void {
    for (const line of text.split('\n')) this.lines.push(line);
  }

  /** Echo a submitted cryptic entry into the scrollback. */
  printEntry(entry: string): void {
    this.lines.push(`› ${entry}`);
  }

  /** Repaint the whole frame. `statusLeft` is the left-aligned status text. */
  render(statusLeft: string): void {
    const W = this.cols;
    const H = this.rows;
    const inner = Math.max(0, W - 2);

    const border = (left: string, mid: string, right: string) =>
      BOLD_GREEN + left + mid.repeat(inner) + right + RESET;
    const row = (content: string, color = GREEN) =>
      `${BOLD_GREEN}│${color}${fit(content, inner)}${BOLD_GREEN}│${RESET}`;

    // Status bar: title + AAA/state on the left, clock on the right.
    const left = ` ${this.screenName}   ${statusLeft}`;
    const right = `${clock()} `;
    const gap = Math.max(1, inner - left.length - right.length);
    const status = fit(left + ' '.repeat(gap) + right, inner);

    // Response area: the tail of the scrollback, blank-padded to fill.
    const areaH = Math.max(0, H - 6);
    const tail = this.lines.slice(-areaH);
    while (tail.length < areaH) tail.push('');

    const frameLines: string[] = [];
    frameLines.push(border('┌', '─', '┐')); // 1
    frameLines.push(row(status, BOLD_GREEN)); // 2
    frameLines.push(border('├', '─', '┤')); // 3
    for (const line of tail) frameLines.push(row(' ' + line)); // 4 .. H-3
    frameLines.push(border('├', '─', '┤')); // H-2
    frameLines.push(row(' ')); // H-1 input row (caret drawn by readline)
    frameLines.push(border('└', '─', '┘')); // H

    // Address each row absolutely so full-width lines never trigger wrap.
    let out = '';
    for (let i = 0; i < frameLines.length && i < H; i++) {
      out += `${ESC}[${i + 1};1H${frameLines[i]}`;
    }
    this.out.write(out);
  }
}

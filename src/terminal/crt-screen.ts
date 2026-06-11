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
// SGR mouse reporting: 1000 = button events (wheel arrives as
// buttons 64/65), 1006 = SGR encoding (unambiguous, row/col > 223 safe).
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

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
  /** Scrollback viewport offset — 0 = live tail; >0 = scrolled up. */
  private scrollOffset = 0;
  /** Last status text from render() — the clock ticker repaints with it. */
  private lastStatusLeft?: string;
  private ticker?: NodeJS.Timeout;

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
    this.out.write(ALT_ON + WRAP_OFF + GREEN + MOUSE_ON);
    // The status-bar clock only advanced on render() — i.e. per
    // entry — so it sat frozen between commands. Tick the status
    // row once a second (cursor-safe targeted repaint; unref'd so
    // it never holds the process open).
    this.ticker = setInterval(() => this.repaintStatus(), 1000);
    this.ticker.unref?.();
  }

  leave(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.out.write(MOUSE_OFF + WRAP_ON + RESET + ALT_OFF + SHOW_CURSOR);
  }

  /**
   * Repaint ONLY the status row (row 2) with the last-rendered
   * status text + a fresh clock, without disturbing the cursor —
   * the same DEC save/restore approach as redrawRightBorder.
   */
  repaintStatus(): void {
    if (this.lastStatusLeft == null) return;
    const inner = Math.max(0, this.cols - 2);
    this.out.write(
      `${ESC}7${ESC}[2;2H${BOLD_GREEN}${fit(this.statusContent(this.lastStatusLeft, inner), inner)}${RESET}${ESC}8`,
    );
  }

  /** Status-row content: title + status on the left, scroll marker + clock right. */
  private statusContent(statusLeft: string, inner: number): string {
    const left = ` ${this.screenName}   ${statusLeft}`;
    const right = `${this.scrollOffset > 0 ? `▲${this.scrollOffset}  ` : ''}${clock()} `;
    const gap = Math.max(1, inner - left.length - right.length);
    return fit(left + ' '.repeat(gap) + right, inner);
  }

  /** Scroll the response viewport up (towards older output). */
  scrollUp(n = 3): void {
    const areaH = Math.max(0, this.rows - 6);
    const max = Math.max(0, this.lines.length - areaH);
    this.scrollOffset = Math.min(max, this.scrollOffset + n);
  }

  /** Scroll the response viewport down (towards the live tail). */
  scrollDown(n = 3): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
  }

  get scrolled(): number {
    return this.scrollOffset;
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

  /** Append a host response (or any text block) to the scrollback.
   *  New output snaps the viewport back to the live tail. */
  print(text: string): void {
    for (const line of text.split('\n')) this.lines.push(line);
    this.scrollOffset = 0;
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
    this.lastStatusLeft = statusLeft;
    const status = this.statusContent(statusLeft, inner);

    // Response area: the viewport into the scrollback (offset 0 =
    // live tail; mouse wheel scrolls it), blank-padded to fill.
    const areaH = Math.max(0, H - 6);
    const end = this.lines.length - this.scrollOffset;
    const tail = this.lines.slice(Math.max(0, end - areaH), end);
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

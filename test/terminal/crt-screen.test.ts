import { describe, it, expect } from 'vitest';
import { CrtScreen } from '../../src/terminal/crt-screen.js';

/** Minimal fake WriteStream that captures writes and reports a fixed size. */
function fakeStream(columns: number, rows: number) {
  let buf = '';
  const stream = {
    columns,
    rows,
    write: (s: string) => {
      buf += s;
      return true;
    },
    getBuffer: () => buf,
    clear: () => {
      buf = '';
    },
  };
  return stream as unknown as NodeJS.WriteStream & {
    getBuffer(): string;
    clear(): void;
  };
}

describe('CrtScreen', async () => {
  it('reports the input caret position relative to terminal size', async () => {
    const screen = new CrtScreen(fakeStream(80, 24));
    expect(screen.inputRow()).toBe(23); // H-1
    expect(screen.inputCol()).toBe(3); // after "│ "
  });

  it('renders a full box frame with status and scrollback content', async () => {
    const out = fakeStream(40, 12);
    const screen = new CrtScreen(out);
    screen.print('ABCDEF'); // a fake host response line
    out.clear();
    screen.render('AAA 4321   [BUILDING]');
    const frame = out.getBuffer();

    // Border corners and separators are present.
    for (const ch of ['┌', '┐', '└', '┘', '├', '┤']) {
      expect(frame).toContain(ch);
    }
    // Status bar and the printed response line made it into the frame.
    expect(frame).toContain('SABRE GDS');
    expect(frame).toContain('[BUILDING]');
    expect(frame).toContain('ABCDEF');
    // Every row is addressed absolutely (no reliance on wrapping).
    expect(frame).toContain('\x1b[1;1H');
    expect(frame).toContain('\x1b[12;1H');
  });

  it('keeps only the tail of the scrollback that fits the response area', async () => {
    const out = fakeStream(40, 12); // areaH = H-6 = 6 visible response rows
    const screen = new CrtScreen(out);
    for (let i = 0; i < 50; i++) screen.print(`LINE${i}`);
    out.clear();
    screen.render('AAA 4321   [EMPTY]');
    const frame = out.getBuffer();

    expect(frame).toContain('LINE49'); // newest shown
    expect(frame).not.toContain('LINE40'); // scrolled off the top
  });

  describe('redrawRightBorder — CRT polish for live typing', () => {
    it('emits the border char at column W of the input row, wrapped in save/restore cursor', () => {
      const stream = fakeStream(80, 24);
      const screen = new CrtScreen(stream);
      screen.redrawRightBorder();
      const out = stream.getBuffer();
      // Save cursor: ESC 7
      expect(out).toContain('\x1b7');
      // Position to (inputRow, cols) = (23, 80)
      expect(out).toContain('\x1b[23;80H');
      // Border char with bold-green color
      expect(out).toContain('│');
      // Restore cursor: ESC 8
      expect(out).toContain('\x1b8');
    });

    it('uses the actual stream dimensions (not a hardcoded 80x24)', () => {
      const stream = fakeStream(132, 50);
      const screen = new CrtScreen(stream);
      screen.redrawRightBorder();
      const out = stream.getBuffer();
      // Position to (inputRow, cols) = (49, 132)
      expect(out).toContain('\x1b[49;132H');
    });

    it('idempotent: multiple consecutive calls produce the same border position', () => {
      const stream = fakeStream(80, 24);
      const screen = new CrtScreen(stream);
      screen.redrawRightBorder();
      stream.clear();
      screen.redrawRightBorder();
      const out2 = stream.getBuffer();
      expect(out2).toContain('\x1b[23;80H');
      expect(out2).toContain('│');
    });
  });
});

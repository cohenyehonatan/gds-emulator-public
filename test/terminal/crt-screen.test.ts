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

describe('CrtScreen', () => {
  it('reports the input caret position relative to terminal size', () => {
    const screen = new CrtScreen(fakeStream(80, 24));
    expect(screen.inputRow()).toBe(23); // H-1
    expect(screen.inputCol()).toBe(3); // after "│ "
  });

  it('renders a full box frame with status and scrollback content', () => {
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

  it('keeps only the tail of the scrollback that fits the response area', () => {
    const out = fakeStream(40, 12); // areaH = H-6 = 6 visible response rows
    const screen = new CrtScreen(out);
    for (let i = 0; i < 50; i++) screen.print(`LINE${i}`);
    out.clear();
    screen.render('AAA 4321   [EMPTY]');
    const frame = out.getBuffer();

    expect(frame).toContain('LINE49'); // newest shown
    expect(frame).not.toContain('LINE40'); // scrolled off the top
  });
});

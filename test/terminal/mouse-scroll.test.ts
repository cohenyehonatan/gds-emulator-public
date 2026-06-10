/**
 * Mouse-wheel support: the stdin SGR filter (wheel on the response
 * area → CRT scrollback; wheel on the input row → arrow-key
 * substitution so readline drives command history) and the
 * CrtScreen scroll viewport.
 */

import { describe, it, expect } from 'vitest';
import { createMouseFilter } from '../../src/terminal/mouse.js';
import { CrtScreen } from '../../src/terminal/crt-screen.js';
import { Writable } from 'stream';

function run(chunks: string[], inputRow = 23) {
  const scrolls: number[] = [];
  const filter = createMouseFilter({ inputRow: () => inputRow, onScroll: (d) => scrolls.push(d) });
  let out = '';
  filter.on('data', (b: Buffer) => { out += b.toString('binary'); });
  for (const c of chunks) filter.write(Buffer.from(c, 'binary'));
  return { out, scrolls };
}

describe('createMouseFilter', () => {
  it('wheel on the response area strips the sequence and fires onScroll', () => {
    const { out, scrolls } = run(['AB\x1b[<64;10;5MCD\x1b[<65;10;6MEF']);
    expect(out).toBe('ABCDEF');
    expect(scrolls).toEqual([1, -1]);
  });

  it('wheel on the input row substitutes arrow-key sequences', () => {
    const { out, scrolls } = run(['\x1b[<64;10;23M\x1b[<65;10;23M']);
    expect(out).toBe('\x1b[A\x1b[B');
    expect(scrolls).toEqual([]);
  });

  it('clicks and release events are stripped and dropped', () => {
    const { out, scrolls } = run(['X\x1b[<0;5;5M\x1b[<0;5;5mY']);
    expect(out).toBe('XY');
    expect(scrolls).toEqual([]);
  });

  it('sequences split across chunks reassemble', () => {
    const { out, scrolls } = run(['HI\x1b[<6', '4;10;', '5MOK']);
    expect(out).toBe('HIOK');
    expect(scrolls).toEqual([1]);
  });

  it('plain keystrokes and other escapes pass through byte-for-byte', () => {
    const { out } = run(['SON/Z01UC\r', '\x1b[A', '\x1b[D']);
    expect(out).toBe('SON/Z01UC\r\x1b[A\x1b[D');
  });
});

describe('CrtScreen scroll viewport', () => {
  function makeScreen(): CrtScreen {
    const sink = new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream;
    (sink as { columns?: number }).columns = 80;
    (sink as { rows?: number }).rows = 24;
    return new CrtScreen(sink, 'TEST');
  }

  it('scrollUp clamps at the top; scrollDown clamps at the live tail', () => {
    const s = makeScreen();
    for (let i = 0; i < 30; i++) s.print(`line ${i}`);
    // areaH = 24-6 = 18; max offset = 30-18 = 12.
    s.scrollUp(50);
    expect(s.scrolled).toBe(12);
    s.scrollDown(5);
    expect(s.scrolled).toBe(7);
    s.scrollDown(50);
    expect(s.scrolled).toBe(0);
  });

  it('new output snaps the viewport back to live', () => {
    const s = makeScreen();
    for (let i = 0; i < 30; i++) s.print(`line ${i}`);
    s.scrollUp(6);
    expect(s.scrolled).toBe(6);
    s.print('fresh response');
    expect(s.scrolled).toBe(0);
  });
});

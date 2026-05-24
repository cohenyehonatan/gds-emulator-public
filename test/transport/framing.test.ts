import { describe, it, expect } from 'vitest';
import { LengthPrefixFraming, CrlfLineFraming } from '../../src/transport/framing.js';

describe('LengthPrefixFraming', () => {
  it('round-trips a single message', () => {
    const f = new LengthPrefixFraming();
    const { messages, remainder } = f.deframe(f.frame('01Y1'));
    expect(messages).toEqual(['01Y1']);
    expect(remainder.length).toBe(0);
  });

  it('splits concatenated frames and keeps a partial remainder', () => {
    const f = new LengthPrefixFraming();
    const buf = Buffer.concat([f.frame('SI*4321'), f.frame('115JUNJFKLAX')]);
    const partial = buf.slice(0, buf.length - 3);
    const { messages, remainder } = f.deframe(partial);
    expect(messages).toEqual(['SI*4321']);
    expect(remainder.length).toBeGreaterThan(0);
  });
});

describe('CrlfLineFraming', () => {
  it('splits CRLF- and LF-delimited lines and drops empties', () => {
    const f = new CrlfLineFraming();
    const { messages } = f.deframe(Buffer.from('SI*4321\r\n01Y1\n\n-SMITH/JOHN\r\n'));
    expect(messages).toEqual(['SI*4321', '01Y1', '-SMITH/JOHN']);
  });

  it('holds an unterminated line as remainder', () => {
    const f = new CrlfLineFraming();
    const { messages, remainder } = f.deframe(Buffer.from('ER\r\n6P'));
    expect(messages).toEqual(['ER']);
    expect(remainder.toString()).toBe('6P');
  });
});

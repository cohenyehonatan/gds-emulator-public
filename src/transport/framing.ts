/**
 * Message Framing for TCP Transport
 *
 * Two strategies:
 *
 *  - LengthPrefixFraming: [4-byte big-endian length][UTF-8 bytes].
 *    Clean and reliable; used by the programmatic agent terminal and scenarios.
 *
 *  - CrlfLineFraming: messages delimited by CR/LF. This is what a raw
 *    `telnet`/`nc` session produces, so the REPL and ad-hoc terminals can
 *    drive the host by typing one cryptic entry per line.
 *
 * Both are lifted from pectab-printer-emulator's transport layer, which is
 * protocol-agnostic.
 */

export interface FramingStrategy {
  /** Wrap a message string in a frame for transmission. */
  frame(message: string): Buffer;

  /** Extract complete messages from a buffer. Returns messages and leftover bytes. */
  deframe(buffer: Buffer): { messages: string[]; remainder: Buffer<ArrayBuffer> };
}

/** Length-prefixed framing: 4-byte big-endian length followed by UTF-8 message. */
export class LengthPrefixFraming implements FramingStrategy {
  private static readonly HEADER_SIZE = 4;

  frame(message: string): Buffer {
    const messageBytes = Buffer.from(message, 'utf-8');
    const frame = Buffer.alloc(LengthPrefixFraming.HEADER_SIZE + messageBytes.length);
    frame.writeUInt32BE(messageBytes.length, 0);
    messageBytes.copy(frame, LengthPrefixFraming.HEADER_SIZE);
    return frame;
  }

  deframe(buffer: Buffer): { messages: string[]; remainder: Buffer<ArrayBuffer> } {
    const messages: string[] = [];
    let offset = 0;

    while (offset + LengthPrefixFraming.HEADER_SIZE <= buffer.length) {
      const messageLength = buffer.readUInt32BE(offset);

      if (offset + LengthPrefixFraming.HEADER_SIZE + messageLength > buffer.length) {
        break; // incomplete — wait for more bytes
      }

      const messageStart = offset + LengthPrefixFraming.HEADER_SIZE;
      const messageEnd = messageStart + messageLength;
      messages.push(buffer.slice(messageStart, messageEnd).toString('utf-8'));
      offset = messageEnd;
    }

    return { messages, remainder: Buffer.from(buffer.slice(offset)) };
  }
}

/**
 * CR/LF line framing for raw terminal sessions. One cryptic entry per line.
 * Strips a trailing CR so `\r\n` and bare `\n` both work.
 */
export class CrlfLineFraming implements FramingStrategy {
  frame(message: string): Buffer {
    return Buffer.from(message + '\r\n', 'utf-8');
  }

  deframe(buffer: Buffer): { messages: string[]; remainder: Buffer<ArrayBuffer> } {
    const messages: string[] = [];
    let offset = 0;

    while (true) {
      const nlIdx = buffer.indexOf(0x0a, offset); // LF
      if (nlIdx === -1) break;

      let line = buffer.slice(offset, nlIdx);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.slice(0, -1); // drop trailing CR
      }
      const text = line.toString('utf-8');
      if (text.length > 0) messages.push(text);
      offset = nlIdx + 1;
    }

    return { messages, remainder: Buffer.from(buffer.slice(offset)) };
  }
}

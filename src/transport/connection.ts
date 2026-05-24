/**
 * Connection abstraction wrapping a TCP socket with message framing.
 *
 * Reused from pectab-printer-emulator — protocol-agnostic. Provides automatic
 * framing/deframing, event-based delivery, and request/response correlation.
 */

import { EventEmitter } from 'events';
import type { Socket } from 'net';
import type { FramingStrategy } from './framing.js';

export class Connection extends EventEmitter {
  private receiveBuffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly framing: FramingStrategy
  ) {
    super();

    socket.on('data', (data: Buffer) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);
      this.processBuffer();
    });

    socket.on('close', () => {
      this.closed = true;
      this.emit('disconnect');
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /** Send a raw message string through the connection. */
  send(message: string): void {
    if (this.closed) throw new Error('Connection is closed');
    this.socket.write(this.framing.frame(message));
  }

  /** Send a message and wait for a response within a timeout. */
  sendAndWait(message: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('message', handler);
        reject(new Error(`Response timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (response: string) => {
        clearTimeout(timeout);
        resolve(response);
      };

      this.once('message', handler);
      this.send(message);
    });
  }

  onMessage(handler: (message: string) => void): void {
    this.on('message', handler);
  }

  onDisconnect(handler: () => void): void {
    this.on('disconnect', handler);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.socket.end();
    }
  }

  isConnected(): boolean {
    return !this.closed;
  }

  getRemoteAddress(): string {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
  }

  private processBuffer(): void {
    const { messages, remainder } = this.framing.deframe(this.receiveBuffer);
    this.receiveBuffer = remainder;
    for (const message of messages) {
      this.emit('message', message);
    }
  }
}

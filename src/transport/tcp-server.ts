/**
 * TCP Server for the GDS host side.
 *
 * The host listens on a TCP port for incoming terminal connections. Each
 * connection is wrapped in a Connection with message framing, and (upstream,
 * in gds-host.ts) gets its own AAA work area — sessions are per-terminal.
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import { Connection } from './connection.js';
import type { FramingStrategy } from './framing.js';
import { LengthPrefixFraming } from './framing.js';

export class TcpServer extends EventEmitter {
  private server: net.Server;
  private connections: Map<string, Connection> = new Map();

  constructor(
    private readonly port: number,
    private readonly framing: FramingStrategy = new LengthPrefixFraming()
  ) {
    super();
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', reject);
        this.emit('listening', this.port);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of this.connections.values()) conn.close();
      this.connections.clear();
      this.server.close(() => resolve());
    });
  }

  getConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Return the actual listening port. When constructed with port 0,
   * the OS picks a free port and `server.address()` reflects it after
   * `listen` resolves. Useful for tests that need to connect to an
   * ephemeral port.
   */
  getPort(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.port;
  }

  private handleConnection(socket: net.Socket): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    const connection = new Connection(socket, this.framing);

    this.connections.set(id, connection);
    this.emit('connection', connection);

    connection.onDisconnect(() => {
      this.connections.delete(id);
      this.emit('disconnection', id);
    });
  }
}

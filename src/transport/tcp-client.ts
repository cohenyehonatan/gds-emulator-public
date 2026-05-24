/**
 * TCP Client for the agent-terminal side.
 *
 * The terminal connects to the GDS host's TCP server. Reused from
 * pectab-printer-emulator.
 */

import * as net from 'net';
import { Connection } from './connection.js';
import type { FramingStrategy } from './framing.js';
import { LengthPrefixFraming } from './framing.js';

export class TcpClient {
  private connection: Connection | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly framing: FramingStrategy = new LengthPrefixFraming()
  ) {}

  connect(timeoutMs = 5000): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        this.connection = new Connection(socket, this.framing);
        resolve(this.connection);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  getConnection(): Connection | null {
    return this.connection;
  }

  disconnect(): void {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }
}

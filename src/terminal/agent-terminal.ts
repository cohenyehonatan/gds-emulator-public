/**
 * Agent terminal — the reference client that drives the GDS host over TCP.
 *
 * The counterparty to GdsHost, analogous to the printer emulator's DcsHost.
 * `enter(cryptic)` sends one entry and resolves with the host's response.
 * This is the seam the BHS would later use to retrieve a PNR (v4 integration).
 */

import { TcpClient } from '../transport/tcp-client.js';
import type { Connection } from '../transport/connection.js';
import type { FramingStrategy } from '../transport/framing.js';
import { Logger, type LogLevel } from '../logging/logger.js';

export interface AgentTerminalOptions {
  host: string;
  port: number;
  logLevel?: LogLevel;
  framing?: FramingStrategy;
}

export class AgentTerminal {
  private client: TcpClient;
  private conn: Connection | null = null;
  private logger: Logger;

  constructor(private readonly options: AgentTerminalOptions) {
    this.logger = new Logger('TERM', options.logLevel ?? 'info');
    this.client = new TcpClient(options.host, options.port, options.framing);
  }

  async connect(): Promise<void> {
    this.conn = await this.client.connect();
    this.logger.info(`Connected to GDS host ${this.options.host}:${this.options.port}`);
  }

  isConnected(): boolean {
    return this.conn?.isConnected() ?? false;
  }

  /**
   * Re-establish the socket after a server restart (each connect()
   * builds a fresh net.Socket, so this is safe to call repeatedly).
   * The server gives reconnections a FRESH work area — the operator
   * must sign on again; committed PNRs/queues persist server-side.
   */
  async reconnect(): Promise<void> {
    this.conn = await this.client.connect();
    this.logger.info('Reconnected to GDS host');
  }

  /**
   * Send a cryptic entry; resolve with the host's green-screen response.
   *
   * 30s default: a LIVE entry (e.g. a Stays hotel search) routinely takes
   * 5-6s, and the old 5s timeout fired mid-call — the client gave up,
   * reconnected, and the slow response then landed on a closed socket
   * (crashing the host before that was guarded).
   */
  async enter(cryptic: string, timeoutMs = 30000): Promise<string> {
    if (!this.conn) throw new Error('Not connected');
    this.logger.protocol('send', '»', cryptic);
    const response = await this.conn.sendAndWait(cryptic, timeoutMs);
    this.logger.protocol('receive', '«', response.split('\n')[0]);
    return response;
  }

  disconnect(): void {
    this.client.disconnect();
    this.conn = null;
  }
}

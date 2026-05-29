/**
 * GDS host — the top-level emulated system.
 *
 * Owns the TCP server and a per-connection AAA work area. For each incoming
 * cryptic entry it parses → dispatches → returns a green-screen response.
 * Mirrors the printer emulator's Atbpr: construct, start(), stop().
 *
 * `process()` runs the full pipeline against a given work area without any
 * transport, so the REPL and unit tests can drive the host in-process.
 */

import { TcpServer } from '../transport/tcp-server.js';
import type { Connection } from '../transport/connection.js';
import type { FramingStrategy } from '../transport/framing.js';
import { WorkArea } from './work-area.js';
import { type HandlerContext } from './handlers/index.js';
import type { Dialect } from '../dialects/dialect.js';
import { SabreDialect } from '../dialects/sabre/index.js';
import { type Backend, EmulatedBackend } from '../backends/backend.js';
import { Logger, type LogLevel } from '../logging/logger.js';

export interface GdsHostOptions {
  port: number;
  logLevel?: LogLevel;
  framing?: FramingStrategy;
  /** Pseudo City Code used in signature lines (default "A0UC"). */
  pcc?: string;
  /** Cryptic dialect this host serves (default: Sabre). */
  dialect?: Dialect;
  /** Where answers come from (default: EmulatedBackend). v5 Backend axis. */
  backend?: Backend;
}

export class GdsHost {
  private server: TcpServer;
  private workAreas = new WeakMap<Connection, WorkArea>();
  private logger: Logger;
  readonly context: HandlerContext;
  readonly dialect: Dialect;
  readonly backend: Backend;

  constructor(private readonly options: GdsHostOptions) {
    this.logger = new Logger('GDS', options.logLevel ?? 'info');
    this.dialect = options.dialect ?? new SabreDialect();
    this.backend = options.backend ?? new EmulatedBackend();
    this.context = {
      backend: this.backend,
      pcc: options.pcc ?? 'A0UC',
    };
    this.server = new TcpServer(options.port, options.framing);

    this.server.on('connection', (conn: Connection) => this.onConnection(conn));
  }

  async start(): Promise<void> {
    await this.server.start();
    this.logger.info(`GDS host listening on port ${this.options.port}`);
  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.logger.info('GDS host stopped');
  }

  /**
   * Run an entry against a work area. Delegates keyboard normalization,
   * chain splitting (Sabre's `§` end-item, Amadeus's `;`, …), parse +
   * dispatch, and error classification to the dialect — stopping a chain
   * at the first dialect-recognized error, like a real host transmission.
   */
  process(raw: string, wa: WorkArea): string {
    const entries = this.dialect.splitChain(this.dialect.normalizeKeyboard(raw));
    if (entries.length <= 1) return this.processOne(entries[0] ?? raw, wa);

    // A chain shows only the final screen state (or the error that halts it),
    // mirroring a real end-item transmission.
    let last = '';
    for (const e of entries) {
      last = this.processOne(e, wa);
      if (this.dialect.isErrorResponse(last)) break;
    }
    return last;
  }

  /** Parse → dispatch a single (already keyboard-normalized) entry. */
  private processOne(raw: string, wa: WorkArea): string {
    return this.dialect.processEntry(raw, wa, this.context);
  }

  /** A fresh work area, e.g. for the in-process REPL. */
  newWorkArea(): WorkArea {
    return new WorkArea();
  }

  private onConnection(conn: Connection): void {
    const wa = new WorkArea();
    this.workAreas.set(conn, wa);
    this.logger.info(`Terminal connected: ${conn.getRemoteAddress()}`);

    conn.onMessage((raw: string) => {
      this.logger.protocol('send', 'ENTRY', raw);
      const response = this.process(raw, wa);
      this.logger.protocol('receive', 'RESP', response.split('\n')[0]);
      conn.send(response);
    });

    conn.onDisconnect(() => this.logger.info('Terminal disconnected'));
  }
}

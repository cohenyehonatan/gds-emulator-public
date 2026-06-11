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
    this.logger.info(`GDS host listening on port ${this.server.getPort()}`);
  }

  /** Actual listening port — useful when constructed with port 0
   *  (the OS picks a free port; tests need it back). */
  getPort(): number {
    return this.server.getPort();
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
   *
   * Returns `Promise<string>` to support backends that need to call out
   * to a vendor REST API (LiveTravelportBackend's TripServices flow).
   * EmulatedBackend handlers stay synchronous internally; the promise is
   * just a uniform wrapper. Tests must `await host.process(...)`.
   */
  async process(raw: string, wa: WorkArea): Promise<string> {
    const entries = this.dialect.splitChain(this.dialect.normalizeKeyboard(raw));
    if (entries.length <= 1) return this.processOne(entries[0] ?? raw, wa);

    // A chain shows only the final screen state (or the error that halts it),
    // mirroring a real end-item transmission.
    let last = '';
    for (const e of entries) {
      last = await this.processOne(e, wa);
      if (this.dialect.isErrorResponse(last)) break;
    }
    return last;
  }

  /** Parse → dispatch a single (already keyboard-normalized) entry. */
  private async processOne(raw: string, wa: WorkArea): Promise<string> {
    try {
      return await this.dialect.processEntry(raw, wa, this.context);
    } catch (err) {
      // Last-resort net: a dialect bug must NEVER kill the host —
      // especially the TCP server, where an uncaught throw in the
      // connection handler takes the whole process down. Log it,
      // answer with a generic system error, keep serving.
      this.logger.error(
        `Unhandled dispatch error for entry "${raw}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      return 'SYSTEM ERROR - ENTRY NOT PROCESSED';
    }
  }

  /** A fresh work area, e.g. for the in-process REPL. */
  newWorkArea(): WorkArea {
    return new WorkArea();
  }

  private onConnection(conn: Connection): void {
    const wa = new WorkArea();
    this.workAreas.set(conn, wa);
    this.logger.info(`Terminal connected: ${conn.getRemoteAddress()}`);

    // CRT-over-TCP (v6): a client that sends the `.CRT` hello opts
    // into the state-trailer protocol — every subsequent response
    // carries `\x1F<state>\x1F<agent>` so the remote terminal can
    // render the CRT status bar without a second round-trip. Plain
    // line-mode clients never send the hello and see no change.
    let crtMode = false;

    conn.onMessage(async (raw: string) => {
      if (raw === '.CRT') {
        crtMode = true;
        // Hello also identifies the host: dialect screen name +
        // backend kind, so the remote terminal can title its CRT
        // and tell the operator whether entries hit a live vendor.
        const backendKind = this.backend.constructor.name === 'LiveTravelportBackend' ? 'LIVE' : 'EMULATED';
        conn.send(`CRT OK\x1F${wa.state()}\x1F${wa.agent ?? ''}\x1F${this.dialect.screenName}\x1F${backendKind}`);
        return;
      }
      this.logger.protocol('send', 'ENTRY', raw);
      const response = await this.process(raw, wa);
      this.logger.protocol('receive', 'RESP', response.split('\n')[0]);
      conn.send(crtMode ? `${response}\x1F${wa.state()}\x1F${wa.agent ?? ''}` : response);
    });

    conn.onDisconnect(() => this.logger.info('Terminal disconnected'));
  }
}

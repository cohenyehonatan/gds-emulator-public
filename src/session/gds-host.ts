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
import { dispatch, type HandlerContext } from './handlers/index.js';
import { parseEntry } from '../protocol/parser.js';
import { ParseError } from '../protocol/errors.js';
import { Response } from '../protocol/constants.js';
import { normalizeKeyboard, splitEndItems } from '../protocol/keyboard.js';
import { Inventory } from '../store/inventory.js';
import { PnrStore } from '../store/pnr-store.js';
import { Logger, type LogLevel } from '../logging/logger.js';

export interface GdsHostOptions {
  port: number;
  logLevel?: LogLevel;
  framing?: FramingStrategy;
  /** Pseudo City Code used in signature lines (default "A0UC"). */
  pcc?: string;
}

export class GdsHost {
  private server: TcpServer;
  private workAreas = new WeakMap<Connection, WorkArea>();
  private logger: Logger;
  readonly context: HandlerContext;

  constructor(private readonly options: GdsHostOptions) {
    this.logger = new Logger('GDS', options.logLevel ?? 'info');
    this.context = {
      inventory: new Inventory(),
      pnrStore: new PnrStore(),
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
   * Run an entry against a work area. Applies keyboard normalization, then
   * splits on the End-Item separator (§) and runs each component entry in
   * sequence — stopping at the first error, like a real Sabre end-item chain.
   */
  process(raw: string, wa: WorkArea): string {
    const entries = splitEndItems(normalizeKeyboard(raw));
    if (entries.length <= 1) return this.processOne(entries[0] ?? raw, wa);

    // A chain shows only the final screen state (or the error that halts it),
    // mirroring a real end-item transmission.
    let last = '';
    for (const e of entries) {
      last = this.processOne(e, wa);
      if (GdsHost.ERROR_RESPONSES.has(last)) break; // chain halts on first error
    }
    return last;
  }

  /** Parse → dispatch a single (already keyboard-normalized) entry. */
  private processOne(raw: string, wa: WorkArea): string {
    let entry;
    try {
      entry = parseEntry(raw);
    } catch (err) {
      if (err instanceof ParseError) return Response.FORMAT;
      throw err;
    }
    return dispatch(entry, wa, this.context);
  }

  /** A fresh work area, e.g. for the in-process REPL. */
  newWorkArea(): WorkArea {
    return new WorkArea();
  }

  private static readonly ERROR_RESPONSES = new Set<string>([
    Response.FORMAT,
    Response.NEED_PHONE,
    Response.NEED_TICKETING,
    Response.NEED_RECEIVED_FROM,
    Response.NEED_ITINERARY,
    Response.NEED_NAME,
    Response.NAMES_NOT_EQUAL,
    Response.NO_PNR,
    Response.NO_ITINERARY,
    Response.SEGMENT_NOT_FOUND,
    Response.INVALID_STATUS,
    Response.RECORD_LOCATOR_NOT_FOUND,
    'NO AVAILABILITY DISPLAYED',
    'CLASS NOT AVAILABLE',
    'NOT A CONNECTION',
    'OUT OF SEQUENCE',
    'NO FLIGHTS',
  ]);

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

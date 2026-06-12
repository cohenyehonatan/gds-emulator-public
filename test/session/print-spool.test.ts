/**
 * PrintSpool — GPM.net emulation (references/print/, verbatim
 * 2026-06-12). Response strings asserted verbatim where the appendix
 * pins them; reconstructed strings asserted for stability.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrintSpool, DEFAULT_PRINTER_GTID } from '../../src/session/print-spool.js';

describe('PrintSpool', () => {
  let spool: PrintSpool;
  let dir: string;

  beforeEach(() => {
    spool = new PrintSpool();
    dir = mkdtempSync(join(tmpdir(), 'gds-print-'));
    spool.outputDir = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('print() writes one file per job into the spool dir', () => {
    spool.print('P-*R', 'GZWF93  A0UC/0U1C\n1.1COHEN/YEHONATAN MR');
    spool.print('P-*I', ' 1. DL 1332 E 01JUL MIAATL');
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(`${DEFAULT_PRINTER_GTID}-0001.txt`);
    expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('COHEN/YEHONATAN');
  });

  it('HQC counts the ≤1-deep ticket-image buffer — verbatim SET ADDRESS shape', () => {
    expect(spool.queueCount('C5F062')).toBe('SET ADDRESS C5F062 00');
    spool.holdTicketImage('GZWF93', 'TKT IMAGE', 'C5F062');
    // One BF = count 01, regardless of documents (appendix: 0 or 1).
    expect(spool.queueCount('C5F062')).toBe('SET ADDRESS C5F062 01');
  });

  it('HQS restarts: flushes the held image to the spool — verbatim response', () => {
    spool.holdTicketImage('GZWF93', 'TKT IMAGE BODY', 'C5F062');
    expect(spool.restart('C5F062')).toBe('RESTART IN PROGRESS - PLEASE WAIT');
    expect(spool.queueCount('C5F062')).toBe('SET ADDRESS C5F062 00');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('TKT IMAGE BODY');
  });

  it('HQS requires U status (appendix note); HQX deletes without printing', () => {
    spool.holdTicketImage('GZWF93', 'X', 'C5F062');
    spool.setStatus('C5F062', 'D');
    expect(spool.restart('C5F062')).toBe('PRINTER C5F062 DOWN - USE HMOM');
    spool.setStatus('C5F062', 'U');
    expect(spool.queueDelete('C5F062')).toBe('QUEUE C5F062 DELETED');
    expect(spool.queueCount('C5F062')).toBe('SET ADDRESS C5F062 00');
    expect(readdirSync(dir)).toHaveLength(0); // deleted, not flushed
  });

  it('HQD shows queue contents', () => {
    expect(spool.queueDisplay('C5F062')).toBe('QUEUE C5F062 EMPTY');
    spool.holdTicketImage('GZWF93', 'X', 'C5F062');
    expect(spool.queueDisplay('C5F062')).toContain('TICKET IMAGE  GZWF93');
  });
});

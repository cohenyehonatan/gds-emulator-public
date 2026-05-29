import { describe, it, expect } from 'vitest';
import { EmulatedBackend } from '../../src/backends/backend.js';
import { GdsHost } from '../../src/session/gds-host.js';

describe('EmulatedBackend — Backend interface', async () => {
  it('exposes id and displayName', async () => {
    const b = new EmulatedBackend();
    expect(b.id).toBe('emulated');
    expect(b.displayName).toContain('Emulated');
  });

  it('nextTicketSerial returns monotonic increasing values', async () => {
    const b = new EmulatedBackend({ initialTicketSerial: 100 });
    expect(b.nextTicketSerial()).toBe(100);
    expect(b.nextTicketSerial()).toBe(101);
    expect(b.nextTicketSerial()).toBe(102);
  });

  it('two EmulatedBackend instances do not share state', async () => {
    const a = new EmulatedBackend();
    const c = new EmulatedBackend();
    a.queues.set('Q1', ['ABC123']);
    expect(c.queues.has('Q1')).toBe(false);
    expect(a.pnrs).not.toBe(c.pnrs);
  });

  it('GdsHost wires the backend into the HandlerContext', async () => {
    const host = new GdsHost({ port: 0, logLevel: 'error' });
    expect(host.backend.id).toBe('emulated');
    expect(host.context.backend).toBe(host.backend);
    expect(host.context.backend.inventory).toBe(host.backend.inventory);
    expect(host.context.backend.pnrs).toBe(host.backend.pnrs);
    expect(host.context.backend.queues).toBe(host.backend.queues);
  });

  it('GdsHost accepts an injected backend (initialTicketSerial flows through)', async () => {
    const backend = new EmulatedBackend({ initialTicketSerial: 7 });
    const host = new GdsHost({ port: 0, logLevel: 'error', backend });
    expect(host.backend).toBe(backend);
    expect(host.backend.nextTicketSerial()).toBe(7);
  });
});

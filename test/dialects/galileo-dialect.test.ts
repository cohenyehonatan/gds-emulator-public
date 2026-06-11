
describe('connection sell — N<seats><class><line>* (Mini Format Guide p.10)', () => {
  it('N1Y1* on a connection display sells every leg of the group', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A27JUNDENFRA', wa);
    const resp = await host.process('N1Y1*', wa);
    expect(resp).toContain('FI 670');
    expect(resp).toContain('FI 520');
    expect(wa.pnr.segments).toHaveLength(2);
    expect(wa.pnr.segments.map((s) => `${s.origin}${s.destination}`)).toEqual(['DENKEF', 'KEFFRA']);
    expect(wa.pnr.segments.every((s) => s.bookingClass === 'Y')).toBe(true);
  });

  it('N1Y1* on a nonstop rejects with NOT A CONNECTION', async () => {
    const host = makeHost();
    const wa = host.newWorkArea();
    await host.process('SON/ZGS', wa);
    await host.process('A15JULJFKLAX', wa);
    expect(await host.process('N1Y1*', wa)).toBe('NOT A CONNECTION');
    expect(wa.pnr.segments).toHaveLength(0);
  });

  it('the Worldspan manual form ∅1Y1* rides the same expansion (01Y1*)', async () => {
    const { WorldspanDialect } = await import('../../src/dialects/worldspan/index.js');
    const host = new GdsHost({ port: 0, logLevel: 'error', dialect: new WorldspanDialect(), pcc: '1P' });
    const wa = host.newWorkArea();
    await host.process('BSI$5467AB/GS', wa);
    await host.process('A27JUNDENFRA', wa);
    const resp = await host.process('01Y1*', wa);
    expect(resp.split('\n')).toHaveLength(2);
    expect(wa.pnr.segments).toHaveLength(2);
  });
});

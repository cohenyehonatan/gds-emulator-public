/**
 * Write-through persistent queue map — the durable sibling of
 * JsonFilePnrStore. Real GDS queues are long-lived host-side work
 * lists; a PNR that survives a restart should still be sitting on
 * queue 35 afterwards.
 *
 * Every handler mutates queues via get-then-set (re-setting the
 * list after array mutation), so overriding set/delete/clear is a
 * complete write barrier. Same sync-write durability convention as
 * JsonFilePnrStore.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class JsonFileQueues extends Map<string, string[]> {
  constructor(private readonly path: string) {
    super();
    try {
      const plain = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
      for (const [k, v] of Object.entries(plain)) super.set(k, v);
    } catch {
      // Missing / unreadable file = empty queues (first run).
    }
  }

  get filePath(): string {
    return this.path;
  }

  override set(key: string, value: string[]): this {
    super.set(key, value);
    this.flush();
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.flush();
    return had;
  }

  override clear(): void {
    super.clear();
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this), null, 2));
  }
}

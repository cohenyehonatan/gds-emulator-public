/**
 * Cursor-based string parser for cryptic GDS entries.
 *
 * Sabre entries are sigil-prefixed free-form strings rather than fixed-width
 * AEA fields, so this is used mostly for readFixed (the sigil) + readUntil /
 * readRemaining on the argument tail. Lifted from pectab-printer-emulator.
 */

export class FieldParser {
  private position = 0;

  constructor(private readonly data: string) {}

  /** Read exactly `length` characters and advance the cursor. */
  readFixed(length: number): string {
    if (this.position + length > this.data.length) {
      throw new FieldParseError(
        `Cannot read ${length} chars at position ${this.position}, ` +
          `only ${this.data.length - this.position} chars remaining`,
        this.position,
        this.data
      );
    }
    const value = this.data.slice(this.position, this.position + length);
    this.position += length;
    return value;
  }

  /** Read exactly `length` characters and parse as an integer. */
  readInt(length: number): number {
    const raw = this.readFixed(length);
    const value = parseInt(raw, 10);
    if (isNaN(value)) {
      throw new FieldParseError(
        `Expected integer at position ${this.position - length}, got "${raw}"`,
        this.position - length,
        this.data
      );
    }
    return value;
  }

  /** Read all remaining characters. */
  readRemaining(): string {
    const value = this.data.slice(this.position);
    this.position = this.data.length;
    return value;
  }

  /** Read until a separator. Returns content before the separator (consumes it). */
  readUntil(separator: string): string {
    const idx = this.data.indexOf(separator, this.position);
    if (idx === -1) return this.readRemaining();
    const value = this.data.slice(this.position, idx);
    this.position = idx + separator.length;
    return value;
  }

  peek(length: number): string {
    return this.data.slice(this.position, this.position + length);
  }

  skip(length: number): void {
    this.position += length;
  }

  hasMore(): boolean {
    return this.position < this.data.length;
  }

  getPosition(): number {
    return this.position;
  }

  getRemainingLength(): number {
    return this.data.length - this.position;
  }
}

export class FieldParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly data: string
  ) {
    super(message);
    this.name = 'FieldParseError';
  }
}

/** Right-pad to a fixed width with spaces (truncates if longer). */
export function padRight(value: string, width: number): string {
  return value.padEnd(width, ' ').slice(0, width);
}

/** Left-pad a number with zeros to a fixed width. */
export function padZero(value: number, width: number): string {
  return String(value).padStart(width, '0').slice(-width);
}

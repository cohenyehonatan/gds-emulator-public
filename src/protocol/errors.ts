/** Protocol-layer errors. Kept separate from parser.ts to avoid import cycles. */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

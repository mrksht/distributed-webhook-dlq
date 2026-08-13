// worker.ts checks `instanceof NonRetryableError` to skip retry and go straight to DEAD_LETTER,
// without depending on any specific policy module's concrete error type.
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
    Object.setPrototypeOf(this, NonRetryableError.prototype);
  }
}

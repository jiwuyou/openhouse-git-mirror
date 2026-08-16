export class MirrorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MirrorError";
  }
}

export class MirrorTooLargeError extends MirrorError {
  constructor(readonly sizeBytes: number, readonly maxSizeBytes: number) {
    super("mirror_oversized", `Mirror size ${sizeBytes} exceeds limit ${maxSizeBytes}`);
    this.name = "MirrorTooLargeError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

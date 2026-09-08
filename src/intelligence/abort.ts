/**
 * User-initiated stop of consolidate. Not a degrade and not a timeout.
 */

export class ConsolidateAbortError extends Error {
  readonly code = "CONSOLIDATE_ABORTED";
  constructor() {
    super("consolidate aborted");
    this.name = "ConsolidateAbortError";
  }
}

export function isConsolidateAbort(err: unknown): boolean {
  return err instanceof ConsolidateAbortError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConsolidateAbortError();
}

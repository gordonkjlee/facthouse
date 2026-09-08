/**
 * TTY remaining-time from recent model-chunk samples. Skips do not sample.
 */

const WINDOW = 8;
const MIN_SAMPLES = 3;

export class ChunkEta {
  private readonly durations: number[] = [];
  private readonly lines: number[] = [];

  noteModelChunk(durationMs: number, lineCount: number): void {
    if (!(durationMs > 0) || !(lineCount > 0)) return;
    this.durations.push(durationMs);
    this.lines.push(lineCount);
    if (this.durations.length > WINDOW) {
      this.durations.shift();
      this.lines.shift();
    }
  }

  reset(): void {
    this.durations.length = 0;
    this.lines.length = 0;
  }

  /** Remaining milliseconds, or null until MIN_SAMPLES model chunks. */
  etaMs(linesLeft: number): number | null {
    if (this.durations.length < MIN_SAMPLES || linesLeft <= 0) return null;
    const meanMs =
      this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
    const meanLines =
      this.lines.reduce((a, b) => a + b, 0) / this.lines.length;
    if (!(meanLines > 0)) return null;
    return Math.round((linesLeft / meanLines) * meanMs);
  }
}

export function formatEta(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.round(totalSec / 60);
  return `${min}m`;
}

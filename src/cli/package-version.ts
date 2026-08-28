/**
 * Package version of the answering binary. One helper for the MCP snippet,
 * `stats --json`, and `inspect --json`.
 */
import { readFileSync } from "node:fs";

export function packageVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

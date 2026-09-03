/**
 * Live HTTP extract against a local OpenAI-compat host (Ollama by default).
 *
 * Opt-in: FACTHOUSE_REQUIRE_HTTP_INTEL_EVAL=1 (`npm run test:http-intelligence`).
 * Fail-closed: missing host or missing model is a failure, not a skip.
 */

import { describe, it, expect } from "vitest";
import { createHttpProvider } from "../../src/intelligence/http.js";
import { HTTP_DEFAULT_BASE_URL } from "../../src/types/config.js";
import { envValue } from "../../src/identity.js";
import type { SessionEvent } from "../../src/types/data.js";

const required = process.env.FACTHOUSE_REQUIRE_HTTP_INTEL_EVAL === "1";
const model = envValue("HTTP_MODEL") ?? "";
const baseUrl = (envValue("HTTP_BASE_URL") ?? HTTP_DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);

async function probe(): Promise<string | null> {
  if (!model.trim()) {
    return "FACTHOUSE_HTTP_MODEL (or FACTHOUSE_HTTP_MODEL) is not set";
  }
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return `${baseUrl}/models HTTP ${res.status}`;
  } catch (err) {
    return `${baseUrl} did not answer (${err instanceof Error ? err.message : err})`;
  }
  return null;
}

const unavailable = required ? await probe() : "not opted in";

describe.skipIf(!required)("live HTTP extract", () => {
  it("refuses to skip: the host and model must be there", () => {
    expect(unavailable).toBeNull();
  });

  it("extracts the kaleidoscope sentence without degrading", async () => {
    expect(unavailable).toBeNull();
    const provider = createHttpProvider({
      baseUrl,
      model,
      timeoutMs: 120_000,
    });
    const event: SessionEvent = {
      id: "e1",
      mcp_session_id: "s",
      client_session_id: "s",
      sequence: 1,
      event_type: "message",
      role: "user",
      content_type: "text",
      content: "Alex keeps a brass kaleidoscope on the desk at Acme.",
      content_ref: null,
      speaker: null,
      metadata: null,
      created_at: "2026-08-31T12:00:00.000Z",
      occurred_at: null,
    };
    const out = await provider.extractFactsFromEvents([event], []);
    expect(out.degraded).toBe(false);
    expect(out.facts.some((f) => /kaleidoscope/i.test(f.content))).toBe(true);
    expect(out.facts.every((f) => f.source_quality === "http")).toBe(true);
  }, 180_000);
});

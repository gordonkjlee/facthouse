/**
 * Tools-only bootstrap: one briefing, two delivery paths.
 * Synthetic only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "../../src/db/connection.js";
import {
  SESSION_BOOTSTRAP_INSTRUCTIONS,
  sessionContextDescription,
  buildBriefing,
} from "../../src/tools/resources.js";

const dbMod = await import("../../src/db/index.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) =>
  readFileSync(path.join(here, "..", "..", "src", rel), "utf8");

let db: Db;

beforeEach(async () => {
  db = dbMod.openDatabase(":memory:");
  await dbMod.applySchema(db);
});

afterEach(async () => {
  await dbMod.closeDatabase(db);
});

describe("SESSION_BOOTSTRAP_INSTRUCTIONS", () => {
  it("is the session-start instruction, not a second profile", () => {
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toMatch(/get_session_context/);
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toMatch(/memory:\/\/briefing/);
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toMatch(/before answering/i);
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).not.toMatch(/get_profile|get_briefing/);
  });

  it("is the lead of get_session_context and the MCP initialize text", () => {
    expect(sessionContextDescription()).toContain(SESSION_BOOTSTRAP_INSTRUCTIONS);
    expect(src("server.ts")).toMatch(/SESSION_BOOTSTRAP_INSTRUCTIONS/);
    expect(src("tools/fact-manager.ts")).toMatch(/sessionContextDescription/);
    expect(src("server.ts")).not.toMatch(/At the start of every conversation, before answering/);
    expect(src("tools/fact-manager.ts")).not.toMatch(
      /At the start of every conversation, before answering/,
    );
  });
});

describe("get_session_context briefing", () => {
  it("is buildBriefing of this store, not a second schema", async () => {
    await dbMod.insertFact(db, {
      content: "Alex prefers dark roast coffee",
      domain: "preferences",
      source_type: "conversation",
    });
    expect(await buildBriefing(db)).toContain("Alex prefers dark roast coffee");
    expect(await buildBriefing(db)).toMatch(/^# Facthouse Briefing/);
  });
});

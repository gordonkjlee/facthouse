/**
 * MCP tools for gated inferences. Caller registers these only when
 * config.inferences.enabled is true — default off so assistants never
 * see a minting path on a store that did not opt in.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import {
  insertInference,
  listInferences,
  validateInference,
} from "../db/inferences.js";
import type { InferenceStatus } from "../types/data.js";
import {
  CAPTURE_INFERENCE_DESCRIPTION,
  LIST_INFERENCES_DESCRIPTION,
  VALIDATE_INFERENCE_DESCRIPTION,
} from "./inference-descriptions.js";

function jsonResult(body: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerInferenceTools(
  server: McpServer,
  db: Db,
  opts?: { onConfirmed?: () => void },
): void {
  server.tool(
    "capture_inference",
    CAPTURE_INFERENCE_DESCRIPTION,
    {
      hypothesis: z
        .string()
        .describe("The inferred sentence. Not something the user stated."),
      evidence: z
        .array(z.string())
        .min(1)
        .describe(
          "Graduated fact ids that support the hypothesis. At least one. " +
            "A guess with no evidence is not this tool.",
        ),
      entity_ids: z
        .array(z.string())
        .length(2)
        .optional()
        .describe(
          "When the hypothesis is that two existing entities are one thing, " +
            "their ids. Confirming records a same-as link so lookup treats " +
            "them as one; rejecting does not. Similar facts are evidence, " +
            "not identity — still wait for validate_inference.",
        ),
    },
    async (args) => {
      try {
        const inference = await insertInference(db, {
          hypothesis: args.hypothesis,
          evidence_fact_ids: args.evidence,
          entity_ids: args.entity_ids,
        });
        return jsonResult({
          inference_id: inference.id,
          status: inference.status,
          evidence_fact_ids: inference.evidence_fact_ids,
          entity_ids: inference.entity_ids,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message }, true);
      }
    },
  );

  server.tool(
    "validate_inference",
    VALIDATE_INFERENCE_DESCRIPTION,
    {
      inference_id: z.string().describe("The pending inference to judge"),
      confirmed: z
        .boolean()
        .describe(
          "true graduates it as labelled knowledge; false rejects it",
        ),
      reason: z
        .string()
        .optional()
        .describe("Why it was confirmed or rejected"),
    },
    async (args) => {
      try {
        const result = await validateInference(db, {
          id: args.inference_id,
          confirmed: args.confirmed,
          reason: args.reason,
        });
        if (args.confirmed && opts?.onConfirmed) {
          try {
            opts.onConfirmed();
          } catch {
            // Notification must not fail a committed confirm.
          }
        }
        return jsonResult({
          inference_id: result.inference.id,
          status: result.inference.status,
          fact_id: result.fact?.id ?? null,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message }, true);
      }
    },
  );

  server.tool(
    "list_inferences",
    LIST_INFERENCES_DESCRIPTION,
    {
      status: z
        .enum(["pending", "confirmed", "rejected"])
        .optional()
        .describe("Which gate state to list. Omit for pending."),
    },
    async (args) => {
      const status = (args.status ?? "pending") as InferenceStatus;
      const inferences = await listInferences(db, status);
      return jsonResult({ status, inferences });
    },
  );
}

/**
 * `openmemory inspect` — sample D / I / K and write a local HTML app
 * (graph + spend). Does not open a browser.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import { formatStats } from "./query.js";
import { renderInspectHtml } from "./inspect-html.js";
import { DEFAULT_GRAPH_CAP, DEFAULT_TABLE_LIMIT } from "./inspect-model.js";
import {
  loadGraphPayload,
  loadHealth,
  loadLayerRows,
  type InspectLayerRows,
} from "./inspect-payload.js";
import { loadSpendDashboard } from "./spend-dashboard.js";

export const INSPECT_LAYERS = [
  "health",
  "d",
  "i",
  "k",
  "entities",
  "graph",
  "all",
] as const;

export type InspectLayer = (typeof INSPECT_LAYERS)[number];

export interface InspectOpts {
  dataDir: string;
  layer?: string;
  limit?: number;
  json?: boolean;
  graph?: boolean;
  entity?: string;
  output?: string;
  all?: boolean;
  packageVersion?: string | null;
}

export interface InspectResult {
  stdout?: string;
  path?: string;
}

function parseLayer(raw: string | undefined): InspectLayer | undefined {
  if (!raw) return undefined;
  if ((INSPECT_LAYERS as readonly string[]).includes(raw)) {
    return raw as InspectLayer;
  }
  throw new Error(
    `Unknown inspect layer '${raw}'. Use health, d, i, k, entities, graph, or all.`,
  );
}

function formatLayers(rows: InspectLayerRows, which: InspectLayer): string {
  const chunks: string[] = [];
  const want = which === "all" ? (["d", "i", "k", "entities", "graph"] as const) : [which];
  for (const layer of want) {
    if (layer === "health") continue;
    if (layer === "d") {
      chunks.push("", "Data (newest events)", "");
      if (!rows.d.length) chunks.push("  (empty)");
      for (const r of rows.d) {
        chunks.push(
          `  #${r.sequence}  ${r.role}/${r.event_type}  ${r.conversation || "—"}`,
        );
        chunks.push(`    ${r.content}`);
      }
    } else if (layer === "i") {
      chunks.push("", "Information (pending)", "");
      if (!rows.pending_i) {
        chunks.push("  Nothing is waiting to graduate.");
      } else {
        for (const r of rows.i) {
          chunks.push(
            `  ${r.domain_hint || "—"}  ${r.created_at}`,
          );
          chunks.push(`    ${r.content}`);
        }
      }
    } else if (layer === "k") {
      chunks.push("", "Knowledge (currently true)", "");
      if (!rows.k.length) chunks.push("  (empty)");
      for (const r of rows.k) {
        chunks.push(`  ${r.domain}${r.entities ? `  ·  ${r.entities}` : ""}`);
        chunks.push(`    ${r.content}`);
      }
    } else if (layer === "entities") {
      chunks.push("", `Entities (${rows.entity_total})`, "");
      if (!rows.entities.length) chunks.push("  (empty)");
      for (const r of rows.entities) {
        chunks.push(`  ${r.type}  ${r.name}  ${r.id.slice(0, 8)}`);
      }
    } else if (layer === "graph") {
      chunks.push("", "Graph (strongest edges)", "");
      if (!rows.graph.length) chunks.push("  (empty)");
      for (const r of rows.graph) {
        chunks.push(
          `  ${r.from} → ${r.to}  ${r.relationship}  ${r.strength.toFixed(2)}`,
        );
      }
      if (rows.relationship_histogram.length) {
        chunks.push("", "  Typed links on facts");
        for (const h of rows.relationship_histogram) {
          chunks.push(`    ${h.relationship}  ${h.count}`);
        }
      }
    }
  }
  return chunks.join("\n").trimEnd() + (chunks.length ? "\n" : "");
}

export async function runInspect(db: Db, opts: InspectOpts): Promise<InspectResult> {
  const layer = parseLayer(opts.layer);
  const wantJson = Boolean(opts.json);
  const wantHtml = Boolean(opts.graph) || (!layer && !wantJson);
  const tableLimit = opts.limit ?? DEFAULT_TABLE_LIMIT;
  const graphCap = opts.limit ?? DEFAULT_GRAPH_CAP;

  const health = await loadHealth(db);
  const version = opts.packageVersion ?? null;

  if (layer === "health" && !wantHtml && !wantJson) {
    return { stdout: formatStats(health) };
  }

  const rows =
    layer && layer !== "health"
      ? await loadLayerRows(db, tableLimit)
      : wantJson && !wantHtml
        ? await loadLayerRows(db, tableLimit)
        : null;

  if (wantJson && !wantHtml) {
    const payload: Record<string, unknown> = {
      package_version: version,
      health,
    };
    if (!layer || layer === "all" || layer === "health") {
      /* health already included */
    }
    if (rows && layer && layer !== "health") {
      if (layer === "all") Object.assign(payload, { samples: rows });
      else if (layer === "d") payload.d = rows.d;
      else if (layer === "i") payload.i = { pending: rows.pending_i, rows: rows.i };
      else if (layer === "k") payload.k = rows.k;
      else if (layer === "entities") {
        payload.entities = { total: rows.entity_total, rows: rows.entities };
      } else if (layer === "graph") {
        payload.graph = rows.graph;
        payload.relationship_histogram = rows.relationship_histogram;
      }
    } else if (!layer || layer === "all") {
      payload.samples = rows ?? (await loadLayerRows(db, tableLimit));
    }
    return { stdout: JSON.stringify(payload, null, 2) };
  }

  const out: InspectResult = {};
  if (layer && layer !== "health") {
    const body = formatLayers(rows ?? (await loadLayerRows(db, tableLimit)), layer);
    out.stdout = layer === "all" ? `${formatStats(health)}${body}` : body;
  } else if (layer === "health") {
    out.stdout = formatStats(health);
  }

  if (wantHtml) {
    const graph = await loadGraphPayload(db, {
      cap: opts.all ? Number.POSITIVE_INFINITY : graphCap,
      entity: opts.entity,
      all: Boolean(opts.all),
    });
    if (opts.all) graph.cap = Math.max(graph.nodes.length, 1);
    const dest = opts.output
      ? path.resolve(opts.output)
      : path.join(opts.dataDir, "inspect.html");
    mkdirSync(path.dirname(dest), { recursive: true });
    const spend = await loadSpendDashboard(db);
    const html = renderInspectHtml({
      ...graph,
      health,
      spend,
      package_version: version,
    });
    writeFileSync(dest, html, "utf8");
    out.path = dest;
  }

  return out;
}

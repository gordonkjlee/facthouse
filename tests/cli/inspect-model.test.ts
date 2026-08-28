import { describe, it, expect } from "vitest";
import {
  visibleIds,
  egoIds,
  truncateInspect,
  lookupNamedNodes,
  DEFAULT_GRAPH_CAP,
  type InspectNode,
  type InspectEdge,
} from "../../src/cli/inspect-model.js";

function node(
  id: string,
  name: string,
  degree: number,
  type = "person",
): InspectNode {
  return {
    id,
    name,
    type,
    canonical_name: name.toLowerCase(),
    degree,
    about: 0,
    mentions: 0,
  };
}

describe("inspect view-model", () => {
  const nodes = [
    node("hub", "Hub", 40, "org"),
    ...Array.from({ length: 29 }, (_, i) =>
      node(`n${i}`, i === 28 ? "Helios" : `Node ${i}`, 29 - i, "person"),
    ),
  ];
  const edges: InspectEdge[] = nodes.slice(1).map((n) => ({
    from: "hub",
    to: n.id,
    relationship: "co_mentioned",
    strength: 0.5,
  }));
  const shared = () => 0;

  it("caps the default view and keeps the rest in the payload", () => {
    const vis = visibleIds(nodes, edges, shared, 5, "", "", null, false);
    expect(vis.ids.size).toBe(5);
    expect(vis.ids.has("hub")).toBe(true);
    expect(vis.ids.has("n28")).toBe(false);
    expect(nodes).toHaveLength(30);
  });

  it("adds a search hit outside the cap with its neighbourhood", () => {
    const vis = visibleIds(nodes, edges, shared, 5, "Helios", "", null, true);
    expect(vis.focus?.name).toBe("Helios");
    expect(vis.ids.has("n28")).toBe(true);
    expect(vis.ids.has("hub")).toBe(true);
    expect(vis.ids.size).toBeLessThanOrEqual(5);
  });

  it("keeps type-split names as separate rows", () => {
    const split = [
      node("a", "stg_orders", 1, "model"),
      node("b", "stg_orders", 1, "table"),
    ];
    const found = lookupNamedNodes(split, "stg_orders");
    expect(found).toHaveLength(2);
    expect(new Set(found.map((n) => n.type))).toEqual(new Set(["model", "table"]));
  });

  it("ego neighbourhood is centred on the focus", () => {
    const ids = egoIds(nodes, edges, shared, "n0", 4, "");
    expect(ids.has("n0")).toBe(true);
    expect(ids.has("hub")).toBe(true);
  });

  it("truncates with an ellipsis, not a silent cut", () => {
    const long = "a".repeat(300);
    const out = truncateInspect(long, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(41);
  });

  it("default graph cap is 50", () => {
    expect(DEFAULT_GRAPH_CAP).toBe(50);
  });
});

/**
 * Inspect Spend card: show intelligence routing and copy JSON.
 * Does not write config.json — the page is a snapshot.
 */

import {
  HTTP_DEFAULT_BASE_URL,
  STAGE_ON_FAIL_VALUES,
} from "../types/config.js";
import {
  INTELLIGENCE_ROUTING_HOW_TO,
  INTELLIGENCE_STAGE_NAMES,
  intelligenceRoutingSnippet,
  type IntelligenceRoutingView,
} from "../intelligence/routing-view.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const INTELLIGENCE_ROUTING_CSS = `
  .intel-card { max-width: 720px; margin: 20px auto 0; padding: 16px 18px 20px;
    background: var(--card, var(--elev)); border: 1px solid var(--line); border-radius: 12px; }
  .intel-card h2 { margin: 0 0 6px; font-size: 15px; font-weight: 650; }
  .intel-card .do { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
  .intel-grid { display: grid; gap: 8px 12px; grid-template-columns: 7rem 1fr 8rem; align-items: center; }
  .intel-grid label { color: var(--muted); font-size: 12px; }
  .intel-grid select, .intel-grid input { width: 100%; }
  .intel-hosts { margin: 10px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 12px; }
  .intel-json { margin: 12px 0 8px; padding: 10px 12px; background: var(--input); border-radius: 8px;
    overflow: auto; font: 12px/1.4 ui-monospace, monospace; white-space: pre; }
  .intel-card .copy { margin-top: 4px; }
`;

export function renderIntelligenceRoutingCard(
  view: IntelligenceRoutingView,
): string {
  const json = intelligenceRoutingSnippet(view);
  const hostOpts = view.well_known
    .map(
      (row) =>
        `<option value="${esc(row.base_url)}"${row.base_url === view.http_base_url ? " selected" : ""}>${esc(row.host)}</option>`,
    )
    .join("");
  const failOpts = (current: string) =>
    STAGE_ON_FAIL_VALUES.map(
      (v) =>
        `<option value="${v}"${v === current ? " selected" : ""}>${v}</option>`,
    ).join("");
  const providerOpts = (current: string) =>
    ["cli", "http"]
      .map(
        (v) =>
          `<option value="${v}"${v === current ? " selected" : ""}>${v}</option>`,
      )
      .join("");
  const rows = INTELLIGENCE_STAGE_NAMES.map((name) => {
    const row = view.stages[name];
    return `<label>${esc(name)}</label>
      <select data-stage="${esc(name)}" data-k="provider">${providerOpts(row.provider)}</select>
      <select data-stage="${esc(name)}" data-k="on_fail">${failOpts(row.on_fail)}</select>`;
  }).join("");
  const hosts = view.well_known
    .map((row) => `<li>${esc(row.host)} — ${esc(row.base_url)}</li>`)
    .join("");
  return `<section class="intel-card" id="om-intel">
  <h2>Local extract</h2>
  <p class="do">${esc(view.how_to || INTELLIGENCE_ROUTING_HOW_TO)}</p>
  <div class="intel-grid">
    <label for="intel-url">Host URL</label>
    <input id="intel-url" data-k="url" value="${esc(view.http_base_url || HTTP_DEFAULT_BASE_URL)}" spellcheck="false"/>
    <select id="intel-host" aria-label="Typical host">${hostOpts}<option value="">Custom</option></select>
    <label for="intel-model">Chat model</label>
    <input id="intel-model" data-k="model" value="${esc(view.http_model ?? "")}" spellcheck="false" placeholder="from GET /v1/models"/>
    <span></span>
    <span class="do">Stage</span><span class="do">Provider</span><span class="do">If it fails</span>
    ${rows}
  </div>
  <ul class="intel-hosts">${hosts}</ul>
  <pre class="intel-json" id="intel-json">${esc(json)}</pre>
  <button type="button" class="copy" id="intel-copy">Copy JSON</button>
</section>
<script>
(function(){
  var root = document.getElementById("om-intel");
  if (!root) return;
  var url = document.getElementById("intel-url");
  var model = document.getElementById("intel-model");
  var host = document.getElementById("intel-host");
  var pre = document.getElementById("intel-json");
  var copy = document.getElementById("intel-copy");
  function snippet(){
    var stages = {};
    root.querySelectorAll("select[data-stage]").forEach(function(el){
      var name = el.getAttribute("data-stage");
      var k = el.getAttribute("data-k");
      if (!name || !k) return;
      stages[name] = stages[name] || {};
      stages[name][k] = el.value;
    });
    var http = { base_url: (url && url.value.trim()) || ${JSON.stringify(HTTP_DEFAULT_BASE_URL)} };
    var m = model && model.value.trim();
    if (m) http.model = m;
    return JSON.stringify({ intelligence: { http: http, stages: stages } }, null, 2);
  }
  function refresh(){ if (pre) pre.textContent = snippet(); }
  root.addEventListener("change", refresh);
  root.addEventListener("input", refresh);
  if (host && url) host.addEventListener("change", function(){
    if (host.value) url.value = host.value;
    refresh();
  });
  if (copy) copy.addEventListener("click", function(){
    var text = snippet();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
    copy.textContent = "Copied";
    setTimeout(function(){ copy.textContent = "Copy JSON"; }, 1200);
  });
})();
</script>`;
}

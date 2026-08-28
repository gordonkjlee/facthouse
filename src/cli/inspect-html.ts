/**
 * Self-contained inspect HTML. No viz npm dependency. Does not open a browser.
 * Graph and spend are pages of this one file.
 */

import type { KnowledgeStats } from "../db/stats.js";
import { emptySpendStats } from "../intelligence/usage.js";
import type { InspectGraphPayload } from "./inspect-payload.js";
import { spendDashboardFromStats, type SpendDashboard } from "./spend-dashboard.js";
import { renderSpendBoard, SPEND_BOARD_CSS } from "./stats-html.js";

function emptyHealth(): KnowledgeStats {
  return {
    facts: { active_latest: 0, total: 0 },
    entities: 0,
    domains: 0,
    consolidations: 0,
    domain_distribution: [],
    embeddings: [],
    events: { count: 0, bytes: 0, reclaimable: { events: 0, bytes: 0 } },
    extract: { watermark: 0, unextracted_events: 0 },
    pending_facts: 0,
    intelligence: emptySpendStats(),
  };
}

export function renderInspectHtml(
  payload: InspectGraphPayload & {
    package_version?: string | null;
    health?: KnowledgeStats;
    spend?: SpendDashboard;
  },
): string {
  const { health, spend, ...graph } = payload;
  const json = JSON.stringify(graph).replace(/</g, "\\u003c");
  const spendHtml = renderSpendBoard(
    spend ?? spendDashboardFromStats(health ?? emptyHealth()),
  );
  return `<!DOCTYPE html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OpenMemory inspect</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0e1218; --panel: #161c25; --line: #2a3340; --text: #e7edf5;
    --muted: #8b98a8; --accent: #6ea8ff; --about: #7dcea0; --mention: #e0b44a;
    --elev: #1c2430; --input: #0e1218; --chip: #243044; --glow: #152033;
    --canvas-label: rgba(14,18,24,0.78); --canvas-label-text: #e7edf5;
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #f3f5f7; --panel: #ffffff; --line: #d5dbe3; --text: #1a2330;
    --muted: #5c6b7a; --accent: #245fd6; --about: #18764a; --mention: #9a5700;
    --elev: #eef1f5; --input: #ffffff; --chip: #e4e9f0; --glow: #dce6f2;
    --canvas-label: rgba(255,255,255,0.88); --canvas-label-text: #1a2330;
  }
  @media (prefers-color-scheme: light) {
    html[data-theme="system"] {
      color-scheme: light;
      --bg: #f3f5f7; --panel: #ffffff; --line: #d5dbe3; --text: #1a2330;
      --muted: #5c6b7a; --accent: #245fd6; --about: #18764a; --mention: #9a5700;
      --elev: #eef1f5; --input: #ffffff; --chip: #e4e9f0; --glow: #dce6f2;
      --canvas-label: rgba(255,255,255,0.88); --canvas-label-text: #1a2330;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
    font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
  header { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center;
    padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  header .meta { color: var(--muted); }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-left: auto; }
  input, select, button {
    background: var(--input); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; font: inherit; }
  input[type="search"] { width: 240px; }
  input[type="range"] { width: 92px; }
  button { cursor: pointer; }
  button:hover, .tab.on { border-color: var(--accent); color: var(--accent); }
  .icon-btn { width: 32px; height: 32px; padding: 0; display: flex; align-items: center;
    justify-content: center; background: var(--elev); }
  .icon-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  #stage { display: grid; min-height: 0; --panel: 420px;
    grid-template-columns: 1fr 6px var(--panel); grid-template-areas: "graph split panel"; }
  #stage.dock-left { grid-template-columns: var(--panel) 6px 1fr;
    grid-template-areas: "panel split graph"; }
  #stage.dock-bottom { grid-template-columns: 1fr; grid-template-rows: 1fr 6px var(--panel);
    grid-template-areas: "graph" "split" "panel"; }
  #stage.dock-top { grid-template-columns: 1fr; grid-template-rows: var(--panel) 6px 1fr;
    grid-template-areas: "panel" "split" "graph"; }
  #graphwrap { grid-area: graph; position: relative; min-width: 0; min-height: 0; }
  #splitter { grid-area: split; background: var(--line); cursor: col-resize; }
  #stage.dock-bottom #splitter, #stage.dock-top #splitter { cursor: row-resize; }
  aside { grid-area: panel; min-width: 0; min-height: 0; background: var(--panel);
    position: relative; display: flex; flex-direction: column; }
  canvas { width: 100%; height: 100%; display: block; background:
    radial-gradient(1200px 800px at 30% 20%, var(--glow) 0%, var(--bg) 60%); }
  #refocus { position: absolute; top: 12px; right: 12px; z-index: 2;
    background: var(--elev); border: 1px solid var(--accent); color: var(--text); }
  #zoom { position: absolute; bottom: 12px; right: 12px; z-index: 2;
    display: flex; flex-direction: column; gap: 4px; }
  #zoom button { width: 36px; height: 32px; padding: 0; font-size: 16px; background: var(--elev); }
  #graphBar { position: absolute; bottom: 12px; left: 12px; z-index: 2;
    display: flex; align-items: center; gap: 8px; background: var(--elev);
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
  #graphBar label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .who { padding: 12px 76px 8px 14px; border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .who h2 { font-size: 16px; margin: 0 0 4px; overflow-wrap: anywhere; }
  .who .type { color: var(--muted); overflow-wrap: anywhere; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .tab { flex: 1; min-width: 0; background: transparent; border: 0;
    border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 4px;
    color: var(--muted); font-size: 12px; }
  .tab.on { border-bottom-color: var(--accent); color: var(--text); }
  .body { overflow: auto; padding: 12px 14px 24px; flex: 1; min-height: 0; }
  .fact { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .fact.expired, .fact.superseded { opacity: 0.62; }
  .fact.hi { background: var(--elev); margin: 0 -8px; padding-left: 8px; padding-right: 8px;
    border-radius: 6px; box-shadow: inset 3px 0 0 var(--accent); }
  .fact-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .fact-left { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
  .fact .when { color: var(--muted); font-size: 12px; white-space: nowrap; margin-left: auto; padding-left: 8px; }
  .fact .flag { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--about); }
  .fact .flag.mention { color: var(--mention); }
  .fact .dom, .fact .meta-line { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .fact .txt, .fact > div { overflow-wrap: anywhere; }
  .fact-actions { margin-top: 6px; }
  .nlist { list-style: none; padding: 0; margin: 0; }
  .nlist li { padding: 8px 0; border-bottom: 1px solid var(--line); }
  a.link { color: var(--accent); cursor: pointer; text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .empty, .hint, .conv-head { color: var(--muted); font-size: 12px; }
  .conv-head { margin: 14px 0 6px; font-weight: 600; }
  .filterbar { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start;
    margin-bottom: 10px; padding: 8px 10px; background: var(--elev); border-radius: 6px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 8px; }
  #details.on { border-color: var(--accent); color: var(--accent); }
  .meters { display: flex; gap: 10px; margin-top: 6px; }
  .meter { width: 56px; }
  .meter span { display: block; font-size: 10px; color: var(--muted); }
  .meter i { display: block; height: 3px; background: var(--chip); border-radius: 2px; margin-top: 2px; }
  .meter i b { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .meter.imp i b { background: var(--mention); }
  .meter.quiet { opacity: 0.4; }
  .chip { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--chip); font-size: 11px; }
  #panelTools { position: absolute; top: 8px; right: 10px; z-index: 4; display: flex; gap: 4px; }
  #dockWrap { position: relative; }
  #dockBtn { width: 28px; height: 24px; padding: 2px; display: flex; align-items: center; justify-content: center; }
  #dockMenu { display: none; position: absolute; top: 100%; right: 0; margin-top: 4px;
    background: var(--elev); border: 1px solid var(--line); border-radius: 6px; padding: 6px;
    grid-template-columns: 1fr 1fr; gap: 4px; }
  #dockMenu.open { display: grid; }
  #dockMenu button { width: 36px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; }
  #dockMenu button.is-current { opacity: 0.35; pointer-events: none; }
  .dock-ico { display: block; width: 16px; height: 12px; position: relative;
    border: 1.5px solid currentColor; border-radius: 2px; }
  .dock-ico::after { content: ""; position: absolute; background: currentColor; }
  .dock-ico.right::after { top: 0; right: 0; bottom: 0; width: 38%; }
  .dock-ico.left::after { top: 0; left: 0; bottom: 0; width: 38%; }
  .dock-ico.bottom::after { left: 0; right: 0; bottom: 0; height: 38%; }
  .dock-ico.top::after { left: 0; right: 0; top: 0; height: 38%; }
  .views { display: flex; gap: 4px; }
  .view-btn.on { border-color: var(--accent); color: var(--accent); }
  html.view-spend #stage { display: none; }
  html.view-spend #spend { display: block; }
  html.view-spend .graph-only { display: none; }
  #stage, #spend { grid-row: 2; min-height: 0; }
  #spend {
    display: none; overflow: auto; padding: 20px 24px 48px;
    --card: var(--elev); --ink: var(--text); --gold: var(--mention); --warn: #c97b6a;
  }
  ${SPEND_BOARD_CSS}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>OpenMemory inspect</h1>
    <div class="views" role="tablist">
      <button type="button" class="view-btn on" data-view="graph" id="viewGraph">Graph</button>
      <button type="button" class="view-btn" data-view="spend" id="viewSpend">Spend</button>
    </div>
    <div class="meta" id="meta"></div>
    <div class="controls">
      <input id="q" class="graph-only" type="search" placeholder="Find an entity by name"/>
      <select id="type" class="graph-only"><option value="">All types</option></select>
      <button type="button" id="themeBtn" class="icon-btn" title="Toggle colour theme">
        <svg id="themeSun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        <svg id="themeMoon" viewBox="0 0 24 24" hidden><path d="M21 14.3A8.5 8.5 0 1 1 9.7 3 7 7 0 0 0 21 14.3z"/></svg>
      </button>
    </div>
  </header>
  <div id="stage" class="dock-right">
    <div id="graphwrap">
      <canvas id="cv"></canvas>
      <button id="refocus" type="button" hidden>Refocus</button>
      <div id="graphBar">
        <button id="reset" type="button">Reset</button>
        <label>Show <span id="capLabel">50</span>
          <input id="cap" type="range" min="10" max="200" step="5" value="50"/>
        </label>
      </div>
      <div id="zoom">
        <button id="zoomIn" type="button" title="Zoom in">+</button>
        <button id="zoomOut" type="button" title="Zoom out">−</button>
        <button id="zoomFit" type="button" title="Fit">⤢</button>
      </div>
    </div>
    <div id="splitter"></div>
    <aside>
      <div id="panelTools">
        <button type="button" id="details" class="icon-btn" title="Show extra fields on cards">
          <svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18.5" cy="7" r="2"/></svg>
        </button>
        <div id="dockWrap">
          <button type="button" id="dockBtn" title="Move panel"><span id="dockBtnIco" class="dock-ico right"></span></button>
          <div id="dockMenu" hidden>
            <button type="button" data-dock="left" title="Left"><span class="dock-ico left"></span></button>
            <button type="button" data-dock="right" title="Right"><span class="dock-ico right"></span></button>
            <button type="button" data-dock="top" title="Top"><span class="dock-ico top"></span></button>
            <button type="button" data-dock="bottom" title="Bottom"><span class="dock-ico bottom"></span></button>
          </div>
        </div>
      </div>
      <div class="who" id="who"></div>
      <div class="tabs" id="tabs"></div>
      <div class="body" id="body"></div>
    </aside>
  </div>
  <div id="spend">${spendHtml}</div>
</div>
<script>
const DATA = ${json};
function setInspectView(v){
  document.documentElement.classList.toggle("view-spend", v==="spend");
  document.querySelectorAll(".view-btn").forEach(function(b){
    b.classList.toggle("on", b.getAttribute("data-view")===v);
  });
  if (v==="spend") location.hash="spend";
  else if (location.hash==="#spend") location.hash="graph";
}
document.querySelectorAll(".view-btn").forEach(function(b){
  b.addEventListener("click", function(){ setInspectView(b.getAttribute("data-view")); });
});
if (location.hash==="#spend") setInspectView("spend");
const SUBJECT = "subject_of";
const NEAR_USER = 8;
const NEAR_RADIUS = 3;
function hue(s){let h=0;for(let i=0;i<s.length;i++)h=(h*33+s.charCodeAt(i))>>>0;return h%360;}
function colour(type){return "hsl("+hue(type||"?")+" 62% 62%)";}
function esc(s){return String(s??"").replace(/[&<>"'']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}
const byId=new Map((DATA.nodes||[]).map(n=>[n.id,n]));
const factById=new Map((DATA.facts||[]).map(f=>[f.id,f]));
const eventById=new Map((DATA.events||[]).map(e=>[e.id,e]));
const infoById=new Map((DATA.info||[]).map(i=>[i.id,i]));
const sourceById=new Map((DATA.sources||[]).map(s=>[s.id,s]));
const dForI=new Map();
for(const row of DATA.iToD||[]){if(!dForI.has(row.session_fact_id))dForI.set(row.session_fact_id,[]);dForI.get(row.session_fact_id).push(row);}
const eventsByConv=new Map();
for(const e of DATA.events||[]){const c=e.conversation||"";if(!eventsByConv.has(c))eventsByConv.set(c,[]);eventsByConv.get(c).push(e.id);}
const linksByEntity=new Map();
for(const l of DATA.links||[]){if(!linksByEntity.has(l.entity_id))linksByEntity.set(l.entity_id,[]);linksByEntity.get(l.entity_id).push(l);}
const typeSel=document.getElementById("type");
for(const t of [...new Set((DATA.nodes||[]).map(n=>n.type))].sort()){const o=document.createElement("option");o.value=t;o.textContent=t;typeSel.appendChild(o);}
document.getElementById("meta").textContent=(DATA.nodes||[]).length+" entities · "+(DATA.facts||[]).length+" facts · "+(DATA.eventCount||0)+" raw events";
function sharedCount(a,b){const fa=new Set((linksByEntity.get(a)||[]).map(l=>l.fact_id));let n=0;const seen=new Set();for(const l of linksByEntity.get(b)||[]){if(fa.has(l.fact_id)&&!seen.has(l.fact_id)){seen.add(l.fact_id);n++;}}return n;}
function egoIds(centerId,cap,typeFilter){
  const scores=new Map();
  for(const e of DATA.edges||[]){if(e.from===centerId)scores.set(e.to,(scores.get(e.to)||0)+10*e.strength);if(e.to===centerId)scores.set(e.from,(scores.get(e.from)||0)+10*e.strength);}
  for(const n of DATA.nodes||[]){if(n.id===centerId)continue;const sh=sharedCount(centerId,n.id);if(sh)scores.set(n.id,(scores.get(n.id)||0)+sh);}
  const ranked=[...scores.entries()].sort((a,b)=>b[1]-a[1]).map(([id])=>byId.get(id)).filter(Boolean).filter(n=>!typeFilter||n.type===typeFilter||n.id===centerId);
  const ids=new Set([centerId]);for(const n of ranked){if(ids.size>=cap)break;ids.add(n.id);}return ids;
}
function visibleIds(cap,query,typeFilter,center,focused){
  const q=query.trim().toLowerCase();
  let focus=center||null;
  if(!focus&&q){focus=(DATA.nodes||[]).find(n=>n.name.toLowerCase()===q||n.canonical_name===q)||(DATA.nodes||[]).find(n=>n.name.toLowerCase().includes(q)||n.canonical_name.includes(q))||null;}
  if(focused&&focus)return {ids:egoIds(focus.id,cap,typeFilter),focus};
  const ranked=[...(DATA.nodes||[])].sort((a,b)=>b.degree-a.degree||a.name.localeCompare(b.name));
  const ids=new Set();for(const n of ranked){if(ids.size>=cap)break;if(typeFilter&&n.type!==typeFilter)continue;ids.add(n.id);}
  if(focus)ids.add(focus.id);return {ids,focus};
}
const cv=document.getElementById("cv");const ctx=cv.getContext("2d");
let cam={x:0,y:0,k:1},sim=[],selected=null,selectedEdge=null,focusMode=false,focusedId=null,tab="knowledge",tabFilter=null,dataNewest=false,showDetails=false,dragging=null,lastPan=null,down=null,hotSet=null,anim=0,cooling=0,frames=0,fitAfterAnim=false;
try{showDetails=localStorage.getItem("om-inspect-details")==="1";}catch(e){}
if(DATA.selectedId)selected=byId.get(DATA.selectedId)||null;
if(selected)focusMode=true,focusedId=selected.id;
const capEl=document.getElementById("cap");
if(DATA.cap){capEl.value=String(Math.min(200,Math.max(10,DATA.cap)));document.getElementById("capLabel").textContent=capEl.value;}
function radius(n){return 4+Math.min(14,Math.sqrt(n.degree||1)*2.2);}
function markHot(id){hotSet=new Set([id]);for(const e of DATA.edges||[]){if(e.from===id)hotSet.add(e.to);if(e.to===id)hotSet.add(e.from);}}
function startLayout(ids,opts){
  const fresh=opts&&opts.fresh;const nodes=[...ids].map(id=>byId.get(id)).filter(Boolean);
  const old=fresh?new Map():new Map(sim.map(p=>[p.id,p]));
  const origin=(selected&&old.get(selected.id))||{x:0,y:0};
  sim=nodes.map((n,i)=>{const p=old.get(n.id);if(p)return {...n,x:p.x,y:p.y,vx:0,vy:0};
    const ang=(i/Math.max(nodes.length,1))*Math.PI*2;
    if(old.size===0)return {...n,x:Math.cos(ang)*280,y:Math.sin(ang)*280,vx:0,vy:0};
    const j=Math.random()*Math.PI*2;return {...n,x:origin.x+Math.cos(j)*24,y:origin.y+Math.sin(j)*24,vx:Math.cos(j)*3,vy:Math.sin(j)*3};});
  cooling=1;frames=0;if(!anim)anim=requestAnimationFrame(tick);
}
function stepPhysics(){
  const pmap=new Map(sim.map(p=>[p.id,p]));const idSet=new Set(sim.map(n=>n.id));
  const links=(DATA.edges||[]).filter(e=>idSet.has(e.from)&&idSet.has(e.to));
  for(let i=0;i<sim.length;i++)for(let j=i+1;j<sim.length;j++){
    let dx=sim[j].x-sim[i].x,dy=sim[j].y-sim[i].y,d=Math.hypot(dx,dy)||0.01;
    const minD=radius(sim[i])+radius(sim[j])+22;let f=420/(d*d);if(d<minD)f+=(minD-d)*0.22;
    const fx=f*dx/d,fy=f*dy/d;sim[i].vx-=fx;sim[i].vy-=fy;sim[j].vx+=fx;sim[j].vy+=fy;
  }
  for(const e of links){const a=pmap.get(e.from),b=pmap.get(e.to);if(!a||!b)continue;
    let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||0.01,f=(d-130)*0.035;
    a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;}
  let energy=0;for(const p of sim){p.vx*=0.72;p.vy*=0.72;const sp=Math.hypot(p.vx,p.vy);if(sp>18){p.vx*=18/sp;p.vy*=18/sp;}p.x+=p.vx;p.y+=p.vy;energy+=p.vx*p.vx+p.vy*p.vy;}
  return energy;
}
function tick(){frames++;let energy=0;for(let s=0;s<8;s++)energy=stepPhysics();cooling*=0.86;draw();
  if(frames<32&&(cooling>0.12||energy>12))anim=requestAnimationFrame(tick);else{anim=0;if(fitAfterAnim){fitView();fitAfterAnim=false;}}}
function draw(){
  const w=cv.clientWidth,h=cv.clientHeight;ctx.clearRect(0,0,w,h);ctx.save();ctx.translate(w/2+cam.x,h/2+cam.y);ctx.scale(cam.k,cam.k);
  const css=getComputedStyle(document.documentElement);
  const labelBg=css.getPropertyValue("--canvas-label").trim();const labelFg=css.getPropertyValue("--canvas-label-text").trim();const selStroke=css.getPropertyValue("--text").trim();
  const idSet=new Set(sim.map(n=>n.id));const pmap=new Map(sim.map(p=>[p.id,p]));
  for(const e of DATA.edges||[]){if(!idSet.has(e.from)||!idSet.has(e.to))continue;const a=pmap.get(e.from),b=pmap.get(e.to);
    const edgeOn=selectedEdge&&((selectedEdge.from===e.from&&selectedEdge.to===e.to)||(selectedEdge.from===e.to&&selectedEdge.to===e.from));
    const hot=edgeOn||(selected&&(e.from===selected.id||e.to===selected.id));
    ctx.strokeStyle=edgeOn?"rgba(224,180,74,0.9)":hot?"rgba(110,168,255,0.7)":"rgba(139,152,168,0.22)";
    ctx.lineWidth=edgeOn?2.4:hot?1.6:0.6+e.strength;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
  for(const n of sim){const r=radius(n);ctx.beginPath();ctx.fillStyle=colour(n.type);
    const dim=selected&&selected.id!==n.id&&!selectedEdge&&hotSet&&!hotSet.has(n.id);ctx.globalAlpha=dim?0.35:1;ctx.arc(n.x,n.y,r,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
    if((selected&&selected.id===n.id)||(selectedEdge&&(selectedEdge.from===n.id||selectedEdge.to===n.id))){ctx.strokeStyle=selStroke||"#fff";ctx.lineWidth=2;ctx.stroke();}
    if(cam.k>0.85||(selected&&selected.id===n.id)||n.degree>=8){const label=n.name.length>28?n.name.slice(0,27)+"…":n.name;ctx.font="11px ui-sans-serif, system-ui, sans-serif";
      const tw=ctx.measureText(label).width;ctx.fillStyle=labelBg||"rgba(14,18,24,0.75)";ctx.fillRect(n.x+r+3,n.y-8,tw+6,14);ctx.fillStyle=labelFg||"#e7edf5";ctx.fillText(label,n.x+r+6,n.y+3);}}
  ctx.restore();syncRefocus();
}
function screenToWorld(sx,sy){return {x:(sx-cv.clientWidth/2-cam.x)/cam.k,y:(sy-cv.clientHeight/2-cam.y)/cam.k};}
function hitNode(sx,sy){const p=screenToWorld(sx,sy);let best=null,bestD=1e9;for(const n of sim){const d=Math.hypot(n.x-p.x,n.y-p.y);if(d<radius(n)+4&&d<bestD){best=n;bestD=d;}}return best;}
function hitEdge(sx,sy){const p=screenToWorld(sx,sy);const pmap=new Map(sim.map(n=>[n.id,n]));let best=null,bestD=8/cam.k;
  for(const e of DATA.edges||[]){const a=pmap.get(e.from),b=pmap.get(e.to);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy||1;let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;t=Math.max(0,Math.min(1,t));
    const d=Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));if(d<bestD){best=e;bestD=d;}}return best;}
function isEndedFact(f){return f.status==="superseded"||!!f.valid_until||f.is_latest===0||f.is_latest===false;}
function factsForEntity(id){
  const rows=(linksByEntity.get(id)||[]).map(l=>({rel:l.relationship,fact:factById.get(l.fact_id)})).filter(x=>x.fact);
  const seen=new Set(),about=[],mentions=[];
  for(const r of rows){if(seen.has(r.fact.id))continue;seen.add(r.fact.id);const isAbout=rows.some(x=>x.fact.id===r.fact.id&&x.rel===SUBJECT);(isAbout?about:mentions).push(r.fact);}
  const byRank=(a,b)=>{const ae=isEndedFact(a)?1:0,be=isEndedFact(b)?1:0;if(ae!==be)return ae-be;return (b.importance||0)-(a.importance||0);};
  about.sort(byRank);mentions.sort(byRank);return {about,mentions};
}
function day(iso){if(!iso)return "";const s=String(iso);if(/T00:00:00/.test(s))return s.slice(0,10);return s.slice(0,19).replace("T"," ");}
function clock(iso){if(!iso)return "";const s=String(iso);if(/T00:00:00/.test(s))return s.slice(0,10);const m=s.match(/T(\\d{2}:\\d{2})/);return m?m[1]:day(iso);}
function eventWhen(e){return e.occurred_at||e.created_at||"";}
function toolLabel(e){if(e.tool_name)return "Tool "+e.tool_name;if(e.event_type==="tool_call"||e.event_type==="tool_result"||e.role==="tool")return "Tool";if(e.role==="user")return "User";if(e.role==="assistant")return "Assistant";return e.role||"event";}
function pct(n){if(n==null||n==="")return "";const x=Number(n);if(Number.isNaN(x))return esc(n);return Math.round(x*100)+"%";}
function validityLabel(f){const from=day(f.valid_from);if(f.status==="superseded"||f.valid_until)return (from||day(f.created_at))+" – "+(day(f.valid_until)||"ended");if(from)return from+" – present";return day(f.created_at)||"";}
function meterHtml(kind,value){if(value==null||value==="")return "";const x=Number(value);if(!Number.isFinite(x))return "";const def=kind==="imp"?0.5:0.7;const quiet=Math.abs(x-def)<0.051?" quiet":"";
  return "<div class='meter"+(kind==="imp"?" imp":"")+quiet+"' title='"+(kind==="imp"?"importance ":"confidence ")+pct(x)+"'><span>"+(kind==="imp"?"imp":"conf")+"</span><i><b style='width:"+Math.round(x*100)+"%'></b></i></div>";}
function iIdForFact(factId){const fact=factById.get(factId);const src=fact&&sourceById.get(fact.source_id);return (src&&src.session_fact_id)||null;}
function expandEventIds(ids){const set=new Set(ids);for(const id of ids){const hit=eventById.get(id);if(!hit)continue;let nearest=null;
  for(const eid of eventsByConv.get(hit.conversation||"")||[]){const ev=eventById.get(eid);if(!ev)continue;if(Math.abs(ev.sequence-hit.sequence)<=NEAR_RADIUS)set.add(ev.id);
    if(ev.role==="user"&&ev.sequence<=hit.sequence&&hit.sequence-ev.sequence<=NEAR_USER)nearest=ev;}if(nearest)set.add(nearest.id);}return [...set];}
const dataIdsCache=new Map();
function dataIdsForI(iId){const key=iId+":"+(selected?selected.id:"");if(dataIdsCache.has(key))return dataIdsCache.get(key);
  const rows=dForI.get(iId)||[];const primary=rows.filter(r=>r.extraction_type!=="contextual").map(r=>r.event_id).filter(id=>eventById.has(id));
  let ids;if(primary.length)ids=expandEventIds(primary);else{const irow=infoById.get(iId);const conv=irow&&irow.session_id;const convIds=conv?(eventsByConv.get(conv)||[]):[];
    const around=selected?(DATA.dByEntity[selected.id]||[]):[];const aroundSet=new Set(around);const overlap=convIds.filter(id=>aroundSet.has(id));ids=overlap.length?expandEventIds(overlap):[...new Set(convIds)];}
  dataIdsCache.set(key,ids);return ids;}
function factCard(f,flag,kind){
  const superseded=f.status==="superseded";const expired=!superseded&&!!f.valid_until;const when=validityLabel(f);
  const meters=showDetails?"<div class='meters'>"+meterHtml("conf",f.confidence)+meterHtml("imp",f.importance)+"</div>":"";
  let drill="";if(kind==="k"&&f.source_id){const iid=iIdForFact(f.id);drill=iid&&infoById.has(iid)?" <a class='link jump-i' data-id='"+esc(f.id)+"'>Show Information</a>":"";}
  if(kind==="i"&&f.id){const n=dataIdsForI(f.id).length;drill=n?" <a class='link jump-d' data-iid='"+esc(f.id)+"'>Show Data ("+n+")</a>":" <span class='dom'>No Data in this snapshot</span>";}
  const ended=superseded?"<span class='chip'>superseded</span>":expired?"<span class='chip'>no longer valid</span>":"";
  const klass=superseded?" superseded":expired?" expired":"";
  return "<div class='fact"+klass+"'><div class='fact-head'><div class='fact-left'><span class='flag"+(flag==="mention"?" mention":"")+"'>"+flag+"</span>"+ended+(f.domain||f.domain_hint?"<span class='dom'>"+esc(f.domain||f.domain_hint)+"</span>":"")+"</div>"+(when?"<span class='when'>"+esc(when)+"</span>":"")+"</div><div>"+esc(f.content)+"</div>"+meters+(drill?"<div class='fact-actions'>"+drill+"</div>":"")+"</div>";
}
function eventBlock(e,extra){if(!e)return "";const more=e.full?" <a class='link more' data-id='"+esc(e.id)+"'>Expand</a>":"";const chip=extra?"<span class='chip'>"+esc(extra)+"</span>":"";const time=clock(eventWhen(e));
  return "<div class='fact' data-eid='"+esc(e.id)+"'><div class='fact-head'><div class='fact-left'><span class='flag mention'>"+esc(toolLabel(e))+"</span>"+chip+"</div>"+(time?"<span class='when'>"+esc(time)+"</span>":"")+"</div><div class='txt'>"+esc(e.content)+"</div>"+more+"</div>";}
function convLabel(group){const first=group[0],last=group[group.length-1];const a=day(eventWhen(first)),b=day(eventWhen(last));
  const when=a&&b&&a.slice(0,10)!==b.slice(0,10)?a+" – "+b:(a||b||"Conversation");return when+" · "+group.length+(group.length===1?" line":" lines");}
function renderEventList(ids,extraById){const seen=new Set(),events=[];for(const id of ids){if(seen.has(id))continue;const e=eventById.get(id);if(!e)continue;seen.add(id);events.push(e);}
  const byConv=new Map();for(const e of events){const c=e.conversation||"";if(!byConv.has(c))byConv.set(c,[]);byConv.get(c).push(e);}
  const groups=[...byConv.values()];for(const g of groups)g.sort((a,b)=>a.sequence-b.sequence);
  groups.sort((a,b)=>(eventWhen(a[0])||"").localeCompare(eventWhen(b[0])||"")||a[0].sequence-b[0].sequence);
  if(dataNewest){groups.reverse();for(const g of groups)g.reverse();}
  if(!groups.length)return "<p class='empty'>No transcript lines in this snapshot.</p>";
  let html="";for(const g of groups){html+="<p class='conv-head'>"+esc(convLabel(g))+"</p>";for(const e of g)html+=eventBlock(e,extraById&&extraById.get(e.id));}return html;}
function bindPanel(root){root.querySelectorAll("a.more").forEach(a=>a.onclick=ev=>{ev.preventDefault();const e=eventById.get(a.getAttribute("data-id"));const card=a.parentElement&&a.parentElement.querySelector(".txt");if(!e||!card)return;const open=a.textContent==="Expand";card.textContent=open?e.full:e.content;a.textContent=open?"Collapse":"Expand";});
  root.querySelectorAll("a.jump-i").forEach(a=>a.onclick=ev=>{ev.preventDefault();const fact=factById.get(a.getAttribute("data-id"));tabFilter={tab:"information",iId:iIdForFact(fact&&fact.id),fromFactId:fact&&fact.id,snippet:fact?String(fact.content||"").slice(0,88):""};tab="information";render();});
  root.querySelectorAll("a.jump-d").forEach(a=>a.onclick=ev=>{ev.preventDefault();const iId=a.getAttribute("data-iid");const irow=infoById.get(iId);tabFilter={tab:"data",iId,eventIds:dataIdsForI(iId),snippet:irow?String(irow.content||"").slice(0,88):""};tab="data";render();});}
function render(){syncRefocus();const who=document.getElementById("who"),tabs=document.getElementById("tabs"),body=document.getElementById("body");
  if(selectedEdge){const a=byId.get(selectedEdge.from),b=byId.get(selectedEdge.to);const fa=new Set((linksByEntity.get(selectedEdge.from)||[]).map(l=>l.fact_id));const shared=[];const seen=new Set();
    for(const l of linksByEntity.get(selectedEdge.to)||[]){if(fa.has(l.fact_id)&&!seen.has(l.fact_id)){seen.add(l.fact_id);const f=factById.get(l.fact_id);if(f)shared.push(f);}}
    who.innerHTML="<h2>Link</h2><div class='type'><a class='link go' data-id='"+esc(a&&a.id)+"'>"+esc(a&&a.name)+"</a> ↔ <a class='link go' data-id='"+esc(b&&b.id)+"'>"+esc(b&&b.name)+"</a></div>";
    tabs.innerHTML="";body.innerHTML=shared.length?shared.map(f=>factCard(f,"names both","k")).join(""):"<p class='empty'>No current fact names both.</p>";bindPanel(body);
    who.querySelectorAll("a.go").forEach(el=>el.onclick=()=>{const t=byId.get(el.getAttribute("data-id"));if(!t)return;selected=t;selectedEdge=null;tab="knowledge";tabFilter=null;markHot(t.id);render();draw();});return;}
  if(!selected){who.innerHTML="<h2>Nothing selected</h2><div class='type'>Click a node, a line, or search.</div>";tabs.innerHTML="";
    body.innerHTML="<p>The picture is the entity graph. Knowledge lives on the facts. Select something to read it.</p>";return;}
  const n=selected;const fk=factsForEntity(n.id);const dIds=DATA.dByEntity[n.id]||[];const needle=(n.canonical_name||n.name||"").toLowerCase();
  const info=(DATA.info||[]).filter(p=>(p.content||"").toLowerCase().includes(needle));
  const kNow=fk.about.filter(f=>!isEndedFact(f)).length+fk.mentions.filter(f=>!isEndedFact(f)).length;
  who.innerHTML="<h2>"+esc(n.name)+"</h2><div class='type'>"+esc(n.type)+" · "+n.about+" facts about it · "+n.mentions+" mentions</div>";
  tabs.innerHTML="<button class='tab"+(tab==="knowledge"?" on":"")+"' data-t='knowledge'>Knowledge ("+kNow+")</button>"+
    "<button class='tab"+(tab==="information"?" on":"")+"' data-t='information'>Information ("+info.length+")</button>"+
    "<button class='tab"+(tab==="data"?" on":"")+"' data-t='data'>Data ("+(n.dCount!=null?n.dCount:dIds.length)+")</button>"+
    "<button class='tab"+(tab==="links"?" on":"")+"' data-t='links'>Links</button>";
  tabs.querySelectorAll(".tab").forEach(btn=>btn.onclick=()=>{tab=btn.getAttribute("data-t");if(!tabFilter||tabFilter.tab!==tab)tabFilter=null;render();});
  if(tab==="knowledge"){const aboutNow=fk.about.filter(f=>!isEndedFact(f)),aboutOld=fk.about.filter(f=>isEndedFact(f)),menNow=fk.mentions.filter(f=>!isEndedFact(f)),menOld=fk.mentions.filter(f=>isEndedFact(f));
    let html="";if(aboutNow.length)html+="<p class='hint'>About this entity</p>"+aboutNow.map(f=>factCard(f,"about","k")).join("");
    if(menNow.length)html+="<p class='hint'>Mentions</p>"+menNow.map(f=>factCard(f,"mention","k")).join("");
    if(aboutOld.length||menOld.length)html+="<p class='hint'>No longer current</p>"+aboutOld.concat(menOld).map(f=>factCard(f,f.status==="superseded"?"superseded":"ended","k")).join("");
    if(!html)html="<p class='empty'>No current fact is attached to this entity.</p>";body.innerHTML=html;bindPanel(body);}
  else if(tab==="data"){const filtered=tabFilter&&tabFilter.tab==="data";const showIds=filtered?(tabFilter.eventIds||[]):dIds;
    let html="";if(filtered)html+="<div class='filterbar'><div><div class='filterbar-title'>Showing "+showIds.length+" Data</div></div><button type='button' id='clearFilter'>Clear filter</button></div>";
    html+="<div class='toolbar'><a class='link' id='dataSort'>"+(dataNewest?"Oldest first":"Newest first")+"</a></div>";
    if(!filtered&&n.dCount!=null&&n.dCount!==dIds.length)html+=n.dCount>dIds.length?"<p class='hint'>Listing "+dIds.length+" of "+n.dCount+" lines that name this in the store.</p>":"<p class='hint'>Listing "+dIds.length+" lines; "+n.dCount+" name this, the rest are nearby turns.</p>";
    html+=showIds.length?renderEventList(showIds,null):"<p class='empty'>No raw events in this snapshot mention this name. The store has "+DATA.eventCount+" events; this file includes "+DATA.eventShown+" with text.</p>";
    body.innerHTML=html;bindPanel(body);const cf=document.getElementById("clearFilter");if(cf)cf.onclick=()=>{tabFilter=null;render();};
    const ds=document.getElementById("dataSort");if(ds)ds.onclick=ev=>{ev.preventDefault();dataNewest=!dataNewest;render();};}
  else if(tab==="information"){const card=(p,flag)=>factCard({id:p.id,content:p.content,domain_hint:p.domain_hint,confidence:p.confidence,importance:p.importance,speaker:p.speaker,speaker_role:p.speaker_role,created_at:p.created_at,valid_from:p.valid_from_hint,valid_until:p.valid_until_hint,source_origin:p.source_origin,source_quality:p.source_quality},flag,"i");
    const filtered=tabFilter&&tabFilter.tab==="information";const rows=filtered?(tabFilter.iId&&infoById.get(tabFilter.iId)?[infoById.get(tabFilter.iId)]:[]):info;
    let html="";if(filtered)html+="<div class='filterbar'><div><div class='filterbar-title'>Showing "+rows.length+" of "+info.length+" Information</div></div><button type='button' id='clearFilter'>Clear filter</button></div>";
    if(!rows.length)html+=filtered?"<p class='empty'>No extracted sentence is linked to that Knowledge.</p>":"<p class='empty'>No extracted sentences for this name.</p>";
    else html+=rows.map(p=>card(p,p.consolidation_id?"extracted":"waiting")).join("");
    body.innerHTML=html;bindPanel(body);const cf=document.getElementById("clearFilter");if(cf)cf.onclick=()=>{tabFilter=null;render();};}
  else{const inc=(DATA.edges||[]).filter(e=>e.from===n.id||e.to===n.id).sort((a,b)=>b.strength-a.strength);const seen=new Set();const neigh=[];
    for(const e of inc){const other=e.from===n.id?e.to:e.from;if(seen.has(other))continue;seen.add(other);neigh.push({id:other,edge:e});if(neigh.length>=15)break;}
    if(!neigh.length)body.innerHTML="<p class='empty'>No co-mention edges from this node.</p>";
    else{body.innerHTML="<ul class='nlist'>"+neigh.map(x=>{const o=byId.get(x.id);return "<li><a class='link go' data-id='"+x.id+"'>"+esc(o&&o.name)+"</a> · "+esc(o&&o.type)+" · strength "+x.edge.strength.toFixed(2)+"</li>";}).join("")+"</ul>";
      body.querySelectorAll("a.go").forEach(a=>a.onclick=()=>{const t=byId.get(a.getAttribute("data-id"));if(!t)return;selected=t;selectedEdge=null;tab="knowledge";tabFilter=null;markHot(t.id);render();draw();});}}
}
function rebuild(resetCam){const cap=Number(document.getElementById("cap").value);document.getElementById("capLabel").textContent=String(cap);
  const vis=visibleIds(cap,document.getElementById("q").value,document.getElementById("type").value,selected,focusMode);
  startLayout(vis.ids,{fresh:!!resetCam});if(vis.focus)selected=vis.focus;else if(selected&&!vis.ids.has(selected.id))selected=null;syncRefocus();if(resetCam)cam={x:0,y:0,k:1};}
function selectedOnScreen(){if(!selected)return true;const p=sim.find(n=>n.id===selected.id);if(!p)return false;const sx=cv.clientWidth/2+cam.x+p.x*cam.k,sy=cv.clientHeight/2+cam.y+p.y*cam.k;const m=48;return sx>m&&sy>m&&sx<cv.clientWidth-m&&sy<cv.clientHeight-m;}
function syncRefocus(){const btn=document.getElementById("refocus");if(!selected){btn.hidden=true;return;}
  if(selected.id!==focusedId){btn.textContent="Refocus";btn.dataset.mode="rebuild";btn.hidden=false;}
  else if(!selectedOnScreen()){btn.textContent="Recentre";btn.dataset.mode="centre";btn.hidden=false;}else btn.hidden=true;}
function recenter(){if(!selected)return;const p=sim.find(n=>n.id===selected.id);if(!p)return;cam.x=-p.x*cam.k;cam.y=-p.y*cam.k;draw();syncRefocus();}
function refocus(){if(!selected)return;focusMode=true;focusedId=selected.id;fitAfterAnim=true;rebuild(false);fitView();render();syncRefocus();}
function fitView(){if(!sim.length)return;let minx=Infinity,maxx=-Infinity,miny=Infinity,maxy=-Infinity;for(const p of sim){const r=radius(p);minx=Math.min(minx,p.x-r);maxx=Math.max(maxx,p.x+r+96);miny=Math.min(miny,p.y-r-10);maxy=Math.max(maxy,p.y+r+10);}
  const pad=16,w=Math.max(cv.clientWidth-pad*2,1),h=Math.max(cv.clientHeight-pad*2,1),bw=Math.max(maxx-minx,1),bh=Math.max(maxy-miny,1);
  cam.k=Math.max(0.2,Math.min(6,Math.min(w/bw,h/bh)));cam.x=-((minx+maxx)/2)*cam.k;cam.y=-((miny+maxy)/2)*cam.k;draw();}
function zoomBy(f){cam.k=Math.min(8,Math.max(0.15,cam.k*f));draw();}
function resize(){const r=cv.getBoundingClientRect();cv.width=r.width*devicePixelRatio;cv.height=r.height*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);draw();}
cv.addEventListener("mousedown",ev=>{const n=hitNode(ev.offsetX,ev.offsetY);down={x:ev.offsetX,y:ev.offsetY,n,e:n?null:hitEdge(ev.offsetX,ev.offsetY)};});
cv.addEventListener("dblclick",ev=>{ev.preventDefault();const n=hitNode(ev.offsetX,ev.offsetY);if(n){selected=n;selectedEdge=null;tab="knowledge";tabFilter=null;markHot(n.id);refocus();}});
window.addEventListener("mousemove",ev=>{if(!down&&!dragging&&!lastPan)return;const rect=cv.getBoundingClientRect();const x=ev.clientX-rect.left,y=ev.clientY-rect.top;
  if(down&&!dragging&&!lastPan){if(Math.hypot(x-down.x,y-down.y)<5)return;if(down.n)dragging=down.n;else lastPan={x:down.x,y:down.y};down=null;}
  if(dragging){const p=screenToWorld(x,y);dragging.x=p.x;dragging.y=p.y;draw();}else if(lastPan){cam.x+=x-lastPan.x;cam.y+=y-lastPan.y;lastPan={x,y};draw();}});
window.addEventListener("mouseup",()=>{if(down){if(down.n){selected=down.n;selectedEdge=null;tab="knowledge";tabFilter=null;markHot(down.n.id);render();syncRefocus();draw();}else if(down.e){selectedEdge={from:down.e.from,to:down.e.to};render();draw();}}down=null;dragging=null;lastPan=null;});
cv.addEventListener("wheel",ev=>{ev.preventDefault();cam.k=Math.min(8,Math.max(0.15,cam.k*(ev.deltaY<0?1.08:1/1.08)));draw();},{passive:false});
document.getElementById("q").addEventListener("input",()=>{selectedEdge=null;const q=document.getElementById("q").value.trim().toLowerCase();
  const hit=(DATA.nodes||[]).find(n=>n.name.toLowerCase()===q||n.canonical_name===q)||(DATA.nodes||[]).find(n=>n.name.toLowerCase().includes(q)||n.canonical_name.includes(q));
  selected=hit||null;tabFilter=null;if(selected)markHot(selected.id);syncRefocus();if(selected&&!sim.some(p=>p.id===selected.id)){focusMode=true;rebuild(false);}else draw();render();});
document.getElementById("type").addEventListener("change",()=>{rebuild(false);render();});
document.getElementById("cap").addEventListener("input",()=>{document.getElementById("capLabel").textContent=String(document.getElementById("cap").value);});
document.getElementById("cap").addEventListener("change",()=>{rebuild(false);render();});
document.getElementById("refocus").addEventListener("click",ev=>{ev.stopPropagation();if(document.getElementById("refocus").dataset.mode==="centre")recenter();else refocus();});
document.getElementById("details").addEventListener("click",()=>{showDetails=!showDetails;try{localStorage.setItem("om-inspect-details",showDetails?"1":"0");}catch(e){}document.getElementById("details").classList.toggle("on",showDetails);render();});
document.getElementById("details").classList.toggle("on",showDetails);
function effectiveTheme(){const mode=document.documentElement.getAttribute("data-theme")||"system";if(mode==="light"||mode==="dark")return mode;return matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}
function syncThemeButton(){const light=effectiveTheme()==="light";document.getElementById("themeSun").hidden=light;document.getElementById("themeMoon").hidden=!light;}
function applyTheme(mode){document.documentElement.setAttribute("data-theme",mode==="light"||mode==="dark"?mode:"system");try{localStorage.setItem("om-inspect-theme",document.documentElement.getAttribute("data-theme"));}catch(e){}syncThemeButton();draw();}
let theme="system";try{theme=localStorage.getItem("om-inspect-theme")||"system";}catch(e){}applyTheme(theme);
document.getElementById("themeBtn").addEventListener("click",()=>{const osLight=matchMedia("(prefers-color-scheme: light)").matches;const next=effectiveTheme()==="light"?"dark":"light";applyTheme(next===(osLight?"light":"dark")?"system":next);});
document.getElementById("zoomIn").addEventListener("click",ev=>{ev.stopPropagation();zoomBy(1.2);});
document.getElementById("zoomOut").addEventListener("click",ev=>{ev.stopPropagation();zoomBy(1/1.2);});
document.getElementById("zoomFit").addEventListener("click",ev=>{ev.stopPropagation();fitView();});
function currentDock(){const c=[...document.getElementById("stage").classList].find(x=>x.startsWith("dock-"));return c?c.slice(5):"right";}
function closeDockMenu(){const menu=document.getElementById("dockMenu");menu.classList.remove("open");menu.hidden=true;}
function setDock(side){document.getElementById("stage").className="dock-"+side;document.getElementById("dockBtnIco").className="dock-ico "+side;closeDockMenu();resize();}
document.getElementById("dockBtn").addEventListener("click",ev=>{ev.stopPropagation();const menu=document.getElementById("dockMenu");const open=!menu.classList.contains("open");menu.classList.toggle("open",open);menu.hidden=!open;});
document.getElementById("dockMenu").addEventListener("click",ev=>{ev.stopPropagation();const b=ev.target.closest("[data-dock]");if(!b||b.classList.contains("is-current"))return;setDock(b.getAttribute("data-dock"));});
document.addEventListener("click",()=>closeDockMenu());
document.addEventListener("keydown",ev=>{if(ev.key==="Escape"){if(tabFilter){tabFilter=null;render();ev.preventDefault();}closeDockMenu();}});
let splitDrag=null;document.getElementById("splitter").addEventListener("mousedown",ev=>{ev.preventDefault();ev.stopPropagation();splitDrag={dock:currentDock(),rect:document.getElementById("stage").getBoundingClientRect()};});
window.addEventListener("mousemove",ev=>{if(!splitDrag)return;const {dock,rect}=splitDrag;let size=dock==="right"?rect.right-ev.clientX:dock==="left"?ev.clientX-rect.left:dock==="bottom"?rect.bottom-ev.clientY:ev.clientY-rect.top;
  const max=(dock==="left"||dock==="right")?rect.width*0.7:rect.height*0.7;size=Math.max(220,Math.min(max,size));document.getElementById("stage").style.setProperty("--panel",size+"px");resize();});
window.addEventListener("mouseup",()=>{splitDrag=null;});
document.getElementById("reset").addEventListener("click",()=>{document.getElementById("q").value="";document.getElementById("type").value="";document.getElementById("cap").value="50";document.getElementById("capLabel").textContent="50";
  selected=null;selectedEdge=null;focusMode=false;focusedId=null;tab="knowledge";tabFilter=null;hotSet=null;sim=[];rebuild(true);render();});
window.addEventListener("resize",resize);rebuild(true);render();resize();
</script>
</body>
</html>`;
}

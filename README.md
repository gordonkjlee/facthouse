# OpenMemory

Local-first AI memory engine exposed as an MCP server. GitHub [`gordonkjlee/openmemory`](https://github.com/gordonkjlee/openmemory), npm [`@openmem/mcp`](https://www.npmjs.com/package/@openmem/mcp). Structured knowledge with server-side intelligence — domain routing, entity extraction, deduplication, and supersession. Any AI tool can query it. You own the SQLite file.

This is not Mem0's hosted "OpenMemory MCP" at [`mcp.mem0.ai`](https://mcp.mem0.ai). Same name, different product: this one is local SQLite, not a hosted memory plane.

## The Problem

AI agents can store knowledge, but existing approaches limit how effectively it can be structured and retrieved. Built-in memories like ChatGPT and Claude store flat text with no schema or relationships — and are not portable across tools. Developer libraries offer memory primitives but require significant integration work. Knowledge graph engines provide rich entity extraction at the cost of multiple LLM calls per ingestion and operational overhead. Lightweight solutions achieve cross-tool sharing but without structure, confidence scoring, or deduplication.

The common gap: structured, schema-driven knowledge with effective retrieval, working across any AI tool, without significant infrastructure cost.

## The Solution

One place that accumulates structured knowledge - validated, owned by you - and every AI tool can query it. Works for personal identity, team knowledge, project context, or any use case where AI needs persistent memory.

## Quick Start

Add to your AI tool's MCP configuration:

<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.19.0"]
    }
  }
}
```
<!-- x-release-please-end -->

Works with Claude Code, Claude Desktop, and any MCP-compatible tool. Cursor consumes tools but not resources until a later adapter exists — `search_knowledge` and `get_entity` still work there. Data is stored at `~/.openmemory` by default. To change this, add `"env": { "OPENMEMORY_DATA": "/absolute/path" }` to the config above. One directory is one memory: a work brain and a personal brain are two directories, two `OPENMEMORY_DATA` values, and two MCP server names (two entries both called `openmemory` overwrite each other).

### Claude Code — first session (throwaway store)

One path. Pick the pull mechanism. Do this from the CLI against a **throwaway** data directory. Do **not** install capture hooks yet: a Stop hook that runs pull on a large home will hang the session, and `npx -y @openmem/mcp` with no `-p` / `openmemory` starts the MCP **server** and hangs a hook. The first backfill is a CLI command.

<!-- x-release-please-start-version -->
Git Bash / macOS / Linux:

```bash
export OPENMEMORY_DATA=/tmp/openmemory-try
om() { npx -y -p @openmem/mcp@0.19.0 openmemory "$@"; }
om init
```

PowerShell:

```powershell
$env:OPENMEMORY_DATA = Join-Path $env:TEMP "openmemory-try"
function om { npx -y -p "@openmem/mcp@0.19.0" openmemory @args }
om init
```
<!-- x-release-please-end -->

`init` writes `config.json` with `"sources": []` (pull off) and prints that. Add **one** source. `home` is the client config dir (`~/.claude` for Claude Code, `~/.cursor` for Cursor — those variables are examples of the path, not extra discovery). Set `cwd` to this project; a bare `home` walks every project group:

```json
{
  "sources": [
    {
      "kind": "claude-code",
      "home": "~/.claude",
      "cwd": "C:\\dev\\app"
    }
  ]
}
```

Cursor Agent JSONL is the same knob with a different `kind`. It reads `home/projects/*/agent-transcripts/**/*.jsonl` only — not Composer SQLite, not `state.vscdb`. Cursor encodes `C:\\dev\\app` as `c-dev-app` (Claude Code uses `C--dev-app`); some Cursor folders are opaque numeric ids and are only ingested when `cwd` is omitted or set to that id.

```json
{
  "sources": [
    {
      "kind": "cursor",
      "home": "~/.cursor",
      "cwd": "C:\\dev\\app"
    }
  ]
}
```

Always set `cwd`. Pull copies this project's transcripts into the raw log. A bare `home` (`~/.claude` or `~/.cursor` with no `cwd`) walks every project group — a first pull can be thousands of files, and a personal store that shares a Claude home with work will ingest both.

Then:

```bash
om pull
om consolidate
om search "<a word you already said to Claude Code in this project>"
```

That search is the proof: a fact you did not re-type. `om pull` ticks a running MCP server after a small insert (≤50 events). A first pull of more than 50 events does **not** auto-consolidate — run `om consolidate`. If no server is listening, pull says the same.

Point the MCP snippet above at the same throwaway directory (`"env": { "OPENMEMORY_DATA": "…" }`). Empty `sources` means pull stays off.

**Hooks later, and only after that first CLI pull.** Incremental `pull` is small; the first one is not. The command must invoke the CLI (`openmemory`), never the server binary.

`mcp.json` `env` is **not** visible to hooks. One data dir is one memory — pass the same `--data` (or export `OPENMEMORY_DATA` in the environment Claude Code itself inherits, not only in MCP config):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p @openmem/mcp openmemory pull --data /absolute/path/to/the-same-store"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p @openmem/mcp openmemory signal flush --data /absolute/path/to/the-same-store"
          }
        ]
      }
    ]
  }
}
```

On Windows the `--data` path is the same absolute directory you put in `OPENMEMORY_DATA` (for example `C:\\Users\\alex\\AppData\\Local\\Temp\\openmemory-try`). Stop tails new lines (pull then ticks the server to extract facts when the threshold is due). PreCompact `signal flush` graduates those pending facts into long-term knowledge without re-reading the transcript, so compaction is not held for a full extract. It does not insert `session_events`. Never install `log-event` hooks on a store that pulls: both write the same rows. A global `npm install -g @openmem/mcp` lets you write `openmemory pull --data …` instead of npx.

**Alternative, no pull:** leave `sources` empty and pipe UserPromptSubmit / Stop / PostToolUse into `openmemory log-event`. See Session Event Logging. Do not run both mechanisms on the same store.

### Two memories (work and personal)

One data directory is one brain. Life and work are two directories — not a filter on which client wrote the row, not a tenant column inside one SQLite file. Each store has its own `config.json`, its own pull sources, its own hooks (`--data` must match), and its own scheduler socket. They cannot see each other's facts.

A non-default data directory prints a distinct MCP server name so two stores can share one `mcp.json`. `openmemory init` against each directory prints that snippet:

<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "openmemory-personal": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.19.0"],
      "env": { "OPENMEMORY_DATA": "C:\\Users\\alex\\.openmemory-personal" }
    },
    "openmemory-work": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.19.0"],
      "env": { "OPENMEMORY_DATA": "C:\\Users\\alex\\.openmemory-work" }
    }
  }
}
```
<!-- x-release-please-end -->

Point each store's `sources.cwd` (or hook `--data`) at that store only. A bare `home` on the personal brain that walks every Claude Code project group will ingest work transcripts into the personal file — two directories do not help if both pull the same home.

### What you need for the intelligence

Storage works with nothing but Node. The *intelligence* — entity extraction, domain routing, contradiction detection — needs a language model, and by default OpenMemory gets one by shelling out to the [Claude Code CLI](https://github.com/anthropics/claude-code). That runs on your existing Claude subscription, so there is no API key to configure and no per-call billing.

Without it, consolidation falls back to a built-in heuristic. Be clear about what that means: the fallback **does not extract facts from transcripts**. `capture_fact` still stores facts, but with no entities and no domain routing, so you get a flat list rather than a knowledge graph. That is a deliberate design choice — the engine ships no vocabulary of its own, and a keyword classifier with no keywords cannot honestly route anything. PreCompact `signal flush` skips extract even when the server is up (extract already ran on pull/Stop). With no MCP server it uses the heuristic fallback on purpose (it must not spawn `claude -p` during compaction) and will not invent facts from unread events.

Run `npx -y -p @openmem/mcp openmemory init` and it tells you which of the two you have:

```
Consolidation intelligence: the claude CLI (no API key needed) — found and
working. Set OPENMEMORY_PROVIDER=heuristic to turn the subprocess off.
```

To choose the fallback deliberately and silence the check, set `OPENMEMORY_PROVIDER=heuristic`.

## See It Work in Five Minutes

No MCP client needed — this runs entirely on the command line against a throwaway store, so you can watch what the server does to a conversation before you point a real tool at it. These three lines are typed in; to search something you already said to Claude Code, use the pull recipe above instead.

Git Bash / macOS / Linux:

```bash
export OPENMEMORY_DATA=/tmp/openmemory-demo
om() { npx -y -p @openmem/mcp openmemory "$@"; }   # a function, so it works pasted into a script too

om init

# Three things someone might say in passing, in three different conversations.
om log-event --role user --content "I prefer dark mode in every editor, and I never want telemetry enabled."
om log-event --role user --content "I am allergic to shellfish, so avoid seafood restaurants when booking anything."
om log-event --role user --content "My colleague Robin at Acme is leading the Atlas migration project this quarter."

om consolidate
```

PowerShell:

```powershell
$env:OPENMEMORY_DATA = Join-Path $env:TEMP "openmemory-demo"
function om { npx -y -p "@openmem/mcp" openmemory @args }
om init
om log-event --role user --content "I prefer dark mode in every editor, and I never want telemetry enabled."
om log-event --role user --content "I am allergic to shellfish, so avoid seafood restaurants when booking anything."
om log-event --role user --content "My colleague Robin at Acme is leading the Atlas migration project this quarter."
om consolidate
```

Consolidation is where the server earns its keep. It reads the raw conversation, decides what is worth keeping, and returns something like this — a language model does the reading, so the counts, the wording and the labels all vary between runs:

```json
{"factsIn":4,"factsGraduated":4,"factsRejected":0,"entitiesCreated":3,"entitiesLinked":3,"supersessions":0,
 "summary":"The user works at Acme where Robin is leading the Atlas migration project this quarter. They have clear preferences for their development environment: dark mode across all editors and no telemetry enabled. They have a shellfish allergy and should avoid seafood restaurants when making reservations or attending meals."}
```

Three sentences became four facts and three entities — though not always four. Across runs of this exact demo the model has produced three or four, depending on whether it reads "dark mode, and no telemetry" as one preference or two. Where one fact ends and the next begins is a judgement, so treat the counts here as typical rather than guaranteed.

Now ask it things:

```bash
om search "Atlas"
```

```
1 result for "Atlas"

  Robin, a colleague at Acme, is leading the Atlas migration project this quarter.
    work  ·  score 0.043  ·  confidence 1.00  ·  entities: Acme, Atlas, Robin

  coverage 70%  ·  confidence 70%
```

Nobody said "Atlas is a project" or "Acme is an organisation". The server worked that out, gave each one a type, and linked all three to the fact — which is why asking about the project finds the person, and vice versa.

```bash
om stats
```

```
OpenMemory statistics

  Facts           4 current
  Entities        3
  Domains         3
  Consolidations  1

  By domain
    preferences  2
    work         1
    allergies    1
```

`allergies` is not a domain OpenMemory ships. The engine has no built-in vocabulary at all — it read the conversation and decided that fact needed a home of its own. Run the demo again and it may well file the same fact under `health` instead, which is exactly why a domain **biases ranking rather than filtering** everywhere it is used: a label a classifier guesses is a useful hint and a terrible gate. A corporate store grows `incident` and `supplier` the same way, without configuration.

**What this demo does not show:** the demo store searches by keyword, so it matches words rather than meanings — `search "shellfish"` finds the allergy, `search "food"` does not. Semantic search over embeddings now exists and fixes exactly that, but it is off unless you turn it on, because switching it on means choosing an embedding model and a model is an opinion about what "similar" means. Set `embedding.provider` in `config.json` to `"ollama"` (local, no API key) or `"voyage"` (hosted), run `openmemory consolidate`, and `search "food"` starts returning the allergy. Facts are embedded when they are consolidated, so an existing store fills in on its next run rather than needing a rebuild.

One thing to know if you use a model OpenMemory has not measured: cosine similarity has no natural zero, so a query your store cannot answer still scores every fact in it — searching a personal store for `"quantum physics"` will happily return your four most vaguely-related facts unless something says where noise begins. That number is a property of the embedding model, so it ships with the model rather than as a global constant. `nomic-embed-text` and the `voyage-4` family have both been measured and carry their own; models nobody has measured get no floor rather than a guessed one. If yours is one of them, embed a query your store genuinely cannot answer, read the top score, and put it in `embedding.min_similarity`.

If you use Voyage, note that it applies a **3 requests/minute** rate limit until a payment method is on the account. The 200M free tokens still apply once one is added, so this is a signup step rather than a cost — but without it, embedding a large existing store will make slow progress, a batch at a time, across several consolidation runs.

Clean up with `rm -rf /tmp/openmemory-demo`, then point a real client at the config in Quick Start and the same thing happens in the background as you work.

### The part that matters: it is the same store from every tool

Put the Quick Start config in a second AI tool and give it no rules at all. It reads `memory://profile` on connect and can `search_knowledge` for the rest — so a preference you mentioned once, in a different application, is simply known. There is nothing to sync and nothing to export: both clients are talking to one SQLite file that you own.

That file is the whole store. `session_events` is what was said, `session_facts` is what was just extracted, and `facts` is graduated knowledge — three tables in one file, not three databases. FTS5 (words) and optional embeddings (meaning) are indexes of `facts`. They are not a second brain. `storage.provider` is `"sqlite"`; asking for `"postgres"` (or setting `OPENMEMORY_STORAGE`) is refused rather than silently opening SQLite — keyword search is FTS5 and the server is synchronous, so a second engine is a port, not a URL.

The server side of this is covered by tests that spawn the real binary twice against a single store: a fact captured through one connection is searchable from the other, concurrent writes survive, and two simultaneous consolidations neither duplicate work nor strand it. What those tests cannot cover is any particular pair of desktop applications and their own config quirks — so if a specific combination misbehaves, please open an issue.

## How It Works

For Claude Code, the D-layer is **pull**. You name a source; transcripts land in `session_events`; consolidation graduates facts from those events. The model does not have to call `capture_fact` for a conversation to be remembered.

1. **Pull** — A named `sources` entry (`kind: "claude-code"` or `"cursor"`, `home`, and `cwd` — set it) is tailed into `session_events` by `openmemory pull` from the CLI (first backfill) or by the MCP server at session start. Empty `sources` means pull is off. A Stop hook may pull later, once that first backfill has run. When a transcript line carries a timestamp, that is stored as when the turn was said, separately from when OpenMemory ingested it. A line without one stays empty rather than copying ingest time — Cursor Agent JSONL has no clock, so those turns stay empty on this field. Hook `log-event` and MCP `log_event` stamp when they ran — those fire at the turn. Extract resolves "yesterday" against that utterance time into the sentence; it does not invent a calendar day for "about five years ago" or "when I was younger".

2. **Batch consolidation** — Two speeds. Pull and Stop **extract** self-contained facts from new transcript lines when the threshold is due. PreCompact **flush** (and shutdown) **graduates** those pending facts: classifying domains, extracting and typing entities (people, organisations, projects, places — whatever the conversation is about), detecting duplicates and contradictions, and building a knowledge graph. `openmemory consolidate` and the MCP `consolidate` tool still run both steps.

3. **Optional correction** — `capture_fact` remains available when the assistant should store a judgement that is not in the transcript, or a fact extraction missed. It is a correction, not the Claude Code capture path.

Other MCP clients that have no pull adapter yet still use `log_event` / `openmemory log-event` or `capture_fact`. Query is already any tool; capture is Claude Code JSONL and Cursor Agent JSONL. Grok and Codex are later adapters. Cursor Composer SQLite is not this adapter.

The result is a structured, evolving knowledge graph that any AI tool can query via MCP.

## Features

- **Pull, then consolidate** — Claude Code and Cursor Agent JSONL conversations are pulled from a named source into `session_events`. Extract runs on pull/Stop; graduate runs on PreCompact flush (or on a manual `consolidate`). `capture_fact` is an optional correction, not how those conversations get in.
- **Batch consolidation** — Periodic processing integrates pending captures into the long-term knowledge graph: classifies domains, extracts entities, resolves duplicates, detects contradictions.
- **Entity graph** — Whatever the conversation is about — people, organisations, projects, places, products — extracted, typed and linked automatically. Relationship strength tracks corroboration.
- **Hybrid search** — BM25 keyword + structured domain + entity-graph paths, merged via Reciprocal Rank Fusion with temporal decay. Add an embedding provider and semantic similarity joins the merge as a fourth path: it ranks, it does not gate, so a fact with no embedding is still found by its words. When no graduated fact matches, a short raw-log window around a keyword hit is returned separately as `episodes` — not knowledge, not mixed into `results`.
- **In-session memory** — `get_session_context` returns the working briefing (same markdown as `memory://briefing`) plus facts captured this session, even before consolidation. Tools-only clients are told to call it at session start.
- **Immutable history** — Facts are never deleted, only superseded. The default records when a fact was learned and when it was true. Set `temporal.mode` to `bitemporal` to also record when the system retracted a belief, so search can answer what the store believed at an instant.
- **Source traceability** — Every fact links back to the conversation events that produced it.
- **Manual consolidation** — Call `consolidate` at natural breakpoints (topic change, task completion, pre-compaction). No reliance on session boundaries.
- **One directory, one brain** — Work and personal are two `OPENMEMORY_DATA` directories and two MCP server names. Isolation is the directory, not a column. One SQLite file in that directory holds D, I, and K as tables; FTS5 and embeddings are indexes of K.

## MCP Resources

Resources are context the client loads **automatically** — no tool call, no decision by the AI. Tools only help if the assistant remembers to reach for them; resources are simply present.

- `memory://briefing` — Everything worth knowing right now: profile, what was learned in the last consolidation, open threads, and recent knowledge. Markdown, kept to roughly a screenful.
- `memory://profile` — Core identity facts, most important first.

Both are read-only views over the same database the tools query, so they can't drift from it. They're regenerated on read, and clients that subscribe are notified when a consolidation changes what they'd say. Clients that never load resources (Cursor, Windsurf, Grok) get the same briefing by calling `get_session_context` at the start of a conversation — the server's initialize instructions and that tool's description both say so. No second profile schema.

## MCP Tools

### Session
- `log_event` — Log conversation events (messages, artifacts).
- `get_events` — Retrieve events from current or previous session.
- `get_session_context` — Working briefing (the same markdown as `memory://briefing`) plus facts captured in this session. Call at the start of every conversation if the client does not load resources.

### Reading
- `get_entity` — Everything known about any named subject — person, organisation, project, place, product — and how it connects. If there is no entity by that exact name, facts that mention the wording still come back rather than an empty miss.
- `get_context` — Everything relevant to a topic (search + entity traversal)
- `search_knowledge` — Hybrid search across graduated knowledge

### Writing
- `capture_fact` — Store a fact. On a pull store this is a correction for something extraction missed; on a store with empty `sources` it is how facts get in. The description the assistant sees is generated from that same rule. Fast append with session tagging; full intelligence deferred to consolidation.
- `consolidate` — Integrate pending facts into long-term knowledge. Extracts entities, resolves duplicates, detects contradictions, builds the knowledge graph. Call at natural breakpoints or before context compaction.
- Inference tools — Opt-in, off by default (`inferences.enabled` in config.json). A hypothesis cites existing fact ids and stays pending until confirmed; confirmation graduates a labelled inference fact. Those tools are not registered until you turn the gate on. Consolidate never invents a sentence nobody said.

### Meta
- `get_schemas` — Available domains and structure
- `get_stats` — Fact count, entity count, domain distribution

## Session Event Logging

OpenMemory captures every interaction as a `SessionEvent` — the DIKW Data layer. This is the episodic ground truth that consolidation, search, and recall all build on.

### How events are captured

Choose one mechanism.

**Recommended — pull.** Name a `claude-code` or `cursor` source (set `cwd`; a bare `home` walks every project group) and run `openmemory pull` from the CLI first. Do not hang a first backfill on a Stop hook. After that, optional Stop / PreCompact hooks (npx or a global install — a bare `openmemory` is not on PATH after `npx`). The MCP server also pulls once at session start. Cursor pull is the Agent JSONL export only: user and assistant text plus tool *calls*, not tool *results*, not Composer `store.db`, not `state.vscdb`. Grok and Codex are later adapters. Unknown `kind` values are rejected with a clear error.

```bash
openmemory pull
# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

A second run against unchanged files inserts nothing — progress is a durable per-file watermark. A first pull that inserts more than 50 events does not auto-consolidate at session start (run `openmemory consolidate` when ready).

**Alternative — `log-event` hooks, no sources.** Leave `sources` empty. Pipe UserPromptSubmit / Stop / PostToolUse into `openmemory log-event` — the Quick Start alternative block is the recipe. MCP `log_event` / `capture_fact` keep working.

**Hard rule:** do not run `log-event` hooks and pull on the same store. OpenMemory does not detect or rewrite existing hook configs.

PreCompact `openmemory signal flush` graduates pending facts; it does not re-read the transcript and does not insert `session_events`. It is part of the recommended recipe.

### CLI Reference

#### `openmemory init [dir]`

Optional — the server creates its data directory and database on first run anyway. Use `init` to set things up ahead of time and, more usefully, to write a `config.json` you can tune (without it, the defaults are invisible):

```bash
# Initialise the default location (~/.openmemory):
openmemory init

# Or a specific directory:
openmemory init ~/my-memory

# Options:
#   --data     Data directory (alternative to the positional argument)
#   --force    Overwrite an existing config.json with defaults
```

It creates the data directory, applies the database schema, writes `config.json` with the shipped defaults, and prints a ready-to-paste MCP config block. Re-running is safe: an existing `config.json` is left untouched unless you pass `--force`, and your data is preserved.

The generated `config.json` is where you change consolidation behaviour — most notably `intelligence.provider`, which selects how facts are extracted (`cli` by default, which runs the `claude` CLI; set it to `heuristic` for a zero-dependency regex fallback, or override at runtime with `OPENMEMORY_PROVIDER=heuristic`).

#### `openmemory log-event`

Inserts events directly into the database (no running server needed). Supported for demos and for stores that have no named source. Not the Claude Code or Cursor default — that is `sources` plus `openmemory pull`.

```bash
# From a hook (reads JSON payload from stdin):
echo '{"hook_event_name":"UserPromptSubmit","prompt":"hello"}' | openmemory log-event --role user

# With explicit content:
openmemory log-event --role user --event-type message --content "hello world"

# Options:
#   --role          user | assistant | system | tool (default: user)
#   --event-type    message | tool_call | tool_result | artifact (default: message)
#   --content-type  text | json | image | audio | binary (default: text)
#   --content       Event content (or pipe via stdin)
#   --speaker       Named participant when the transcript has one
#   --session-id    Target session (default: most recent)
#   --data          Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

#### `openmemory pull`

Ingest new session events from `config.sources`. This is the primary entry for client-agnostic capture — empty `sources` is a successful no-op:

```bash
openmemory pull

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

It walks each named source, tails JSONL transcripts that are new since the last watermark, and inserts them into `session_events`. Prints a JSON summary. Unknown source kinds exit non-zero with an error rather than being skipped silently. Set `cwd` on the source unless you intend to ingest every project group. Do not also run `log-event` hooks on this store.

#### `openmemory consolidate`

Run consolidation in-process — the same batch pass the `consolidate` tool triggers, without a running server. Useful for a cron job, a post-session hook, or seeing what consolidation does to a store you can inspect afterwards:

```bash
openmemory consolidate

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

It honours the configured provider, so by default this is the real LLM path (`claude -p`). It prints the consolidation result as JSON — facts graduated, entities extracted, duplicates and contradictions resolved.

#### `openmemory signal [tick|flush]`

Wake a *running* MCP server over its IPC socket, rather than consolidating in this process:

```bash
openmemory signal tick    # extract if the event threshold is due — pull / Stop
openmemory signal flush   # graduate pending facts — for PreCompact hooks

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

`flush` is the one that matters: it is what a PreCompact hook calls so pending facts survive a context collapse. That hook graduates staged facts; it does not re-read transcripts, does not insert `session_events`, and does not duplicate a `claude-code` pull. If no server is listening, `flush` falls back to an in-process **heuristic** graduate — deliberately, because a compaction is time-critical and spawning `claude -p` could take 35–50 seconds. Lower quality, but the data survives and can be reprocessed later. A `tick` that finds no server simply exits; the next `session_start` recovers it.

#### `openmemory search <query>`

Search the knowledge base from the command line. This runs the same hybrid search the `search_knowledge` tool runs, so it answers "what does it actually know?" — and "why did the AI say that?" — without wiring up a client:

```bash
openmemory search "coffee"

# Prioritise a domain:
openmemory search "coffee" --domain preferences

# Machine-readable output for scripting:
openmemory search "coffee" --json

# Options:
#   --domain   Prioritise a domain (profile, preferences, medical, people, work,
#              or any other in use). Biases ranking; does not filter — see below
#   --limit    Maximum results (default: 20)
#   --json     Emit the raw search payload instead of formatted text
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

Results carry a relevance score and confidence, plus coverage and confidence estimates for the result set as a whole — so a thin result set looks thin rather than silently passing as complete.

`--domain` **biases ranking rather than filtering.** Facts in the domain are surfaced and rank higher, and a fact that both matches your query and sits in that domain ranks top — but a strong match in another domain still appears below it. This is deliberate: domains are assigned by a classifier and are approximate, so a fact you are looking for may be filed under a near-synonym. A hard filter would hide it and show you an empty result, with no way to tell "nothing is known" from "it was filed elsewhere". Ranking degrades where a filter fails absolutely.

#### `openmemory stats`

Show what the knowledge base holds — fact counts, entities, domains, and how facts are distributed across domains:

```bash
openmemory stats
openmemory stats --json

# Options:
#   --json     Emit the raw statistics payload instead of formatted text
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

Facts are immutable — superseded facts are kept, never deleted — so the current count and the total legitimately differ once anything has been superseded. Both are reported.

## Integration Patterns

OpenMemory's tool descriptions tell assistants when to search and when a correction is worth staging. They are not how Claude Code conversations enter the store — that is pull from a named source. For deeper integration, clients can add **rules** (instructions loaded into context) at key moments. These are optional.

### Without Configuration

Claude Code or Cursor: name a `sources` entry (set `cwd`) and pull from the CLI first. MCP session start also pulls. The `search_knowledge` description still says to search before answering questions that might benefit from what this store knows. `capture_fact` is there if the assistant needs to correct or add something pull-plus-extraction will not produce.

Clients with no pull adapter still rely on `log_event` / `capture_fact` until their adapter exists.

### Hook Points

| Hook Point | When | What to Call | Why It Matters |
|---|---|---|---|
| Session start | Conversation begins | `memory://profile` (automatic), `search_knowledge` | AI knows who you are from message one |
| Correction | A durable fact is missing from the store | `capture_fact` | Optional; Claude Code conversations are already in `session_events` via pull |
| Pre-response search | Before generating a reply | `search_knowledge`, `get_context` | Responses informed by stored knowledge |
| Pre-compaction | Before context window compression | `consolidate` or `openmemory signal flush` | Graduates pending facts before context is wiped — does not re-read the transcript or insert events |
| Natural breakpoints | Topic change, task completion | `consolidate` (optional) | Keeps knowledge graph current |

**On pre-compaction:** This is the highest-value consolidation hook — without it, staged facts are silently lost when the client compresses context. `openmemory signal flush` graduates what extract already wrote; it does not re-read the transcript. The `consolidate` tool still runs extract then graduate. It is not a `log-event` hook and does not duplicate `session_events`.

### Claude Code

Create `.claude/rules/openmemory.md` in your project (or `~/.claude/rules/openmemory.md` globally). This loads automatically into context:

```markdown
# OpenMemory

- Conversations are pulled from the named Claude Code source (first backfill: `openmemory pull` on the CLI)
- Do not install log-event hooks on this store
- Identity context loads automatically from the `memory://profile` resource — no tool call needed
- Before answering questions this store might already know, call `search_knowledge`
- Call `capture_fact` only to correct or add something that is not in the transcript
- When the conversation is getting long, call `consolidate` (or rely on PreCompact `openmemory signal flush`)
- At natural breakpoints (topic change, task completion), call `consolidate` to keep the knowledge graph current
```

To allow OpenMemory tools without per-call approval prompts, add to the `permissions.allow` array in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__openmemory__*"
    ]
  }
}
```

### Cursor / Windsurf

Add to `.cursorrules` (Cursor) or `.windsurfrules` (Windsurf) in your project root:

```
When the openmemory MCP server is available:
- Before answering questions this store might already know, call search_knowledge
- To find out everything known about a particular person, project, or thing, call get_entity
- Call capture_fact only to correct or add something pull or extraction missed
- When context is getting long, call consolidate to process pending facts before they are lost
```

Cursor and Windsurf consume tools but not resources, so `memory://profile` will not load on its own there — `search_knowledge` and `get_entity` cover the same ground on demand. Cursor conversations themselves are pulled with `kind: "cursor"` (JSONL under `~/.cursor/projects/`, not the SQLite composer store).

### Claude Desktop / Other MCP Clients

No pull adapter yet. Tool descriptions handle search and optional `capture_fact`; conversations are not tailed until a later adapter exists.

## Reclaiming space

OpenMemory logs raw conversation and tool output to `session_events` — the data layer that extraction reads facts out of. On a store wired into an agentic client this becomes almost all of the database, because tool output is logged wholesale and dwarfs anything a person actually says. A store measured in daily use held 47,000 events and 493 MB against 21 graduated facts.

`openmemory stats` reports the raw layer alongside the knowledge. To reclaim it:

```bash
openmemory prune                    # report only — nothing is deleted
openmemory prune --apply --vacuum   # delete, then rebuild the file
```

If most of that volume is tool output you judge to be noise rather than knowledge, you can stop it reaching the extractor at all — `extraction.event_types` and `extraction.roles` restrict what is examined, and `extraction.min_content_length` skips trivial events. Measure before you do. In one store wired into an agentic client, the facts that had been extracted originated about evenly between conversation and tool output — 10 and 8 respectively — so excluding tool results would have cost roughly half the knowledge, even though they accounted for 99% of the bytes. Volume and value are not the same axis, and only your own store can tell you the ratio.

**The rule is reachability, not age.** An event is removed only when all three hold:

1. Extraction has already read it. Anything ahead of the consolidation watermark is still input.
2. No fact's provenance cites it. A cited event is the answer to "why does it believe this?", so it stays however old it gets.
3. It has fallen outside its own session's most recent `extraction.working_memory_size` events — a spare so consolidation can still glance at recent raw notes. That window is evidence of the current topic, not a pronoun dictionary.

No fact, entity, embedding or search result is affected — only raw events that nothing can reach. Deleting rows does not shrink the file on its own, which is what `--vacuum` is for; it rewrites the whole database and needs comparable free disk space.

Nothing prunes automatically. Deletion is irreversible, and a memory product that quietly discards your data on a timer is not one worth running.

## Development

```bash
git clone https://github.com/gordonkjlee/openmemory
cd openmemory
npm install
npm run build
npm test
```

`npm test` always runs hermetic pipelines (fixture JSONL → pull → extract →
search) with a recording extractor, and skips live evals that need a real
model:

- Semantic recall needs Ollama with `nomic-embed-text`. Start it, then
  `npm run test:semantic`.
- The live first-fact eval needs the `claude` CLI, the same path as Quick
  Start. Run `npm run test:first-fact`.
- The live coding-store eval (warehouse-shaped Cursor transcripts) also
  needs the `claude` CLI. Run `npm run test:coding-store`.

Each of those scripts fails rather than skips when its dependency is missing,
so a green run means the claim was actually verified rather than quietly
stepped over.

## License

MIT

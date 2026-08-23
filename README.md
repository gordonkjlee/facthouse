# OpenMemory

AI memory engine exposed as an MCP server. Structured knowledge with server-side intelligence - domain routing, entity extraction, deduplication, and supersession. Any AI tool can query it. You own the data.

## The Problem

AI agents can store knowledge, but existing approaches limit how effectively it can be structured and retrieved. Built-in memories like ChatGPT and Claude store flat text with no schema or relationships — and are not portable across tools. Developer libraries offer memory primitives but require significant integration work. Knowledge graph engines provide rich entity extraction at the cost of multiple LLM calls per ingestion and operational overhead. Lightweight solutions achieve cross-tool sharing but without structure, confidence scoring, or deduplication.

The common gap: structured, schema-driven knowledge with effective retrieval, working across any AI tool, without significant infrastructure cost.

## The Solution

One place that accumulates structured knowledge - validated, owned by you - and every AI tool can query it with granular permissions. Works for personal identity, team knowledge, project context, or any use case where AI needs persistent memory.

## Quick Start

Add to your AI tool's MCP configuration:

<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.14.1"]
    }
  }
}
```
<!-- x-release-please-end -->

Works with Claude Code, Claude Desktop, Cursor, and any MCP-compatible tool. Data is stored at `~/.openmemory` by default. To change this, add `"env": { "OPENMEMORY_DATA": "/absolute/path" }` to the config above.

### Claude Code

Two capture mechanisms. Choose one.

**Recommended:** name a source and pull. After `openmemory init`, put this in that store's `config.json`. Set `cwd` — a bare `home` walks every project group and a first pull can ingest years of transcripts:

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

`home` is the Claude Code config dir (`CLAUDE_CONFIG_DIR` is an example of that path, not extra discovery). Then add Claude Code hooks that **only** pull and consolidate — never `log-event`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openmemory pull"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openmemory signal flush"
          }
        ]
      }
    ]
  }
}
```

Stop tails new transcript lines. PreCompact consolidates; it does not insert `session_events`. The MCP server also pulls once at session start. Empty `sources` means pull is off.

**Alternative:** leave `sources` empty (the default — pull is off) and use `log-event` hooks. Do not add a `sources` entry on this store:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openmemory log-event --role user --event-type message"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openmemory log-event --role assistant --event-type message"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(?!mcp__openmemory__)",
        "hooks": [
          {
            "type": "command",
            "command": "openmemory log-event --role tool --event-type tool_result"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openmemory signal flush"
          }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` / `Stop` / `PostToolUse` write `session_events`. PreCompact still consolidates; it does not insert events and is safe with either mechanism. Install the CLI (`npm install -g @openmem/mcp`) or replace `openmemory` with `npx -y @openmem/mcp` in the commands above.

**Hard rule:** do not run `log-event` hooks and pull on the same store. Both write the same conversation into `session_events`.

> **Disable your client's built-in memory.** OpenMemory replaces it — running both fragments your knowledge across two systems. In Claude Desktop: Settings → Memory → off. In ChatGPT: Settings → Personalisation → Memory → off. This ensures OpenMemory is the single source of truth.

### What you need for the intelligence

Storage works with nothing but Node. The *intelligence* — entity extraction, domain routing, contradiction detection — needs a language model, and by default OpenMemory gets one by shelling out to the [Claude Code CLI](https://github.com/anthropics/claude-code). That runs on your existing Claude subscription, so there is no API key to configure and no per-call billing.

Without it, consolidation falls back to a built-in heuristic. Be clear about what that means: the fallback **stores facts but extracts no entities and does no domain routing**, so you get a flat list rather than a knowledge graph. That is a deliberate design choice — the engine ships no vocabulary of its own, and a keyword classifier with no keywords cannot honestly route anything.

Run `npx -y -p @openmem/mcp openmemory init` and it tells you which of the two you have:

```
Consolidation intelligence: the claude CLI (no API key needed) — found and
working. Set OPENMEMORY_PROVIDER=heuristic to turn the subprocess off.
```

To choose the fallback deliberately and silence the check, set `OPENMEMORY_PROVIDER=heuristic`.

## See It Work in Five Minutes

No MCP client needed — this runs entirely on the command line against a throwaway store, so you can watch what the server does to a conversation before you point a real tool at it.

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

The server side of this is covered by tests that spawn the real binary twice against a single store: a fact captured through one connection is searchable from the other, concurrent writes survive, and two simultaneous consolidations neither duplicate work nor strand it. What those tests cannot cover is any particular pair of desktop applications and their own config quirks — so if a specific combination misbehaves, please open an issue.

## How It Works

For Claude Code, the D-layer is **pull**. You name a source; transcripts land in `session_events`; consolidation graduates facts from those events. The model does not have to call `capture_fact` for a conversation to be remembered.

1. **Pull** — A named `sources` entry (`kind: "claude-code"`, `home`, and `cwd` — set it) is tailed into `session_events` by `openmemory pull` (Stop hook or CLI) or by the MCP server at session start. Empty `sources` means pull is off.

2. **Batch consolidation** — Periodically, the server reads those events (and any staged facts): classifying domains, extracting and typing entities (people, organisations, projects, places — whatever the conversation is about), detecting duplicates and contradictions, and building a knowledge graph.

3. **Optional correction** — `capture_fact` remains available when the assistant should store a judgement that is not in the transcript, or a fact extraction missed. It is a correction, not the Claude Code capture path.

Other MCP clients that have no pull adapter yet still use `log_event` / `openmemory log-event` or `capture_fact`. Grok, Codex, and Cursor are later adapters.

The result is a structured, evolving knowledge graph that any AI tool can query via MCP.

## Features

- **Pull, then consolidate** — Claude Code conversations are pulled from a named source into `session_events`. Consolidation extracts and graduates facts from that D-layer. `capture_fact` is an optional correction, not how those conversations get in.
- **Batch consolidation** — Periodic processing integrates pending captures into the long-term knowledge graph: classifies domains, extracts entities, resolves duplicates, detects contradictions.
- **Entity graph** — Whatever the conversation is about — people, organisations, projects, places, products — extracted, typed and linked automatically. Relationship strength tracks corroboration.
- **Hybrid search** — BM25 keyword + structured domain + entity-graph paths, merged via Reciprocal Rank Fusion with temporal decay. Add an embedding provider and semantic similarity joins the merge as a fourth path: it ranks, it does not gate, so a fact with no embedding is still found by its words.
- **In-session memory** — Recently captured facts are immediately accessible via `get_session_context`, even before consolidation.
- **Immutable history** — Facts are never deleted, only superseded. Full history preserved.
- **Source traceability** — Every fact links back to the conversation events that produced it.
- **Manual consolidation** — Call `consolidate` at natural breakpoints (topic change, task completion, pre-compaction). No reliance on session boundaries.

## MCP Resources

Resources are context the client loads **automatically** — no tool call, no decision by the AI. Tools only help if the assistant remembers to reach for them; resources are simply present.

- `memory://briefing` — Everything worth knowing right now: profile, what was learned in the last consolidation, open threads, and recent knowledge. Markdown, kept to roughly a screenful.
- `memory://profile` — Core identity facts, most important first.

Both are read-only views over the same database the tools query, so they can't drift from it. They're regenerated on read, and clients that subscribe are notified when a consolidation changes what they'd say. Clients without resource support lose no capability — the read tools below cover the same ground on demand.

## MCP Tools

### Session
- `log_event` — Log conversation events (messages, artifacts).
- `get_events` — Retrieve events from current or previous session.
- `get_session_context` — Recall facts captured in the current session (in-session working memory).

### Reading
- `get_entity` — Everything known about any named subject — person, organisation, project, place, product — and how it connects
- `get_context` — Everything relevant to a topic (search + entity traversal)
- `search_knowledge` — Hybrid search across graduated knowledge

### Writing
- `capture_fact` — Optional correction: store a fact pull-plus-extraction missed. Fast append with session tagging. Full intelligence deferred to consolidation.
- `consolidate` — Integrate pending facts into long-term knowledge. Extracts entities, resolves duplicates, detects contradictions, builds the knowledge graph. Call at natural breakpoints or before context compaction.

### Meta
- `get_schemas` — Available domains and structure
- `get_stats` — Fact count, entity count, domain distribution

## Session Event Logging

OpenMemory captures every interaction as a `SessionEvent` — the DIKW Data layer. This is the episodic ground truth that consolidation, search, and recall all build on.

### How events are captured

Choose one mechanism.

**Recommended — pull.** Name a `claude-code` source (set `cwd`; a bare `home` walks every project group) and run `openmemory pull`. The recommended Claude Code hooks call `openmemory pull` on Stop and `openmemory signal flush` on PreCompact. The MCP server also pulls once at session start. Grok, Codex, and Cursor are later adapters. Unknown `kind` values are rejected with a clear error.

```bash
openmemory pull
# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

A second run against unchanged files inserts nothing — progress is a durable per-file watermark. A first pull that inserts more than 50 events does not auto-consolidate at session start (run `openmemory consolidate` when ready).

**Alternative — `log-event` hooks, no sources.** Leave `sources` empty. Pipe UserPromptSubmit / Stop / PostToolUse into `openmemory log-event` — the Quick Start alternative block is the recipe. MCP `log_event` / `capture_fact` keep working.

**Hard rule:** do not run `log-event` hooks and pull on the same store. OpenMemory does not detect or rewrite existing hook configs.

PreCompact `openmemory signal flush` is consolidation, not capture. It does not insert `session_events` and is part of the recommended recipe.

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

Inserts events directly into the database (no running server needed). Supported for demos and for stores that have no `claude-code` source. Not the Claude Code default — that is `sources` plus `openmemory pull`.

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

It walks each named Claude Code `home`, tails JSONL transcripts that are new since the last watermark, and inserts them into `session_events`. Prints a JSON summary. Unknown source kinds exit non-zero with an error rather than being skipped silently. Set `cwd` on the source unless you intend to ingest every project group. Do not also run `log-event` hooks on this store.

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
openmemory signal tick    # nudge the scheduler to check its triggers
openmemory signal flush   # consolidate now — for PreCompact hooks

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

`flush` is the one that matters: it is what a PreCompact hook calls so pending facts survive a context collapse. That hook consolidates; it does not insert `session_events` and it does not duplicate a `claude-code` pull. If no server is listening, `flush` falls back to an in-process **heuristic** consolidation — deliberately, because a compaction is time-critical and spawning `claude -p` could take 35–50 seconds. Lower quality, but the data survives and can be reprocessed later. A `tick` that finds no server simply exits; the next `session_start` recovers it.

#### `openmemory search <query>`

Search the knowledge base from the command line. This runs the same hybrid search the `search_knowledge` tool runs, so it answers "what does it actually know about me?" — and "why did the AI say that?" — without wiring up a client:

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

Claude Code: name a `sources` entry (set `cwd`) and pull — Stop hook or MCP session start. The `search_knowledge` description still says to search before answering questions that might benefit from personal context. `capture_fact` is there if the assistant needs to correct or add something pull-plus-extraction will not produce.

Clients with no pull adapter still rely on `log_event` / `capture_fact` until their adapter exists.

### Hook Points

| Hook Point | When | What to Call | Why It Matters |
|---|---|---|---|
| Session start | Conversation begins | `memory://profile` (automatic), `search_knowledge` | AI knows who you are from message one |
| Correction | A durable fact is missing from the store | `capture_fact` | Optional; Claude Code conversations are already in `session_events` via pull |
| Pre-response search | Before generating a reply | `search_knowledge`, `get_context` | Responses informed by personal knowledge |
| Pre-compaction | Before context window compression | `consolidate` or `openmemory signal flush` | Processes pending facts before context is wiped — does not insert events |
| Natural breakpoints | Topic change, task completion | `consolidate` (optional) | Keeps knowledge graph current |

**On pre-compaction:** This is the highest-value consolidation hook — without it, staged facts are silently lost when the client compresses context. `openmemory signal flush` (or the `consolidate` tool) graduates what pull already wrote. It is not a `log-event` hook and does not duplicate `session_events`.

### Claude Code

Create `.claude/rules/openmemory.md` in your project (or `~/.claude/rules/openmemory.md` globally). This loads automatically into context:

```markdown
# OpenMemory

- Conversations are pulled from the named Claude Code source (Stop hook runs openmemory pull)
- Do not install log-event hooks on this store
- Identity context loads automatically from the `memory://profile` resource — no tool call needed
- Before answering questions about preferences, people, or history, call `search_knowledge`
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
- Before answering questions about preferences, people, or history, call search_knowledge
- To find out everything known about a particular person, project, or thing, call get_entity
- Call capture_fact only to correct or add something pull or extraction missed
- When context is getting long, call consolidate to process pending facts before they are lost
```

Cursor and Windsurf consume tools but not resources, so `memory://profile` will not load on its own there — `search_knowledge` and `get_entity` cover the same ground on demand.

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
3. It has fallen outside its own session's most recent `extraction.working_memory_size` events, which consolidation re-reads for pronoun resolution and topical flow.

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

`npm test` skips the semantic-recall eval, because that one needs a real
embedding model rather than a stub — it drives the built server over stdio and
asks whether a query sharing no words with a fact actually finds it. To run it,
start Ollama with `ollama pull nomic-embed-text` and:

```bash
npm run test:semantic
```

That fails rather than skips when no model is reachable, so a green run means
semantic search was genuinely verified rather than quietly stepped over.

## License

MIT

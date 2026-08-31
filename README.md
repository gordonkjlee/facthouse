# OpenMemory

<img src="brand/mascot-right.png" width="128" align="right" alt="OpenMemory mascot">

A local memory engine any AI tool can use. GitHub [`gordonkjlee/openmemory`](https://github.com/gordonkjlee/openmemory), npm [`@openmem/mcp`](https://www.npmjs.com/package/@openmem/mcp).

Not a hosted plane. Not a vendor blob. You own the SQLite file. This is not Mem0's hosted "OpenMemory MCP" at [`mcp.mem0.ai`](https://mcp.mem0.ai). Same name, different product.

It records, stores, and retrieves structured knowledge. Domain routing, entity extraction, deduplication, and supersession run in the server. Exposed as an MCP server.

## Quick Start

```bash
openmemory init
```

Press Enter to accept each default (pull off, keyword search, extra knobs at shipped defaults). That writes `~/.openmemory/config.json` and prints an MCP snippet to paste.

To skip the walk-through, paste this. The server creates `~/.openmemory` on first boot; you are not asked those questions, and the defaults stay invisible until you write a config.

<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.22.0"]
    }
  }
}
```
<!-- x-release-please-end -->

Works with Claude Code, Claude Desktop, and any MCP-compatible tool. Cursor consumes tools but not resources until a later adapter exists — `search_knowledge` and `get_entity` still work there; call `get_session_context` at session start. Data is stored at `~/.openmemory` by default. That one directory is the whole install. To use a different path, add `"env": { "OPENMEMORY_DATA": "/absolute/path" }` to the config above.

## What you get

- **One file you own.** SQLite by default. Optional Postgres. Isolation is the directory, not a column.
- **Pull, then consolidate.** Claude Code and Cursor Agent JSONL land in `session_events`. Extract on pull/Stop; graduate on PreCompact flush (or a manual `consolidate`). `capture_fact` is an optional correction on that path.
- **Entity graph.** People, organisations, projects, places, products — extracted, typed and linked. Relationship strength tracks corroboration.
- **Hybrid search.** BM25 + structured domain + entity-graph paths, merged via Reciprocal Rank Fusion. An embedding provider adds meaning as a fourth list; it ranks, it does not gate. When no graduated fact matches, a short raw-log window is returned separately as `episodes`.
- **In-session memory.** `get_session_context` returns the working briefing (same markdown as `memory://briefing`) plus facts captured this session. Tools-only clients are told to call it at session start.
- **Immutable history.** Facts are never deleted, only superseded.

## How it works

One SQLite file you own. Three tables in that file, not three databases:

- **D** (`session_events`) — what was said (pulled transcripts, or `log_event`)
- **I** (`session_facts`) — what was just extracted, or `capture_fact`
- **K** (`facts`) — graduated knowledge

FTS5 (words) and optional embeddings (meaning) are indexes of **K**. They are not a second store. Semantic search is off unless you turn it on: `search "shellfish"` finds a shellfish fact, `search "food"` does not, until you choose an embedding model — a model is an opinion about what “similar” means.

Two speeds. Pull and Stop **extract** self-contained facts from new transcript lines when the threshold is due. PreCompact flush (and shutdown) **graduates** those pending facts: domains, entities, duplicates, contradictions, the graph. `openmemory consolidate` and the MCP `consolidate` tool still run both. Consolidation does not invent a sentence nobody said. Gated inferences exist and are off by default.

`capture_fact` is a correction on a pull store, and the write path when `sources` is empty. The model does not have to call it for a Claude Code or Cursor conversation to be remembered — you name a source and pull.

Put the same MCP snippet in a second AI tool and give it no rules. There is nothing to sync: both talk to one file. SQLite is the default. Optional Postgres is documented under Advanced.

Storage needs Node. Intelligence — extraction, routing, contradiction — needs a language model. By default that is the [Claude Code CLI](https://github.com/anthropics/claude-code) on your existing subscription. Without it, consolidation falls back to a built-in heuristic that **does not extract facts from transcripts**. `capture_fact` still stores facts, with no entities and no domain routing.

## Remember a conversation

Optional: pull transcripts. On a terminal, the init walk-through can add one named source. If you are pasting a recipe, use `--yes` and then edit `config.json`. Set `cwd`; a bare `home` walks every project group.

<!-- x-release-please-start-version -->
Git Bash / macOS / Linux:

```bash
export OPENMEMORY_DATA=/tmp/openmemory-try
om() { npx -y -p @openmem/mcp@0.22.0 -- openmemory "$@"; }
om init --yes
```

PowerShell:

```powershell
$env:OPENMEMORY_DATA = Join-Path $env:TEMP "openmemory-try"
function om { npx -y -p "@openmem/mcp@0.22.0" -- openmemory @args }
om init --yes
```
<!-- x-release-please-end -->

Add **one** source. `home` is the client config dir (`~/.claude` for Claude Code, `~/.cursor` for Cursor — examples of the path, not extra discovery):

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

Cursor Agent JSONL is the same knob with `"kind": "cursor"`. It reads `home/projects/*/agent-transcripts/**/*.jsonl` only — not Composer SQLite, not `state.vscdb`. Cursor encodes `C:\\dev\\app` as `c-dev-app` (Claude Code uses `C--dev-app`).

```bash
om pull
om consolidate
om search "<a word you already said to Claude Code in this project>"
```

That search is the proof: a fact you did not re-type. A first pull of more than 50 events does **not** auto-consolidate — run `om consolidate`. Do not install hooks yet. Incremental `pull` is small; the first one is not.

## MCP

Resources are context the client loads **automatically** — no tool call. Tools only help if the assistant remembers to reach for them; resources are simply present.

- `memory://briefing` — Everything worth knowing right now: profile, what was learned in the last consolidation, open threads, and recent knowledge. Markdown, kept to roughly a screenful.
- `memory://profile` — Core identity facts, most important first.

Both are read-only views over the same database the tools query. Clients that never load resources (Cursor, Windsurf, Grok) get the same briefing by calling `get_session_context` at the start of a conversation. No second profile schema.

### Tools

**Session**

- `log_event` — Log conversation events (messages, artifacts).
- `get_events` — Retrieve events from current or previous session.
- `get_session_context` — Working briefing (the same markdown as `memory://briefing`) plus facts captured in this session. Call at the start of every conversation if the client does not load resources.

**Reading**

- `get_entity` — Everything known about any named subject — person, organisation, project, place, product — and how it connects. When several rows share the name under different types, facts from all of them come back. Hyphens, underscores, and stray punctuation count as the same letters only when that does not join two names already stored as separate rows. If there is no entity by that name, facts that mention the wording still come back rather than an empty miss.
- `get_context` — Everything relevant to a topic (search + entity traversal)
- `search_knowledge` — Hybrid search across graduated knowledge

**Writing**

- `capture_fact` — Store a fact. On a pull store this is a correction for something extraction missed; on a store with empty `sources` it is how facts get in. The description the assistant sees is generated from that same rule.
- `consolidate` — Integrate pending facts into long-term knowledge. Extracts entities, resolves duplicates, detects contradictions, builds the knowledge graph.
- Inference tools — Opt-in, off by default (`inferences.enabled` in config.json). A hypothesis cites existing fact ids and stays pending until confirmed. Those tools are not registered until you turn the gate on. Consolidate never invents a sentence nobody said.

**Meta**

- `get_schemas` — Available domains and structure
- `get_stats` — Fact count, entity count, domain distribution, extract backlog, intelligence spend

## CLI

#### `openmemory init [dir]`

The walk-through is how a human first-run writes `config.json`. Skip it and the server still creates the directory on first MCP boot.

On a terminal, init asks data directory, optional transcript capture, semantic search, and More settings (extraction model and timeout today; extra knobs later). `--yes` never prompts. On a terminal, `--force` still asks those questions, then replaces the whole file; `--yes --force` is the silent reset. `--force` does not merge with the previous file.

```bash
openmemory init --yes
```

```bash
openmemory init --yes ~/my-memory
```

```bash
openmemory init --yes --force
```

The generated `config.json` is where you change consolidation behaviour — most notably `intelligence.provider` (`cli` by default; `heuristic` for a zero-dependency regex fallback, or `OPENMEMORY_PROVIDER=heuristic` at runtime). Init does not ask that field.

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

Ingest new session events from `config.sources`. Empty `sources` is a successful no-op:

```bash
openmemory pull

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

Set `cwd` on the source unless you intend to ingest every project group. Do not also run `log-event` hooks on this store.

#### `openmemory consolidate`

```bash
openmemory consolidate

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

Honours the configured provider (by default `claude -p`). Prints JSON — facts graduated, entities extracted, duplicates and contradictions resolved.

#### `openmemory signal [tick|flush]`

```bash
openmemory signal tick    # extract if the event threshold is due — pull / Stop
openmemory signal flush   # graduate pending facts — for PreCompact hooks

# Options:
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

`flush` is what a PreCompact hook calls so pending facts survive a context collapse. If no server is listening, `flush` falls back to an in-process **heuristic** graduate — deliberately, because compaction is time-critical. A `tick` that finds no server simply exits.

#### `openmemory search <query>`

```bash
openmemory search "coffee"
openmemory search "coffee" --domain preferences
openmemory search "coffee" --json

# Options:
#   --domain   Prioritise a domain. Biases ranking; does not filter
#   --limit    Maximum results (default: 20)
#   --json     Emit the raw search payload
#   --data     Data directory (default: ~/.openmemory or $OPENMEMORY_DATA)
```

`--domain` **biases ranking rather than filtering.** A hard filter would hide a fact filed under a near-synonym.

#### `openmemory stats`

```bash
openmemory stats
openmemory stats --json
```

Facts are immutable — superseded facts are kept — so the current count and the total legitimately differ once anything has been superseded. `--json` includes the answering binary's package version. Intelligence spend is calls, tokens, and elapsed time for extract / classify / entities / reconcile / supersede / summarise, with provider and model per stage. Embeddings are not that number.

#### `openmemory inspect`

Sample D, I, K, entities, and the graph. Writes a local HTML file under the data directory (not the cwd). Prints the path. Does not open a browser. The file is a memory export — treat it like `stats --json`. The same page also shows intelligence spend (Graph / Spend).

```bash
openmemory inspect
openmemory inspect --graph
openmemory inspect --layer k
openmemory inspect --json
openmemory inspect --entity Helios --limit 20 --output /tmp/inspect.html
```

`--layer health|d|i|k|entities|graph|all` prints terminal tables (newest-first, capped). `--graph` (the default when no `--layer` / `--json`) writes `inspect.html`. `--limit` is 10 for tables and 50 for the canvas. `--all` draws every node — a hairball, explicit. Search and type filter in the page can still reach a node that was outside the cap.

## Advanced

### Another store

You do not need two installs. The default is one directory and one MCP server named `openmemory`. A second store is a second directory — not a filter on which client wrote the row. Work and personal is one reason to split, not a required setup.

A non-default data directory prints a distinct MCP server name so two stores can share one `mcp.json`. Init against each extra directory prints that snippet. Example:

<!-- x-release-please-start-version -->
```json
{
  "mcpServers": {
    "openmemory-personal": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.22.0"],
      "env": { "OPENMEMORY_DATA": "C:\\Users\\alex\\.openmemory-personal" }
    },
    "openmemory-work": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.22.0"],
      "env": { "OPENMEMORY_DATA": "C:\\Users\\alex\\.openmemory-work" }
    }
  }
}
```
<!-- x-release-please-end -->

Point each store's `sources.cwd` (or hook `--data`) at that store only. Two directories do not isolate anything if both pull the same home.

### Postgres (optional)

SQLite is the default and needs no extra software. To use Postgres instead, set `storage.provider` to `"postgres"` in that store's `config.json`, or `OPENMEMORY_STORAGE=postgres` on the MCP entry, and set `OPENMEMORY_POSTGRES_URL` to a `postgres://` (or `postgresql://`) URL. The password belongs in the environment, not in `config.json`. If the URL is missing or the server cannot be reached, OpenMemory stops; it does not create a SQLite file.

The data directory is still the memory: `config.json` and the scheduler socket live there. Tables live at the URL. Two memories need two directories and two databases.

Init does not ask which engine to use. `openmemory init --yes` still writes sqlite.

Example — placeholders only; do not put a real password in a committed file:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp@0.22.0"],
      "env": {
        "OPENMEMORY_DATA": "C:\\Users\\alex\\.openmemory-work",
        "OPENMEMORY_STORAGE": "postgres",
        "OPENMEMORY_POSTGRES_URL": "postgres://USER:PASSWORD@127.0.0.1:5432/openmemory"
      }
    }
  }
}
```

### Pull versus log-event

Choose one mechanism per store.

**Recommended — pull.** Name a `claude-code` or `cursor` source (set `cwd`) and run `openmemory pull` from the CLI first. The MCP server also pulls once at session start. Grok and Codex are later adapters. Unknown `kind` values are rejected.

**Alternative — `log-event` hooks, no sources.** Leave `sources` empty. Pipe UserPromptSubmit / Stop / PostToolUse into `openmemory log-event`. MCP `log_event` / `capture_fact` keep working.

Do not install log-event hooks on this store — both write the same rows. OpenMemory does not detect or rewrite existing hook configs.

### Hooks (after the first CLI pull)

`mcp.json` `env` is **not** visible to hooks. Pass the same `--data` (or export `OPENMEMORY_DATA` in the environment the client itself inherits). The command must invoke the CLI (`openmemory`), never the server binary. `npx -y @openmem/mcp` with no `-p` / `openmemory` starts the MCP **server** and hangs a hook. Pin the package version and put `--` before `openmemory` so a globally installed older `openmemory` on PATH cannot win.

<details>
<summary>Stop / PreCompact hook JSON</summary>

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p @openmem/mcp@0.22.0 -- openmemory pull --data /absolute/path/to/the-same-store"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p @openmem/mcp@0.22.0 -- openmemory signal flush --data /absolute/path/to/the-same-store"
          }
        ]
      }
    ]
  }
}
```

</details>

Stop tails new lines (pull then ticks the server to extract when the threshold is due). PreCompact `signal flush` graduates pending facts without re-reading the transcript. It does not insert `session_events`. On Windows the `--data` path is the same absolute directory you put in `OPENMEMORY_DATA` (for example `C:\\Users\\alex\\AppData\\Local\\Temp\\openmemory-try`).

Stop-hook pull interleaves conversations on the global sequence: a long chat kept open is sliced between other chats. Extract progress is per conversation, so a timeout in one chat does not discard another. Shrinking `extraction.batch_size` means more extract calls (more chances of a timeout), not a store-wide hold-all. `openmemory stats` reports unextracted events against that extract watermark.

If the MCP server does not start, or lists no tools, check the package version the client actually spawned. A global `openmemory` on PATH can be years behind the pin in this README. Diagnose with `openmemory stats --data <dir>` (the CLI prints whether the scheduler is listening) and by inspecting `serverInfo.version` from `initialize` plus `tools/list` over stdio. `0.2.x` answers `initialize` then throws on `tools/list`.

### Embeddings, model, timeout, bitemporal

Set `embedding.provider` in `config.json` to `"ollama"` (local, no API key) or `"voyage"` (hosted), run `openmemory consolidate`, and `search "food"` starts returning the allergy. Facts are embedded when they are consolidated. Voyage applies a **3 requests/minute** rate limit until a payment method is on the account.

Meaning-search is an exact scan of stored vectors when the set is small. When that set is large (default 32 MiB of the current model), an HNSW index of those vectors is used instead: in-process on SQLite, or a Postgres `vector` sidecar when the extension is enabled. Small stores stay exact. A missing engine keeps exact search and prints a warning; OpenMemory does not install a native addon. `embedding.ann` is `null` (auto), `false` (never), or `true` (force when the engine allows). This does not turn embeddings on.

`intelligence.cli.model` and `intelligence.cli.timeout_ms` are the extra knobs More settings can write. Init does not ask `intelligence.provider`; `OPENMEMORY_PROVIDER=heuristic` is the kill-switch. The heuristic fallback **does not extract facts from transcripts**.

Unnamed user-channel speech is attributed to the store's owner; a display name still does not create a person. Extra backing (assent, a tool observation, a different speaker restating) is recorded, not scored, unless the store sets `interlocutor` ranking weights in `config.json`. The engine ships none. Weight keys match the speaker string as stored, so two people with the same name share a key.

Set `temporal.mode` to `bitemporal` to record when the system retracted a belief, so search can answer what the store believed at an instant.

### Intelligence spend

`openmemory stats` and `get_stats` report billed consolidation calls: tokens, elapsed time, and the provider plus model on each stage (extract, classify, entities, reconcile, supersede, summarise). A run that did not report tokens omits those fields rather than showing zero. Embeddings are a different API and are not this number.

Optional `intelligence.token_budget` caps billed extract per provider on rolling windows. Unset is unlimited. Over the cap, consolidate skips extract, holds the watermark, and does not fall back to the heuristic. Stats and inspect Spend show used and remaining on each cap, and when oldest usage in that window ages out (`resets`).

```json
"intelligence": {
  "token_budget": {
    "cli": { "week": "10M" }
  }
}
```

`hour`, `day`, `week`, and `month` are rolling. Omit a scale to leave it unlimited. Remaining room is on `openmemory stats`, `get_stats`, and inspect Spend. Set the cap in this store's `config.json` — there is no budget command.

### CLI demo (no transcript source)

Throwaway store, not the capture path for a real Claude Code or Cursor home. These three lines are typed in.

```bash
export OPENMEMORY_DATA=/tmp/openmemory-demo
om() { npx -y -p @openmem/mcp@0.22.0 -- openmemory "$@"; }

om init --yes

om log-event --role user --content "I prefer dark mode in every editor, and I never want telemetry enabled."
om log-event --role user --content "I am allergic to shellfish, so avoid seafood restaurants when booking anything."
om log-event --role user --content "My colleague Robin at Acme is leading the Atlas migration project this quarter."

om consolidate
```

```powershell
$env:OPENMEMORY_DATA = Join-Path $env:TEMP "openmemory-demo"
function om { npx -y -p "@openmem/mcp@0.22.0" -- openmemory @args }
om init --yes
om log-event --role user --content "I prefer dark mode in every editor, and I never want telemetry enabled."
om log-event --role user --content "I am allergic to shellfish, so avoid seafood restaurants when booking anything."
om log-event --role user --content "My colleague Robin at Acme is leading the Atlas migration project this quarter."
om consolidate
```

```bash
om search "Atlas"
om stats
```

`allergies` is not a domain OpenMemory ships. The engine has no built-in vocabulary — it read the conversation and decided that fact needed a home. A domain **biases ranking rather than filtering**. Clean up with `rm -rf /tmp/openmemory-demo`.

## Integration

OpenMemory's tool descriptions tell assistants when to search and when a correction is worth staging. They are not how Claude Code conversations enter the store — that is pull from a named source.

### Without configuration

Claude Code or Cursor: name a `sources` entry (set `cwd`) and pull from the CLI first. MCP session start also pulls. `capture_fact` is there if the assistant needs to correct or add something pull-plus-extraction will not produce.

Clients with no pull adapter still rely on `log_event` / `capture_fact` until their adapter exists.

### Hook points

| Hook point | When | What to call | Why |
|---|---|---|---|
| Session start | Conversation begins | `memory://profile` (automatic), `search_knowledge` | The assistant knows who you are from message one |
| Correction | A durable fact is missing from the store | `capture_fact` | Optional; Claude Code conversations are already in `session_events` via pull |
| Pre-response search | Before generating a reply | `search_knowledge`, `get_context` | Responses informed by stored knowledge |
| Pre-compaction | Before context window compression | `consolidate` or `openmemory signal flush` | Graduates pending facts before context is wiped |
| Natural breakpoints | Topic change, task completion | `consolidate` (optional) | Keeps the knowledge graph current |

**On pre-compaction:** `openmemory signal flush` graduates what extract already wrote; it does not re-read the transcript. It is not a `log-event` hook and does not duplicate `session_events`.

### Claude Code

Create `.claude/rules/openmemory.md` in your project (or `~/.claude/rules/openmemory.md` globally):

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

Cursor and Windsurf consume tools but not resources, so `memory://profile` will not load on its own there. Cursor conversations themselves are pulled with `kind: "cursor"` (JSONL under `~/.cursor/projects/`, not the SQLite composer store).

### Claude Desktop / other MCP clients

No pull adapter yet. Tool descriptions handle search and optional `capture_fact`; conversations are not tailed until a later adapter exists.

## Reclaiming space

OpenMemory logs raw conversation and tool output to `session_events`. On a store wired into an agentic client this becomes almost all of the database. A store measured in daily use held 47,000 events and 493 MB against 21 graduated facts.

`openmemory stats` reports the raw layer alongside the knowledge, including how much is reclaimable. To reclaim it:

```bash
openmemory prune                    # report only — nothing is deleted
openmemory prune --apply --vacuum   # delete, then rebuild the file
```

Set `retention.disk_budget` in `config.json` to a size such as `"2GB"` to cap `memory.db`. Unset is unlimited; init does not write a cap. When a cap is set and the file is full, unreachable raw events are pruned automatically so new logs can reuse that space; if nothing unused remains, more raw events are refused. Facts are never deleted to meet the number. Compacting (`--vacuum`) is still a human step — it copies the whole file so the operating system sees the smaller size.

If most of that volume is tool output you judge to be noise, `extraction.event_types` and `extraction.roles` restrict what is examined, and `extraction.min_content_length` skips trivial events. Measure before you do. Volume and value are not the same axis.

**The rule is reachability, not age.** An event is removed only when all three hold:

1. Extraction has already read it. Anything ahead of the consolidation watermark is still input.
2. No fact's provenance cites it.
3. It has fallen outside its own session's most recent `extraction.working_memory_size` events — a spare so consolidation can still glance at recent raw notes. That window is evidence of the current topic, not a pronoun dictionary.

No fact, entity, embedding or search result is affected. Deleting rows does not shrink the file on its own — that is `--vacuum`. Without a cap, nothing prunes automatically.

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
- The live first-fact eval needs the `claude` CLI. Run `npm run test:first-fact`.
- The live coding-store eval (warehouse-shaped Cursor transcripts) also
  needs the `claude` CLI. Run `npm run test:coding-store`.

Each of those scripts fails rather than skips when its dependency is missing,
so a green run means the claim was actually verified rather than quietly
stepped over.

## License

MIT

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
      "args": ["-y", "@openmem/mcp@0.2.0"]
    }
  }
}
```
<!-- x-release-please-end -->

Works with Claude Code, Claude Desktop, Cursor, and any MCP-compatible tool. Data is stored at `~/.openmemory` by default. To change this, add `"env": { "OPENMEMORY_DATA": "/absolute/path" }` to the config above.

> **Disable your client's built-in memory.** OpenMemory replaces it — running both fragments your knowledge across two systems. In Claude Desktop: Settings → Memory → off. In ChatGPT: Settings → Personalisation → Memory → off. This ensures OpenMemory is the single source of truth.

## How It Works

OpenMemory captures knowledge through two complementary paths:

1. **Fast capture** — During conversation, the AI calls `capture_fact` whenever it learns something useful. Facts are stored immediately in a session staging buffer.

2. **Batch consolidation** — Periodically, the server processes all pending facts as a batch: classifying domains, extracting entities (people, places, organisations), detecting duplicates and contradictions, and building a knowledge graph.

Optionally, the server can also scan raw conversation events during consolidation to extract facts the AI missed — a safety net that ensures important knowledge isn't lost.

The result is a structured, evolving knowledge graph that any AI tool can query via MCP.

## Features

- **Hybrid knowledge capture** — AI explicitly captures facts during conversation. Optionally, the server can also extract facts from raw events during consolidation as a safety net.
- **Batch consolidation** — Periodic processing integrates pending captures into the long-term knowledge graph: classifies domains, extracts entities, resolves duplicates, detects contradictions.
- **Entity graph** — People, places, organisations automatically extracted and linked. Relationship strength tracks corroboration.
- **Hybrid search** — BM25 keyword + structured domain + entity-graph paths, merged via Reciprocal Rank Fusion with temporal decay.
- **In-session memory** — Recently captured facts are immediately accessible via `get_session_context`, even before consolidation.
- **Immutable history** — Facts are never deleted, only superseded. Full history preserved.
- **Source traceability** — Every fact links back to the conversation events that produced it.
- **Manual consolidation** — Call `consolidate` at natural breakpoints (topic change, task completion, pre-compaction). No reliance on session boundaries.

## MCP Tools

### Session
- `log_event` — Log conversation events (messages, artifacts).
- `get_events` — Retrieve events from current or previous session.
- `get_session_context` — Recall facts captured in the current session (in-session working memory).

### Reading
- `get_profile` — Core identity facts
- `get_preferences` — Preferences by domain
- `get_people` — Person profiles with relationships
- `get_context` — Everything relevant to a topic (search + entity traversal)
- `search_knowledge` — Hybrid search across graduated knowledge

### Writing
- `capture_fact` — Store a fact. Fast append with session tagging. Full intelligence deferred to consolidation.
- `consolidate` — Integrate pending facts into long-term knowledge. Extracts entities, resolves duplicates, detects contradictions, builds the knowledge graph. Call at natural breakpoints or before context compaction.

### Meta
- `get_schemas` — Available domains and structure
- `get_stats` — Fact count, entity count, domain distribution

## Session Event Logging

OpenMemory captures every interaction as a `SessionEvent` — the DIKW Data layer. This is the episodic ground truth that consolidation, search, and recall all build on.

### How events are captured

All events are captured via the `log_event` MCP tool or the `openmemory log-event` CLI command. The calling AI logs conversation messages; Claude Code hooks can automate this:

### Claude Code Hooks

For Claude Code, hooks provide deterministic capture — they fire every time, regardless of whether the AI "remembers" the tool description.

#### Available hooks

| Hook | Fires when | What it captures |
|------|-----------|-----------------|
| `UserPromptSubmit` | User sends a message | Full prompt text |
| `Stop` | Assistant finishes responding | Last assistant message |
| `PostToolUse` | Tool call completes | Tool name, input, and response |

#### Setup

Install the CLI for hooks:

    npm install -g @openmem/mcp

Alternatively, replace `openmemory` with `npx -y @openmem/mcp` in the hook commands below (no install needed, but adds ~2-3s latency per hook).

Add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

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
    ]
  }
}
```

The CLI reads the hook JSON payload from stdin and extracts the relevant content field (`prompt` for `UserPromptSubmit`, `last_assistant_message` for `Stop`, full JSON for `PostToolUse`). Events are appended to the most recently active session in the database.

The `PostToolUse` matcher excludes OpenMemory's own tools (`^(?!mcp__openmemory__)`) to avoid capturing internal operations.

### CLI Reference

The `openmemory log-event` command inserts events directly into the database (no running server needed):

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

## Integration Patterns

OpenMemory's tool descriptions are the primary integration layer — they tell AI assistants when to capture facts and search knowledge, working with every MCP client out of the box. For deeper integration, clients can add **rules-based hooks** (instructions loaded into the AI's context) at key moments in the conversation lifecycle. These are optional but make capture and retrieval more reliable.

### Without Configuration

The `capture_fact` tool description tells the AI to "call this proactively whenever you learn something useful." The `search_knowledge` description says "call this BEFORE answering questions that might benefit from personal context." These descriptions ship with the server and drive behaviour without any client setup.

### Hook Points

| Hook Point | When | What to Call | Why It Matters |
|---|---|---|---|
| Session start | Conversation begins | `get_profile`, `search_knowledge` | AI knows who you are from message one |
| Proactive capture | User mentions a preference, fact, or decision | `capture_fact` | Knowledge compounds across sessions |
| Pre-response search | Before generating a reply | `search_knowledge`, `get_context` | Responses informed by personal knowledge |
| Pre-compaction | Before context window compression | `consolidate` | Processes pending facts before context is wiped |
| Natural breakpoints | Topic change, task completion | `consolidate` (optional) | Keeps knowledge graph current |

**On pre-compaction:** This is the highest-value hook point — without it, knowledge is silently lost when the client compresses context. Calling `consolidate` before compaction processes all pending facts into long-term knowledge. If event extraction is enabled, the server also scans the raw conversation events to extract facts the AI missed.

### Claude Code

Create `.claude/rules/openmemory.md` in your project (or `~/.claude/rules/openmemory.md` globally). This loads automatically into context:

```markdown
# OpenMemory

- At the start of each conversation, call `get_profile` to load identity context
- Before answering questions about preferences, people, or history, call `search_knowledge`
- When the user mentions preferences, personal details, relationships, or decisions, call `capture_fact`
- When the conversation is getting long, call `consolidate` to process pending facts before they are lost to compaction
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
- At conversation start, call get_profile to load user context
- Before answering questions about preferences or history, call search_knowledge
- When the user shares preferences, facts, or decisions, call capture_fact
- When context is getting long, call consolidate to process pending facts before they are lost
```

### Claude Desktop / Other MCP Clients

No configuration needed. Tool descriptions handle integration automatically — the AI assistant reads the tool descriptions and knows when to capture and search.

## Development

```bash
git clone https://github.com/gordonkjlee/openmemory
cd openmemory
npm install
npm run build
npm test
```

## License

MIT

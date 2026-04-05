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
      "args": ["-y", "@openmem/mcp@0.0.5"]
    }
  }
}
```
<!-- x-release-please-end -->

Works with Claude Code, Claude Desktop, Cursor, and any MCP-compatible tool. Data is stored at `~/.openmemory` by default. To change this, add `"env": { "OPENMEMORY_DATA": "/absolute/path" }` to the config above.

## MCP Tools

### Session
- `log_event` - Log a session event (user messages, assistant responses, tool calls, tool results, artifacts). Call this to build the episodic record of the conversation.
- `get_events` - Retrieve events from the current or a previous session. Use this to recall what happened earlier (especially after context compaction), or to review a previous session.

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

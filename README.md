# OpenMemory

AI memory engine exposed as an MCP server. Structured knowledge with server-side intelligence - domain routing, entity extraction, deduplication, and supersession. Any AI tool can query it. You own the data.

## The Problem

AI agents can store knowledge, but existing approaches limit how effectively it can be structured and retrieved. Built-in memories like ChatGPT and Claude store flat text with no schema or relationships — and are not portable across tools. Developer libraries offer memory primitives but require significant integration work. Knowledge graph engines provide rich entity extraction at the cost of multiple LLM calls per ingestion and operational overhead. Lightweight solutions achieve cross-tool sharing but without structure, confidence scoring, or deduplication.

The common gap: structured, schema-driven knowledge with effective retrieval, working across any AI tool, without significant infrastructure cost.

## The Solution

One place that accumulates structured knowledge - validated, owned by you - and every AI tool can query it with granular permissions. Works for personal identity, team knowledge, project context, or any use case where AI needs persistent memory.

## Quick Start

Add to your AI tool's MCP configuration:

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["-y", "@openmem/mcp", "--data", "~/.openmemory"]
    }
  }
}
```

Works with Claude Code, Claude Desktop, Cursor, and any MCP-compatible tool.

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

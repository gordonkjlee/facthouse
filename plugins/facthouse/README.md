# Facthouse

Local AI memory: neuroscience-inspired Data→Information→Knowledge in SQLite you own.

Cursor plugin and Claude Code plugin for the local `@facthouse/mcp` server. Grok Build reads the Claude Code manifest. This version has no hook.

## Requirements

Node.js 22.5+ or 24+.

## Network

The client starts the server with `npx` and the package pin in `mcp.json` (Cursor) and `.mcp.json` (Claude Code). Those two files are the same document. The only network use is npm fetching the package.

## Store

The default directory is `~/.facthouse`. The record store is `memory.db` in that directory. Set `FACTHOUSE_DATA` to an absolute path and the server uses that directory.

The first time the server starts, it creates the directory and an empty record store. You can save a fact and search for it with no `facthouse init`.

`facthouse init` is how you copy existing chats in. Run it in a terminal and pick Cursor.

## Privacy

The store is a SQLite file on your computer. Facthouse does not upload the database or the facts in it.

## Install to try locally

Copy this directory to `~/.cursor/plugins/local/facthouse` and restart Cursor.

Claude Code loads the same directory with `--plugin-dir`.

## Skills

- `facthouse-start` runs when you begin work on a project, or when you ask to index, learn, or set up memory.
- `facthouse-save` runs when you say remember, save this, or don't forget, and after a hard fix, a decision, a convention, or a preference.
- `facthouse-search` runs when you ask about previous work, past bugs, decisions, people, projects, or last time.

The Cursor rule in `rules/facthouse.mdc` is always on. It says Facthouse memory is available, to follow the server's instructions (`get_session_context` at the start), and to use these skills.

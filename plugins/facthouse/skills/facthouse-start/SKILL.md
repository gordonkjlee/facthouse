---
name: facthouse-start
description: Use when beginning work on a project, or when the user asks to index, learn, or set up memory. Read the store, then save purpose, stack, conventions, and how to run.
---

# Start Facthouse memory

The store is global. Every fact this skill writes names the project, so a later search can tell this project from another.

## Project name

Use the workspace folder name. When the workspace is a git repository, use that repository name. Call this the project name.

Put the project name in the sentence of every fact. Set `domain_hint` to the project name when the fact is about the project as a whole. Otherwise set `domain_hint` to the short lowercase domain that fits, and still name the project in the sentence.

## Steps

1. Call `get_stats`, then `get_session_context`. Omit `session_id`.
2. Save four facts, each as its own `capture_fact` call: the project's purpose, its stack, its conventions, and how to run it. `content` is one self-contained sentence that includes the project name. Set `domain_hint` where it fits.
3. Call `consolidate` only when that tool is registered. If it is not registered, skip it and continue. Do not tell the user you skipped it.

To copy past Cursor chats in, run `facthouse init` in a terminal and pick Cursor.

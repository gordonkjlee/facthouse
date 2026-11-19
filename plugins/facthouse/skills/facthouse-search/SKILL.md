---
name: facthouse-search
description: Use when the user asks about previous work, past bugs, decisions, people, projects, or last time. Search the store and say when nothing is stored.
---

# Search Facthouse

The store is global. When the question is about this project, add the project name to the search.

## Project name

Use the workspace folder name, or the git repository name when the workspace is that repository. Add that name to a `search_knowledge` query and a `get_context` topic when the question is about this project. `get_entity` still takes the name of the person, project, or other thing the question names.

## Which tool

- Call `search_knowledge` with a focused `query` when you need a specific fact. Read both `results` and `pending`.
- Call `get_entity` with `name` set to the named person, project, or other thing.
- Call `get_context` with `topic` when the question is broad and one fact would miss the connections.

Say plainly when nothing is stored. An empty result is not a guess.

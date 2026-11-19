---
name: facthouse-save
description: Use when the user says remember, save this, or don't forget, or after a hard fix, a decision, a convention, or a preference. Write one self-contained sentence. Never save secrets, tokens or passwords.
---

# Save a fact

The store is global. Include the project name in the sentence you save.

## Project name

Use the workspace folder name, or the git repository name when the workspace is that repository.

## When to save

Use this when the user says "remember", "save this", or "don't forget", and after a hard fix, a decision, a convention, or a preference.

## Write

Call `capture_fact` once. Never save secrets, tokens or passwords.

- `content` is one self-contained sentence. A later search has to understand it without this chat. Include the project name.
- `domain_hint` is the short lowercase domain that fits. Use the project name when the fact is about the project itself.

## Stores that copy transcripts

On a store that copies transcripts, use `capture_fact` only for a correction or for something extraction would miss. Do not recapture the conversation.

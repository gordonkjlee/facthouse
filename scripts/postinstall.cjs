#!/usr/bin/env node

/**
 * Postinstall check: verify better-sqlite3 native binary loaded.
 * Gives a clear, actionable error instead of a cryptic bindings failure at runtime.
 */

try {
  require("better-sqlite3");
} catch (err) {
  const node = `  Node ${process.version} may not have prebuilt binaries available.`;
  console.error(`
┌──────────────────────────────────────────────────────────────┐
│  @openmem/mcp: native SQLite binary failed to load           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│${node.padEnd(62)}│
│                                                              │
│  Fix (pick one):                                             │
│                                                              │
│    1. Use a Node LTS version (20, 22, or 24):                │
│       nvm install --lts && nvm use --lts                     │
│                                                              │
│    2. Install C++ build tools and rebuild:                    │
│       npm rebuild better-sqlite3                             │
│                                                              │
│       • macOS:  xcode-select --install                       │
│       • Ubuntu: sudo apt install build-essential python3     │
│       • Windows: install "Desktop development with C++"      │
│         from https://visualstudio.microsoft.com/downloads/   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
`);
  // Exit 0 so npm install doesn't fail — the error surfaces at runtime
  // if the user ignores the warning.
}

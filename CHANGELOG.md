# Changelog

## [0.0.4](https://github.com/gordonkjlee/openmemory/compare/v0.0.3...v0.0.4) (2026-03-31)


### Bug Fixes

* make getLatestSession test deterministic with real delays ([#9](https://github.com/gordonkjlee/openmemory/issues/9)) ([0e1a0cb](https://github.com/gordonkjlee/openmemory/commit/0e1a0cb38344289884c9708e769a1e9ea5d8403d))

## [0.0.3](https://github.com/gordonkjlee/openmemory/compare/v0.0.2...v0.0.3) (2026-03-31)


### Bug Fixes

* add deterministic tiebreaker to getLatestSession query ([#7](https://github.com/gordonkjlee/openmemory/issues/7)) ([e3ac659](https://github.com/gordonkjlee/openmemory/commit/e3ac659f2ab0cbabe6579d618bb34aac831c0d31))

## [0.0.2](https://github.com/gordonkjlee/openmemory/compare/v0.0.1...v0.0.2) (2026-03-31)


### Features

* add session event logging with SQLite storage and CLI ([#3](https://github.com/gordonkjlee/openmemory/issues/3)) ([14853d8](https://github.com/gordonkjlee/openmemory/commit/14853d8d49eb7350f2314b46f1620b3b1cfc4e35))

## [0.0.1](https://github.com/gordonkjlee/openmemory/commits/v0.0.1) (2026-03-30)

### Features

- Project scaffold: package.json, tsconfig, vitest config
- MCP server entry point (src/index.ts) with stdio transport
- Server configuration types (DomainDef, TemporalConfig, ServerConfig)
- Smoke test suite

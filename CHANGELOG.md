# Changelog

## [0.0.7](https://github.com/gordonkjlee/openmemory/compare/v0.0.6...v0.0.7) (2026-04-05)


### Bug Fixes

* **db:** drop FK on session_events, add dual session columns ([#28](https://github.com/gordonkjlee/openmemory/issues/28)) ([7f4b9eb](https://github.com/gordonkjlee/openmemory/commit/7f4b9eb96bdae3acb9e08c8396bf71dca3c30ed2))

## [0.0.6](https://github.com/gordonkjlee/openmemory/compare/v0.0.5...v0.0.6) (2026-04-05)


### Features

* pin version in Quick Start and auto-update via release-please ([#21](https://github.com/gordonkjlee/openmemory/issues/21)) ([c95f262](https://github.com/gordonkjlee/openmemory/commit/c95f2623f5543bbd95e6d236717a3339e9abd041))
* upgrade better-sqlite3 to v12 with postinstall check ([#14](https://github.com/gordonkjlee/openmemory/issues/14)) ([a06bba0](https://github.com/gordonkjlee/openmemory/commit/a06bba0e43b0d8f6ab62ab5647b1f6fe36555de3))


### Bug Fixes

* **cli:** handle string chunks in stdin reader ([#22](https://github.com/gordonkjlee/openmemory/issues/22)) ([52a05fd](https://github.com/gordonkjlee/openmemory/commit/52a05fdb538635beaec4fc5f967e605c37762669))
* use block annotation for release-please version in README ([#27](https://github.com/gordonkjlee/openmemory/issues/27)) ([237fa30](https://github.com/gordonkjlee/openmemory/commit/237fa30a5773bd3bf4822b84b2c4266fdc40b3a4))

## [0.0.5](https://github.com/gordonkjlee/openmemory/compare/v0.0.4...v0.0.5) (2026-03-31)


### Features

* add session event logging with SQLite storage and CLI ([#3](https://github.com/gordonkjlee/openmemory/issues/3)) ([14853d8](https://github.com/gordonkjlee/openmemory/commit/14853d8d49eb7350f2314b46f1620b3b1cfc4e35))


### Bug Fixes

* add deterministic tiebreaker to getLatestSession query ([#7](https://github.com/gordonkjlee/openmemory/issues/7)) ([e3ac659](https://github.com/gordonkjlee/openmemory/commit/e3ac659f2ab0cbabe6579d618bb34aac831c0d31))
* make getLatestSession test deterministic with real delays ([#9](https://github.com/gordonkjlee/openmemory/issues/9)) ([0e1a0cb](https://github.com/gordonkjlee/openmemory/commit/0e1a0cb38344289884c9708e769a1e9ea5d8403d))

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

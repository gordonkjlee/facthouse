# Changelog

## [0.5.0](https://github.com/gordonkjlee/openmemory/compare/v0.4.0...v0.5.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* **db:** requires Node >= 22.5 (node:sqlite). Node 20 reached end-of-life on 2026-04-30 and is dropped from engines and CI.

### Features

* **db:** replace better-sqlite3 with Node's built-in node:sqlite ([#78](https://github.com/gordonkjlee/openmemory/issues/78)) ([f557de6](https://github.com/gordonkjlee/openmemory/commit/f557de6a7c5663635545d8712d26e5d12ef37a29))


### Bug Fixes

* **ci:** pin npm to 11.x for publishing and guard CLI tests on sqlite ([#76](https://github.com/gordonkjlee/openmemory/issues/76)) ([a280428](https://github.com/gordonkjlee/openmemory/commit/a280428d3a9204d5aeaf2cfb7e8e80d28cdc5db2))

## [0.4.0](https://github.com/gordonkjlee/openmemory/compare/v0.3.0...v0.4.0) (2026-07-16)


### Features

* **cli:** add init command to create data dir, database, and config ([#71](https://github.com/gordonkjlee/openmemory/issues/71)) ([076292c](https://github.com/gordonkjlee/openmemory/commit/076292cf4f80005400df29d7f3532eb3fd4f8965))


### Bug Fixes

* **cli:** create the data directory when logging an event ([#74](https://github.com/gordonkjlee/openmemory/issues/74)) ([142788b](https://github.com/gordonkjlee/openmemory/commit/142788be1d27cae9817139339624d406e41edd71))

## [0.3.0](https://github.com/gordonkjlee/openmemory/compare/v0.2.0...v0.3.0) (2026-07-16)


### Features

* add session event logging with SQLite storage and CLI ([#3](https://github.com/gordonkjlee/openmemory/issues/3)) ([5bb8871](https://github.com/gordonkjlee/openmemory/commit/5bb887136e5964dc5f88b9ccfedda7a5b4924537))
* **db:** schema v3-v4 and data access layer for knowledge pipeline ([03a083f](https://github.com/gordonkjlee/openmemory/commit/03a083f4c4c8c5b7b54414b1d87da5a31e2e7da4))
* **intelligence:** add consolidation pipeline, hybrid search, and MCP tools ([#38](https://github.com/gordonkjlee/openmemory/issues/38)) ([cf8eb39](https://github.com/gordonkjlee/openmemory/commit/cf8eb395d01424cf0c033d98b90bd1821c27385f))
* **intelligence:** auto-consolidation pipeline with configurable triggers ([#44](https://github.com/gordonkjlee/openmemory/issues/44)) ([494c3f7](https://github.com/gordonkjlee/openmemory/commit/494c3f78bb1183cff353831a5a93410873452356))
* **intelligence:** default to CLI subprocess provider with kill-switch ([#66](https://github.com/gordonkjlee/openmemory/issues/66)) ([72a65ea](https://github.com/gordonkjlee/openmemory/commit/72a65ead59d7054e70d66cf6940a7a4b07e22731))
* pin version in Quick Start and auto-update via release-please ([#21](https://github.com/gordonkjlee/openmemory/issues/21)) ([9ea2c04](https://github.com/gordonkjlee/openmemory/commit/9ea2c04284c79d55a57a93363387c45cdc9a92e5))
* **types:** extend data model and config for DIKW knowledge pipeline ([#30](https://github.com/gordonkjlee/openmemory/issues/30)) ([5bb0eff](https://github.com/gordonkjlee/openmemory/commit/5bb0eff54480fdb453dcdba63d2d202aa0be1d43))
* upgrade better-sqlite3 to v12 with postinstall check ([#14](https://github.com/gordonkjlee/openmemory/issues/14)) ([4979e57](https://github.com/gordonkjlee/openmemory/commit/4979e5798a2fa51591683c4d67e4c3177aed9d83))


### Bug Fixes

* add deterministic tiebreaker to getLatestSession query ([#7](https://github.com/gordonkjlee/openmemory/issues/7)) ([4367d7a](https://github.com/gordonkjlee/openmemory/commit/4367d7a903b62092e3d76c45e919e29ce5b0a86d))
* **cli:** handle string chunks in stdin reader ([#22](https://github.com/gordonkjlee/openmemory/issues/22)) ([0a50c3d](https://github.com/gordonkjlee/openmemory/commit/0a50c3dffe6c7a9005f30678867268f323d9ccf8))
* **db:** drop FK on session_events, add dual session columns ([#28](https://github.com/gordonkjlee/openmemory/issues/28)) ([a3665e3](https://github.com/gordonkjlee/openmemory/commit/a3665e3326ed3ea61519159f93609d1a09196b68))
* make getLatestSession test deterministic with real delays ([#9](https://github.com/gordonkjlee/openmemory/issues/9)) ([22b200a](https://github.com/gordonkjlee/openmemory/commit/22b200a18745c0f830508ec2940ba691be07a3eb))
* use block annotation for release-please version in README ([#27](https://github.com/gordonkjlee/openmemory/issues/27)) ([b395b99](https://github.com/gordonkjlee/openmemory/commit/b395b99472bd646e0483e3a5eebfe4d7537b7645))

## [0.2.0](https://github.com/gordonkjlee/openmemory/compare/v0.1.0...v0.2.0) (2026-04-25)


### Features

* **intelligence:** auto-consolidation pipeline with configurable triggers ([#44](https://github.com/gordonkjlee/openmemory/issues/44)) ([a6c368a](https://github.com/gordonkjlee/openmemory/commit/a6c368aa88ec0f7be8585f6638292a8147987270))

## [0.1.0](https://github.com/gordonkjlee/openmemory/compare/v0.0.7...v0.1.0) (2026-04-13)


### Features

* **db:** schema v3-v4 and data access layer for knowledge pipeline ([801a582](https://github.com/gordonkjlee/openmemory/commit/801a5823b750bf30391bada889ac9c6d7024822c))
* **intelligence:** add consolidation pipeline, hybrid search, and MCP tools ([#38](https://github.com/gordonkjlee/openmemory/issues/38)) ([6c7d5ee](https://github.com/gordonkjlee/openmemory/commit/6c7d5ee5bbd09f49718fcbdce6170e57d876ce3e))
* **types:** extend data model and config for DIKW knowledge pipeline ([#30](https://github.com/gordonkjlee/openmemory/issues/30)) ([a05ef5a](https://github.com/gordonkjlee/openmemory/commit/a05ef5af535ae2f1f3649411fd722f25dd8bcff5))

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

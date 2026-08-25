# Changelog

## [0.16.0](https://github.com/gordonkjlee/openmemory/compare/v0.15.0...v0.16.0) (2026-08-25)


### Features

* **intelligence:** extract with now and referents ([#150](https://github.com/gordonkjlee/openmemory/issues/150)) ([bc238e3](https://github.com/gordonkjlee/openmemory/commit/bc238e35815cb035c7a8e0da5ed7b003e6678ac8))
* **tools:** match capture_fact to store mode ([#151](https://github.com/gordonkjlee/openmemory/issues/151)) ([f41e645](https://github.com/gordonkjlee/openmemory/commit/f41e64581a73f3b6fd04106bb51eaa705da332d1))


### Bug Fixes

* **cli:** tell testers how to turn pull on without hanging hooks ([#147](https://github.com/gordonkjlee/openmemory/issues/147)) ([53e320f](https://github.com/gordonkjlee/openmemory/commit/53e320f4c4a285ed4c6f799b6ce96b04f830e7a1))
* **intelligence:** extract each conversation on its own ([#149](https://github.com/gordonkjlee/openmemory/issues/149)) ([e6effcf](https://github.com/gordonkjlee/openmemory/commit/e6effcf736e5285effced12fc8aa2c73b2a7a5f9))

## [0.15.0](https://github.com/gordonkjlee/openmemory/compare/v0.14.1...v0.15.0) (2026-08-23)


### Features

* client-agnostic capture — Claude Code pull into session_events ([#144](https://github.com/gordonkjlee/openmemory/issues/144)) ([2a4346b](https://github.com/gordonkjlee/openmemory/commit/2a4346bb7660644bdbcccb397535a613fdb1e4b8))

## [0.14.1](https://github.com/gordonkjlee/openmemory/compare/v0.14.0...v0.14.1) (2026-08-10)


### Bug Fixes

* **docs:** correct an overstated figure about where facts come from ([#139](https://github.com/gordonkjlee/openmemory/issues/139)) ([4602c4c](https://github.com/gordonkjlee/openmemory/commit/4602c4c9750de6f5349426ffd40c60e654cc250c))

## [0.14.0](https://github.com/gordonkjlee/openmemory/compare/v0.13.1...v0.14.0) (2026-08-10)

**Five settings that did nothing now work.** If you had set any of them, they
were silently ignored — so your store's behaviour may change on upgrade to
whatever you asked for. Check `config.json` if you have edited it.

**`intelligence.fallback` is removed.** It was written into every generated
config as `"heuristic"` and read by nothing, so removing it changes no behaviour.
An unknown key in your existing config is ignored; you can delete the line.

**The three extraction filters are now real**, and they are the only lever over
what the extractor reads:

```jsonc
"extraction": {
  "event_types": ["message"],   // stop feeding tool output to the LLM
  "roles": ["user"],            // only what you said, not what the assistant did
  "min_content_length": 10      // skip trivial events
}
```

Measure before you narrow these. In one store wired into an agentic client, the
extracted facts originated about evenly between conversation and tool output —
**10 and 8** respectively — so excluding tool results would have cost roughly
half the knowledge, despite their being 99% of the bytes. Volume and value are
not the same axis.

> **Correction.** This entry first said tool results were the source of "267 of
> 293" facts. That counted provenance *links*, not facts, and was inflated by the
> over-linking bug fixed in 0.13.1 — a handful of facts whose text recurred in
> hundreds of tool results dominated the total. The per-fact figure is the one
> above. The advice is unchanged; the evidence for it was overstated.

### Features

* **config:** make the shipped config actually do what it says ([#137](https://github.com/gordonkjlee/openmemory/issues/137)) ([9e8f7e2](https://github.com/gordonkjlee/openmemory/commit/9e8f7e296fddb1c500a45a97006d7aaa04d50f60))

  Six fields in the default config were read by no code. A setting a user can
  change with no effect is worse than a missing setting: it reads as a working
  control and stops anyone looking further. Three instances of this shape were
  found by accident this week; a new guard now checks for it deliberately —
  every value the schema permits must be written somewhere, and every field the
  shipped config declares must be read somewhere, with exemptions requiring a
  stated reason.

  `capture.default_confidence` and `consolidation.auto_link_events` reach their
  readers for the first time; the hardcoded defaults had always won.

## [0.13.1](https://github.com/gordonkjlee/openmemory/compare/v0.13.0...v0.13.1) (2026-08-10)

**Nothing you can see changes.** Same facts, same search results, same events
linked as provenance — only the label on those links is now accurate. Worth
reading if you ever inspect why a fact is believed.

### Bug Fixes

* **intelligence:** name one origin for a fact, not every repeat of it ([#135](https://github.com/gordonkjlee/openmemory/issues/135)) ([7616267](https://github.com/gordonkjlee/openmemory/commit/7616267a310b736f41791ff81805ae1c7e083311))

  A fact's provenance marked *every* event containing its text as `primary` —
  "the event that stated this". In an agentic store the same tool output recurs
  constantly, so one fact in a measured database claimed 145 separate events as
  its origin, another 129, another 97. A question with 145 answers has none.

  The earliest occurrence is now `primary` and later ones `corroborating` — a
  value the schema and types have defined from the start and no code had ever
  written. A single occurrence is still `primary`.

## [0.13.0](https://github.com/gordonkjlee/openmemory/compare/v0.12.0...v0.13.0) (2026-08-10)

**Nothing is deleted unless you ask.** This adds a command, changes no existing
behaviour, and prunes nothing on its own.

**Worth running `openmemory stats` after upgrading.** It now reports the raw event
layer beneath your facts, which nothing previously showed. If OpenMemory is wired
into an agentic client, expect that number to dwarf everything else — logged tool
output is not knowledge, but it is stored like it. A store measured in daily use
held 47,000 events and 493 MB against 21 graduated facts, all of it healthy and
none of it visible.

**`retention.session_facts_days` is gone.** It was read by no code, so removing it
changes nothing that was happening; if you set it, it never did anything. It is
replaced by `retention.prune_keep_per_session`, which defaults to null and defers
to `extraction.working_memory_size`.

### Features

* **cli:** reclaim raw events that nothing can reach ([#133](https://github.com/gordonkjlee/openmemory/issues/133)) ([9dbcd82](https://github.com/gordonkjlee/openmemory/commit/9dbcd826037b79660dd69d3ceb71c2289f7a22c5))

  ```bash
  openmemory prune                    # report only
  openmemory prune --apply --vacuum   # delete, then rebuild the file
  ```

  An event is removed only once extraction has read it, no fact's provenance cites
  it, and it has fallen outside its own session's working-memory window — which
  consolidation re-reads for pronoun resolution. Reachability rather than age: an
  event's value has nothing to do with how old it is, and a store left quiet for a
  month must not lose events it has not extracted yet.

  No fact, entity, embedding or search result is affected. On the measured store
  the rule cleared 84.7% of event content and spared everything still in use.

* **stats:** `get_stats` and `openmemory stats` report the raw event layer.

## [0.12.0](https://github.com/gordonkjlee/openmemory/compare/v0.11.0...v0.12.0) (2026-08-10)

**Only affects stores using Voyage embeddings.** If semantic search is off (the
default) or running on Ollama, nothing changes.

**If you are on Voyage, unrelated queries will now return nothing instead of your
nearest few facts.** That is the intended behaviour and it is new: Voyage shipped
in 0.11.0 without a noise floor, so `search "quantum physics"` against a store that
knows nothing about it returned whatever scored highest anyway. If you had set
`embedding.min_similarity` yourself to work around that, your value still wins —
this only supplies a default where there was none.

### Features

* **embedding:** give Voyage its own measured noise floor
  ([#131](https://github.com/gordonkjlee/openmemory/issues/131))
  ([ae31d95](https://github.com/gordonkjlee/openmemory/commit/ae31d952bf0f8064a33e549de80d4bb51810d91d))

  Cosine similarity has no natural zero, so a query your store cannot answer still
  scores every fact in it. Measured against a synthetic store, Voyage put queries
  with a real answer at 0.401–0.622 and queries about nothing at 0.124–0.252; the
  default sits at 0.30, between the two and biased towards keeping results.

  The number lives on the provider rather than in a shared constant because the
  providers genuinely differ — Voyage's noise ceiling is 0.252 against
  `nomic-embed-text`'s 0.480. It applies to the `voyage-4` family it was measured
  on; older generations get no floor rather than a number measured elsewhere.

### Documentation

* Voyage rate-limits to **3 requests per minute** until a payment method is added to
  the account. The 200M free tokens still apply once one is, so this is a signup
  step rather than a cost — but without it, embedding a large existing store
  advances a batch at a time across several consolidation runs, with nothing to
  explain the delay.

## [0.11.0](https://github.com/gordonkjlee/openmemory/compare/v0.10.0...v0.11.0) (2026-08-10)

**Upgrading changes nothing until you opt in.** Semantic search ships disabled, so
this release behaves exactly like 0.10.0 on an existing store. That is deliberate:
enabling it means choosing an embedding model, and a model is an opinion about what
"similar" means — not a choice the engine should make on your behalf.

**To turn it on**, set `embedding.provider` in `config.json` to `"ollama"` (local,
no API key) or `"voyage"` (hosted), then run `openmemory consolidate`. Facts are
embedded when they are consolidated, so an existing store fills in on its next run
rather than needing a rebuild — and `openmemory stats` now reports how far that has
got, per model.

**Pending facts stay keyword-only.** A fact is embedded at consolidation, not at
capture, so something captured minutes ago is findable by its own words but not yet
by a paraphrase of them. `search_knowledge` returns those separately and its
description says so.

### Features

* **search:** semantic search over stored embeddings, off by default
  ([#128](https://github.com/gordonkjlee/openmemory/issues/128))
  ([56f3d9d](https://github.com/gordonkjlee/openmemory/commit/56f3d9d80bbb489a02f85287dacde85cfbd2c5b2))

  `search "shellfish"` found the allergy fact and `search "food"` did not. With a
  provider configured, both do. Semantic similarity joins keyword, structured and
  entity-graph results as a fourth list in the same rank fusion — it ranks rather
  than gates, so a fact with no embedding is still found by its words.

  Vectors are stored as BLOBs and scanned exactly, with no vector extension and no
  index: the extension is a per-platform native binary, and this project has no
  native dependencies. `embedding.dimensions` is what keeps that viable as a store
  grows, since the cost of a query is bytes read rather than arithmetic.

  Every vector records the model and dimension that produced it, and every read
  filters on both — vectors from different models are not comparable, and comparing
  them would return a confident number that means nothing.

* **stats:** `get_stats` and `openmemory stats` report semantic coverage per model,
  against the current fact count. Partial coverage is otherwise silent: search keeps
  working, so a store where embedding failed halfway looks healthy while finding less
  by meaning than you would expect.

## [0.10.0](https://github.com/gordonkjlee/openmemory/compare/v0.9.0...v0.10.0) (2026-08-10)

Two of these fixes change what your existing store contains, and neither corrects
itself — facts are immutable, so nothing already stored is rewritten.

**Facts captured before this release are under-classified.** `capture_fact` was
routing everything to the default domain and extracting no entities, so anything
captured through it — the path most assistants use — has no domain and no place in
the entity graph. New captures get both. Old ones stay as they are; there is no
reprocessing pass yet.

**Conversation events skipped by a failed extraction are still in the database, but
will not be picked up automatically.** A transient model failure used to advance the
consolidation watermark past events it never read. That no longer happens, but any
events already passed over remain unread, because the watermark has moved on.

### Features

* **graph:** designate the user, and record what a fact is about ([#122](https://github.com/gordonkjlee/openmemory/issues/122)) ([910d006](https://github.com/gordonkjlee/openmemory/commit/910d0061bb4e33361cfd3740ed8374639d1865c0))
* **graph:** rank facts about a thing above facts that merely name it ([#123](https://github.com/gordonkjlee/openmemory/issues/123)) ([de4c258](https://github.com/gordonkjlee/openmemory/commit/de4c2580f73603fb38d98065dd87c1628a0e1812))
* **intelligence:** teach extraction which thing a fact is about ([#124](https://github.com/gordonkjlee/openmemory/issues/124)) ([b093a8b](https://github.com/gordonkjlee/openmemory/commit/b093a8b33924c7d2b48628f8230731e81a7e3299))


### Bug Fixes

* **deps:** clear the three open security advisories ([#119](https://github.com/gordonkjlee/openmemory/issues/119)) ([adc929d](https://github.com/gordonkjlee/openmemory/commit/adc929d467835ad6b12434ffd536655477b919d4))
* **intelligence:** give the primary capture path real intelligence ([#126](https://github.com/gordonkjlee/openmemory/issues/126)) ([44a2e8b](https://github.com/gordonkjlee/openmemory/commit/44a2e8b0dda7748e32f5012c6833751cb7484853))
* **intelligence:** stop a failed extraction discarding events for good ([#125](https://github.com/gordonkjlee/openmemory/issues/125)) ([934ea23](https://github.com/gordonkjlee/openmemory/commit/934ea2327e02f1b4e2df3e5b8a2d609e405729ac))

## [0.9.0](https://github.com/gordonkjlee/openmemory/compare/v0.8.0...v0.9.0) (2026-08-09)

Fixes three ways the documented path silently did not work. If you captured events
through the CLI or hooks, or relied on entity links in search results, this release
changes what you get.

### Features

* **cli:** `init` now reports which consolidation intelligence the store will
  actually get, instead of leaving you to discover it. The default provider shells
  out to a CLI; when that is unavailable every stage falls back to a heuristic that
  extracts no entities and does no domain routing, and nothing said so
  ([#116](https://github.com/gordonkjlee/openmemory/issues/116))

### Bug Fixes

* **cli:** events logged without a session id were never consolidated. Both session
  columns were stored null, and consolidation returns early when it cannot resolve a
  session from a batch — so those events were not merely unattributed, they were
  never read. This affected the documented manual form of `log-event`, which
  reported success while writing rows that were skipped for ever. **If you have been
  capturing via hooks or the CLI, run `openmemory consolidate` after upgrading: the
  events are still in the database and will now be processed**
  ([#116](https://github.com/gordonkjlee/openmemory/issues/116))
* **search:** search results now include the entities each fact is linked to. The
  field was always returned empty, so the entity graph was invisible to
  `search_knowledge`, to the briefing resource, and to the CLI
  ([#116](https://github.com/gordonkjlee/openmemory/issues/116))
* **tools:** `get_stats` no longer directs assistants to a read tool that was removed
  in 0.8.0, and the README no longer tells you to configure client rules that call it
  ([#116](https://github.com/gordonkjlee/openmemory/issues/116))

### Documentation

* **readme:** adds a CLI-only walkthrough that needs no MCP client, and states plainly
  what the language model the intelligence depends on is, and what you lose without it
  ([#116](https://github.com/gordonkjlee/openmemory/issues/116))

## [0.8.0](https://github.com/gordonkjlee/openmemory/compare/v0.7.0...v0.8.0) (2026-07-17)


### Features

* importance-driven retrieval; remove the domain-named read tools ([#99](https://github.com/gordonkjlee/openmemory/issues/99)) ([3eb1086](https://github.com/gordonkjlee/openmemory/commit/3eb1086d1150ef82e5bd5a8a4dc9f6f9393bda69))
* no hardcoded categories, no hardcoded rules ([#97](https://github.com/gordonkjlee/openmemory/issues/97)) ([f6aa656](https://github.com/gordonkjlee/openmemory/commit/f6aa6568b1d0f5c8e27cd61076e9c11e27446e74))
* the engine ships no vocabulary ([#96](https://github.com/gordonkjlee/openmemory/issues/96)) ([962ea84](https://github.com/gordonkjlee/openmemory/commit/962ea8448dd7f488a61c56e93e51addb75d70b97))
* **tools:** get_people becomes get_entity — retrieve any subject, not just people ([#98](https://github.com/gordonkjlee/openmemory/issues/98)) ([1cbfba0](https://github.com/gordonkjlee/openmemory/commit/1cbfba036507214de0a94ee7017e69496c2f912e))


### Bug Fixes

* **intelligence:** make importance mean something ([#95](https://github.com/gordonkjlee/openmemory/issues/95)) ([0d1ab2f](https://github.com/gordonkjlee/openmemory/commit/0d1ab2fd9faad02f8ac368ec42751dfbb88b07b6))
* **tools:** stop get_profile dropping the user's name ([#93](https://github.com/gordonkjlee/openmemory/issues/93)) ([bba394a](https://github.com/gordonkjlee/openmemory/commit/bba394a3f5d76b0744801f6b6d9462f7e5ea65d1))

## [0.7.0](https://github.com/gordonkjlee/openmemory/compare/v0.6.0...v0.7.0) (2026-07-17)


### Features

* **search:** find facts that have been captured but not yet consolidated ([#90](https://github.com/gordonkjlee/openmemory/issues/90)) ([603eadc](https://github.com/gordonkjlee/openmemory/commit/603eadc080f3fa9c308a3413ce2752bd7266d67b))

## [0.6.0](https://github.com/gordonkjlee/openmemory/compare/v0.5.0...v0.6.0) (2026-07-17)


### Features

* **cli:** add search and stats commands ([#81](https://github.com/gordonkjlee/openmemory/issues/81)) ([9196e69](https://github.com/gordonkjlee/openmemory/commit/9196e69f9fb80abbebc8115e71ff91c38a06098a))
* **intelligence:** core domain taxonomy with an open periphery ([#85](https://github.com/gordonkjlee/openmemory/issues/85)) ([692acd8](https://github.com/gordonkjlee/openmemory/commit/692acd8c699af656682d0977bec344ddb7bbd50e))
* **server:** add memory://briefing and memory://profile resources ([#79](https://github.com/gordonkjlee/openmemory/issues/79)) ([0147f29](https://github.com/gordonkjlee/openmemory/commit/0147f290efa768590f553e832eec97c19c4c13e0))
* **tools:** make every tool description say when to call it ([#88](https://github.com/gordonkjlee/openmemory/issues/88)) ([2ec0074](https://github.com/gordonkjlee/openmemory/commit/2ec0074ff8e9b2e5aca529babe55c518be6a1329))


### Bug Fixes

* **intelligence:** route the third-person facts an AI actually captures ([#84](https://github.com/gordonkjlee/openmemory/issues/84)) ([6e3b322](https://github.com/gordonkjlee/openmemory/commit/6e3b322080741e95cac1a88dcb5f6416913ba8a1))
* **search:** rank by domain instead of gating on it ([#89](https://github.com/gordonkjlee/openmemory/issues/89)) ([5b869c8](https://github.com/gordonkjlee/openmemory/commit/5b869c843e2811ed9896dfaca7204164febf290a))

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

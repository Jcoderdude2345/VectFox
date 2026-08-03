# VectFox — Findings Log

**This file is a findings log, not project instructions.**

Nothing recorded here has been fixed, deleted, or otherwise acted on. It is the
output of two read-only passes over `core/`:

1. A characterization-test pass (`tests/`, +390 tests) that pinned current
   behaviour — **including the bugs**, which are asserted as-is so the suite
   detects change without pre-judging the fix.
2. A duplication/complexity audit that fed the KISS/YAGNI refactor.

Two consequences worth internalising before touching anything below:

- **Fixing a bug in §1 or §2 requires editing its characterization test.** The
  tests assert the broken behaviour on purpose. That is expected and fine — but
  it must be a deliberate act, not a surprise.
- **Deleting anything in §3 needs a review pass first.** Several
  defensive-looking branches are deliberate tripwires;
  `tests/dead-code-deletion-contract.test.js` already protects at least one
  (the `case 'chat':` throw in `generateCollectionId`). Confirm intent before
  removing.

---

## 1. Confirmed bugs (pinned by characterization tests)

| # | Location | Problem |
|---|---|---|
| 1.1 | `core/chunking.js:240` | The `section` strategy's `if (sections.length === 0) return STRATEGIES.paragraph(...)` fallback is **unreachable**. With no headers the `while` loop never runs, so `lastIndex (0) < text.length` always pushes the whole text as one section. Header-less documents are therefore never split. Pinned by `tests/chunking.test.js` → *"returns header-less text as ONE chunk"*. |
| 1.2 | `core/eventbase-extractor.js:512` | The empty-window guard `if (!excerptText.trim())` never fires. The excerpt is built as `` `${speaker}: ${text}` ``, so a window of blank messages renders as `"A: \n\nB: "` — non-empty. Every blank window burns a full LLM call. Pinned by `tests/eventbase-extractor.test.js` → *"STILL calls the LLM for a window of empty messages"*. |
| 1.3 | `core/agentic-retrieval.js:794` (`_formatCandidateLine`) | Reads `ev.score` / `ev.vectorScore`, but `retrieveEvents` ranks with `_finalScore` — which this same module reads for its *own* debug logging at `:78`. Every candidate reaches the planner scored `—`, i.e. the planner gets no relevance signal at all. Pinned by `tests/agentic-retrieval.test.js` → *"shows pre-search candidate scores as '—'"*. |
| 1.4 | `core/corpus-stats.js:161-177` | Empty chunks `continue` past the length accumulation but still count in `items.length`, which is the divisor. `avgDocLength` is deflated and `totalDocs` (N in the IDF formula) is inflated. Pinned by `tests/corpus-stats.test.js`. |
| 1.5 | `core/emotion-classifier.js:131` | Cache key is `` `${text.substring(0, 100)}:${settings.model}` ``. Two defects: long texts sharing a 100-char prefix collide, and a per-call `options.model` override is stored under the *settings* model's key, poisoning later default-model lookups. Pinned by `tests/emotion-classifier.test.js`. |
| 1.6 | `core/png-export.js:621` | `isVectFoxPNG` is documented `Promise<boolean>` but `data !== null && (data.generator === 'VectFox' \|\| data.version)` short-circuits to the **version string** or `undefined`. Truthy/falsy so `if` callers work; `=== true` would fail. |
| 1.7 | `core/png-export.js:529` | `embedDataInPNG` has no replace-existing logic. Re-exporting through an already-embedded PNG **appends a second `zTXt` chunk**, and `extractDataFromPNG` returns the *stale first* payload. |
| 1.8 | `core/prompts-i18n.js:337, 446, 734` | `_PROMPTS[mode] ?? _PROMPTS.intl` — a prototype-chain key such as `'toString'` resolves to `Object.prototype.toString`, which is not nullish, so the fallback is skipped and a **function** is returned where a prompt string is expected. Unreachable from the settings UI, but latent. ⚠️ Any rewrite to `Map` or `hasOwnProperty` breaks the pinning test. |
| 1.9 | `core/eventbase-extractor.js:318` (`_inferLanguageHint`) | Kana is **double-counted**: the `　-鿿` range already covers hiragana (`぀-ゟ`) and katakana (`゠-ヿ`), then `hiragana` is added to `cjk` again. Skews the Japanese/Chinese language-hint decision. |
| 1.10 | `core/collection-loader.js:785` | The purge path sends `collection.backend \|\| 'standard'` **without** the `standard`→`vectra` remap that every other plugin call site applies — so a purge likely targets a backend name the plugin does not know. Note the file already imports `getRegistryBackend` at line 31 and never calls it. |

### 1.11 — Three mutually incompatible "is this CJK?" definitions

The same question gets three different answers depending on which module asks:

| Location | Denominator | Threshold |
|---|---|---|
| `core/summarizer.js:179` | `text.length` | `> 0.1` → CJK token budget |
| `core/eventbase-extractor.js:302` (`_detectScript`) | `cjk + latin` | `> 0.6` cjk / `< 0.2` latin |
| `core/eventbase-extractor.js:318` (`_inferLanguageHint`) | `cjk + latin` | `< 0.15` → no hint |

Character ranges differ too — see §4.1.

---

## 2. Smaller correctness / clarity defects

- **`core/eventbase-store.js:825`** — docstring is factually wrong. It claims the
  hash "uses the same djb2 algorithm as bm25-scorer.js / chat-vectorization.js".
  `bm25-scorer.js` contains **no hash function at all**, and
  `chat-vectorization.js` delegates to ST's `getStringHash`. The `h1` lane does
  match `_simpleHash`, but the packed 53-bit return value does not.
- **`core/collection-export.js:573`** — `backendName === 'standard' ? 'vectra' : backendName`
  sits inside an `else` branch where `standard` has already been excluded. The
  true arm is provably dead.
- **`core/agentic-retrieval.js:359`** — `else { throw new Error(\`Unknown provider\`) }`
  in `_callPlanner` is unreachable; `_resolveAgenticLLMConfig` already rejected
  unknown providers before the call.
- **`core/summarizer.js:215`** — `_callOpenRouter(prompt, model, settings, originalLength, maxTokens, timeoutMs)`:
  `originalLength` is used only by a commented-out log line, and no caller ever
  passes `timeoutMs`, so the 30s default is unconditional.
- **`core/api-keys.js:173, 189`** — `getOpenRouterApiKey(settings)` and
  `getCustomApiKey(settings)` accept a `settings` argument their own JSDoc says
  is "kept for signature compat; not read". Both bodies ignore it entirely.
- **Redundant `String()` coercions** in `core/chunking.js:89, 287, 290`, applied
  to values a preceding `typeof x === 'string'` check already resolved.
- **Pointless local aliases** (`const a = b;` with `b` already in scope):
  `core/eventbase-workflow.js:633, 668`, `core/content-vectorization.js:839`,
  `core/eventbase-extractor.js:531`, `core/collection-loader.js:1118`.
- **14 empty `catch {}` blocks** in `core/`, most wrapping `toastr.*` calls that
  do not throw: `content-vectorization.js:271, 313, 314, 326, 327`,
  `eventbase-workflow.js:162, 460, 492`, `world-info-integration.js:227`,
  `model-config-notifier.js:68`, `collection-loader.js:200`, `api-keys.js:562`,
  `lorebook-rename-detector.js:49`, `tokenizer-lock.js:222`.

---

## 3. Dead code — flagged, NOT deleted

### 3.1 Dead provider paths (~350 lines, highest-value cleanup)

`core/providers.js:19-70` now defines exactly four providers — `transformers`,
`ollama`, `vllm`, `openrouter`. Every other provider ID is commented out, so
anything gated on one is unreachable:

- `core/core-vector-api.js` private functions, reachable only from dead branches:
  `createWebLlmEmbeddings:456` (~38 lines), `createKoboldCppEmbeddings:494`
  (93 lines), `createBananaBreadEmbeddings:595` (~81 lines),
  `streamEmbeddingsAndWrite:1051` (81 lines).
- Three copies of `const clientSideEmbeddingSources = ['webllm','koboldcpp','bananabread'];`
  and their `if` blocks — `:833`/`:836-848`, `:1191`/`:1195-1210`, `:1378`/`:1381-1392`.
- `core/core-vector-api.js:693` (`vertexai`), `:713-714` (`koboldcpp`/`llamacpp`
  in `textgenMapping`), `:732` (`extras`), `:737` (`webllm`), `:859`
  (dead members of `localGpuSources`).
- `core/chat-vectorization.js:145-200` `rerankWithBananaBread` (~56 lines) and
  its only call site at `:1452`. Note `core/api-keys.js:533-539` explicitly
  *deletes* `bananabread_api_key` from settings on migration.
- `core/core-vector-api.js:439-446` `getAdditionalArgs` — a `switch` whose every
  case is commented out; it unconditionally returns `{}`. Four `await` sites
  depend on it; three are themselves in dead branches.
- `'http://localhost:8008'` hardcoded at `chat-vectorization.js:155`,
  `core-vector-api.js:616`, `backends/standard.js:90`,
  `diagnostics/infrastructure.js:40, 879`, `diagnostics/production-tests.js:152`.

⚠️ Before deleting: confirm these are not intentional tripwires for
partially-removed providers.

### 3.2 Exports with zero importers repo-wide

`api-keys.js:201 getVllmApiKey` (`@deprecated`, **zero** references anywhere,
including tests) · `collection-export.js:263 exportMultipleCollections` (115
lines) · `collection-export.js:889 importMultipleCollections` ·
`collection-metadata.js:276 getAllCollectionMeta` · `collection-metadata.js:958
recordCollectionUsage` ("called when a collection is queried" — it is not) ·
`eventbase-store.js:256 listEvents` · `eventbase-store.js:273 deleteEventByHash` ·
`providers.js:149 getCloudProviders` · `content-types.js:162 strategyNeedsBatchSize` ·
`collection-ids.js:23 VF_PREFIX` · `eventbase-schema.js:272 DEFAULT_EXTRACTION_PROMPT`
(superseded by `prompts-i18n.js`) · `stop-words.js:229 CJK_STOP_WORD_SET` ·
`query-keyword-extractor.js:16 DEFAULT_RETRIEVAL_KEYWORD_LEVEL` · and six unused
`constants.js` values: `EXTENSION_NAME`, `SENTENCE_SEARCH_WINDOW`,
`DEFAULT_RECENCY_THRESHOLD`, `DEFAULT_SCORE_THRESHOLD`, `DEFAULT_INSERT_COUNT`,
`DEFAULT_QUERY_COUNT`, `DEFAULT_PROTECT_COUNT`.

### 3.3 Transitively dead

`chunking.js:470 isUnitStrategy` and `core-vector-api.js:1495 queryActiveCollections`
(~40 lines) — their only importer is an **unused** import statement in
`chat-vectorization.js` (`:15`, `:18`). Remove the unused imports and these
become §3.2 entries.

### 3.4 Dead default-export barrel

`core/conditional-activation.js:1245` is the only `export default` in `core/`,
and nothing default-imports it (all three consumers use named imports). The
barrel and these members are unreachable: `recheckExpressionsExtension:78`,
`buildChunkContext:972`, `groupChunksByConditionStatus:987`,
`validateConditions:1175`, `getConditionStats:1212`. Note `validateConditionRule:1021`
**is** live — do not confuse the two.

### 3.5 Test-only production surface

`core/collection-metadata.js:781-940` "LOCK FACADE" — `getLock` has zero callers
anywhere; `setLock` only `tests/Eventbase-test.spec.js`. Production calls the
underlying `setCollectionLock` / `removeCollectionLock` directly
(`eventbase-workflow.js:78`).

`core/emotion-classifier.js` has no internal consumers at all — its only
production surface is the `window.VectFoxEmotionClassifier` assignment at
`:330`. It is an **external API for the Cotton-Tales extension**, not internal
code. Do not delete it as unused.

### 3.6 Over-exported (drop `export`, keep the function)

Used inside their own file, imported by nobody: `collection-export.js:59
EXPORT_FILE_EXTENSION` · `collection-ids.js:41 COLLECTION_TYPES`, `:64
COLLECTION_SCOPES`, `:76 KNOWN_BACKEND_LABELS` · `collection-loader.js:60
getCollectionFilterReason`, `:360 cleanupCollectionRegistry` ·
`collection-metadata.js:855 getLock` · `eventbase-store.js:60 clearVectorizationTip`,
`:402 getLastUsedWindowSize` · `eventbase-workflow.js:1150 isChatFullyVectorized` ·
`lorebook-invalidation.js:34 REINDEX_DEBOUNCE_MS` · `stop-words.js:112, 130, 151,
159, 231` · `tokenizer-lock.js:36 fetchCollectionMetadata` ·
`wiki-library-service.js:105 ensureIndexLoaded`.

### 3.7 Unused imports (29)

Lowest-risk deletion available — an unused import cannot change behaviour.
Two are load-bearing *evidence* for other findings, so keep this list even
after removing them: `collection-loader.js:31` documents bug 1.10, and the
`chat-vectorization.js` entries are what make §3.3 dead.

```
core/chat-vectorization.js:12    chat_metadata
core/chat-vectorization.js:15    isUnitStrategy
core/chat-vectorization.js:17    cleanText
core/chat-vectorization.js:18    insertVectorItems, queryActiveCollections, deleteVectorItems
core/chat-vectorization.js:26    registerCollection
core/chat-vectorization.js:27    setCollectionLock
core/collection-export.js:20     extension_settings
core/collection-export.js:23     getAllChunkMetadata
core/collection-export.js:32     getCollectionRegistry
core/collection-export.js:36     COLLECTION_PREFIXES, parseCollectionId
core/collection-loader.js:15     queryCollection
core/collection-loader.js:31     getRegistryBackend
core/collection-metadata.js:14   COLLECTION_PREFIXES
core/content-vectorization.js:13 hasFeature
core/content-vectorization.js:20 COLLECTION_PREFIXES
core/content-vectorization.js:28 extractChatKeywords, EXTRACTION_LEVELS,
                                 DEFAULT_EXTRACTION_LEVEL, DEFAULT_BASE_WEIGHT
core/core-vector-api.js:38       parseRegistryKey
core/core-vector-api.js:39       getUrlProviders
core/core-vector-api.js:118      RATE_LIMIT_CALLS, RATE_LIMIT_WINDOW_MS
core/corpus-stats.js:30          extension_settings
core/eventbase-extractor.js:17   EVENT_TYPES, buildEmbedText
```

### 3.8 Outside `core/`

- **`utils/string-utils.js`** — 20 of 25 methods have zero callers repo-wide.
  Only `escapeHtml`, `decodeHtmlEntities`, `stripHtml`, `stripMarkdown`,
  `similarity` are used. Notably `truncate` and `slugify` are unused *while*
  `core/` hand-rolls both idioms in ~40 places (§4.4).
- **`utils/async-utils.js`** — `cancelable`, `debounceAsync`, `queue`, `series`,
  `throttleAsync` have zero callers.
- **`utils/vector-distance.js:662 Utils.topK`** — zero callers, while `core/`
  hand-rolls sort-then-slice 15 times (§4.5).
- **`utils/data-structures.js SetOps.union`** — unused, while
  `core/reformat-extractor.js:635 _unionStrings` reimplements it.

### 3.9 Commented-out code

`core/summarizer.js:141-142` and `:279-280` — `// don't remove` above commented
`log.verbose` calls (the second has a trailing space). ·
`core/core-vector-api.js:415-424` (10 commented `switch` cases) and `:442-444`
(3 more) · `core/providers.js` — 13 commented provider entries ·
`core/keyword-boost.js:82-84` — `//const SUMMARY_BALANCED_HEADER_SIZE = 1600;`
with the note *"for some reason, bigger value speed up retrival"* above the
live `= 5000` · plus ~20 single-line remnants across the folder.

---

## 4. Duplication left in place (deliberately)

The refactor removed duplication that was safe and uncontested. What remains,
and why:

### 4.1 The four LLM feature modules

`summarizer.js`, `eventbase-extractor.js`, `reformat-extractor.js` and
`agentic-retrieval.js` share `core/llm-transport.js` for the HTTP envelope,
error read, and reply extraction — but keep **separate** error classes, config
resolvers, prompts, schemas, and JSON-repair parsers.

That is intentional, per the codebase's own stated requirement:

> *"this feature must stand on its own so a bug or schema change in chat's
> EventBase pipeline can never affect Document/Wiki/URL reformatting, and vice
> versa."* — `core/reformat-schema.js:11-16`

> *"schema-adapted duplicate of eventbase-extractor.js's `_parseJsonArray` …
> Not imported, per independence requirement."* — `core/reformat-extractor.js:242-245`

**The cost, quantified:** `eventbase-extractor.js:127-236 _parseJsonArray` and
`reformat-extractor.js:255-345 _parseReformatArray` are the same four-stage
algorithm (fence strip → direct parse → NDJSON → balanced-bracket scan →
object-stream fallback) in the same order **with the same comments**, differing
only in the error class and the final shape predicate. ~95 lines × 2.

Also still separate: three fatal-error classes with an identical
`(message, code)` shape — `SummarizationFatalError` (plus a `provider` field),
`EventBaseFatalError`, `ReformatFatalError` — and three config resolvers with
the identical `feature_* || summarize_* || default` cascade
(`summarizer.js:59`, `agentic-retrieval.js:284`, `reformat-extractor.js:60-70`).

Revisit only as a deliberate decision to trade isolation for less code.

### 4.2 CJK character ranges — three incompatible sets

`core/script-segmentation.js:21` is the canonical, widest definition
(Han + Kana + Hangul + Thai + Lao + Myanmar + Khmer) but only
`bm25-scorer.js` and `query-keyword-extractor.js` import it.

- `core/keyword-boost.js:86` declares its **own** `CJK_CHAR_RE` — a *name
  collision* with `script-segmentation.js`'s export, with a different range set
  (Han + Kana, **no Hangul**).
- `core/summarizer.js:179` and `core/eventbase-extractor.js:302, 318` use a
  third set starting at `　` (swallowing CJK punctuation).

Not unified because the range sets genuinely differ — sharing would change
tokenisation and retrieval scoring. Any consolidation needs its own
before/after retrieval-quality comparison.

### 4.3 `corpus-stats.js:44 _pluginBackendName`

A verbatim re-implementation of `collection-ids.js:163 getRegistryBackend`.
**Blocked by a test constraint, not by preference:** `collection-ids.js` imports
`getCurrentChatId` and `chat_metadata` from ST's `script.js`, but
`tests/corpus-stats.test.js` mocks that module with only `getRequestHeaders`, so
the import would fail at module load. Fixing this means either moving
`getRegistryBackend` to a zero-import leaf, or widening the test mock.

### 4.4 / 4.5 Small idioms with many copies

- **Hashing** — `eventbase-extractor.js:640 _simpleHash` and
  `eventbase-workflow.js:1129 _djb2` are byte-identical and produce identical
  values. Kept apart deliberately: *"kept local to avoid circular dep"*
  (`eventbase-workflow.js:1125`). Two further, incompatible hashes exist:
  `eventbase-store.js:846 _eventHash` (53-bit, two-lane) and
  `sparse-vector-encoder.js:30 hashToken` (FNV-1a).
- **Truncate-with-ellipsis** — ~40 inline sites, 4 different caps, while
  `StringUtils.truncate` sits unused (§3.8). Also two *different* orderings of
  the same snippet builder: `eventbase-store.js:135` slices **then** normalises
  whitespace; `eventbase-retrieval.js:268` and `prompts-i18n.js:798` normalise
  **then** slice — different output near the boundary.
- **Clamp** — 17 `Math.max(a, Math.min(b, x))` sites with no helper. Four are
  the same "clamp importance to 1-10" rule spelled four different ways
  (`agentic-retrieval.js:493`, `eventbase-schema.js:142`,
  `content-vectorization.js:958`, `reformat-schema.js:255`), differing in
  whether `Math.round` runs inside or outside.
  `eventbase-workflow.js:93` and `:1152` are byte-identical.
- **Sort-by-score-desc** — 15 comparators, six of them the literal string
  `(a, b) => b.score - a.score`.
- **Settings access** — 85 direct `extension_settings.vectfox` reads, no
  accessor, under four different local names (`vf`, `store`, `VectFoxSettings`,
  `vhSettings`) with inconsistent optional chaining
  (`eventbase-store.js:531` omits `?.` where its three siblings use it).
- **`/api/plugins/similharity/`** — string-concatenated at ~20 sites with no
  shared constant. The `/chunks/list` request envelope specifically is built
  four times (`core-vector-api.js:788`, `corpus-stats.js:128`,
  `collection-export.js:80`, `backends/standard.js:936`).
- **Same-name constants, different values** — `DEFAULT_MAX_TOKENS` is 768 /
  4096 / 16000 in `summarizer.js` / `eventbase-extractor.js` /
  `reformat-extractor.js`; `DEFAULT_TIMEOUT_MS` is 30000 / 60000 / 90000 in the
  same three. Meanwhile `constants.js` already exports `API_TIMEOUT_MS = 30000`
  and `VECTOR_LIST_LIMIT = 10000`, which those modules re-declare locally.
- **Collection prefixes** — canonical in `collection-ids.js:33-37
  COLLECTION_PREFIXES`, but bypassed by string literals at
  `world-info-integration.js:250, 410`, `lorebook-invalidation.js:65`,
  `eventbase-workflow.js:1196`, `ui/ui-manager.js:1837` — while
  `COLLECTION_PREFIXES` is imported-and-unused in three files (§3.7).

---

## 5. Complexity inventory (not refactored)

Decomposing these is a behaviour-risk exercise that needs its own plan and its
own tests. Recorded so the leverage is known:

| Lines | Location | Why it is hard |
|---|---|---|
| 756 | `eventbase-workflow.js:60` `runEventBaseIngestion` | 61% of its own file. Marker load, window sizing, extraction, batching, retry-with-verification, progress, toastr, abort, post-insert count check. Nested retry loops at `:460`/`:492`, dynamic imports mid-body at `:199`/`:802`. |
| 376 | `eventbase-retrieval.js:325` `retrieveEvents` | Long linear pipeline: fan-out → dedup → RRF → rerank → trim. |
| 322 | `chat-vectorization.js:1239` `rearrangeChat` | Numbered STAGE 1-8.5 in one body, 5+ dynamic imports, a `dryRun`/`testMessage` test-only mode, `debugData` threading, plus the dead BananaBread stage (§3.1). |
| 322 | `content-vectorization.js:65` `vectorizeContent` | Dispatch + prepare + chunk + enrich + insert + register, with six `try{}catch(_){}` toastr wrappers. |
| 263 | `api-keys.js:306` `migrateLegacyApiKeys` | One-shot migration, long per-slot if/else. Inherently transient — a strong deletion candidate once migration is assumed complete. |
| 253 | `collection-export.js:628` `importCollection` | Sibling `importCollectionSilent:938` (144 lines) duplicates much of it. |
| 239 | `wiki-search-index.js:64` `createWikiIndex` | 79% of its file. |
| 212 | `core-vector-api.js:829` `insertVectorItems` | Five orthogonal concerns interleaved; the client-side half is dead (§3.1). |

`collection-metadata.js` (1255 lines) and `conditional-activation.js` (1270)
are **not** on this list — they are long files of many small functions. Their
problem is breadth (~40 exported accessors; 11 condition evaluators plus a dead
barrel), not depth.

### Pre-existing extension point

`core/log.js:67` — `log.domain(name, level, ...args)` accepts a `level`
parameter its own docstring calls *"metadata for future sub-gating; ignored for
now"*. It is passed at **53 call sites** and read nowhere. Removing it is a
pure-churn, zero-behaviour-change edit that deserves its own commit.

---

## 6. Do not touch

`core/vendor/` is third-party with provenance headers and is excluded from every
count above:

- `tiny-segmenter-0.2.0.js` — TinySegmenter 0.1, © 2008 Taku Kudo, new-BSD.
  Verbatim upstream. Imported by `bm25-scorer.js:19`.
- `wikitext2plaintext.js` — v0.1.0, MIT. Header documents exactly two VectFox
  modifications (CJS→ESM, `he.decode` → `StringUtils.decodeHtmlEntities`).
- `jieba/` — `wasm-bindgen` glue + 4 MB WASM + 4 MB dict, loaded dynamically at
  `bm25-scorer.js:44-46, 134`. The `console.warn('using deprecated parameters…')`
  lines at `jieba_rs_wasm.js:392, 417` are upstream boilerplate, not dead code.

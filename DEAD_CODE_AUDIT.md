# Repository dead-code audit

Date: 2026-09-05. Commit: 73e41eba9c460944c4b36e7c4dbd8c7438fe5ccd. Working tree was clean at the start.

## Conclusion

There is substantial removable code. The strongest candidates are seven private functions (600 lines of function bodies, including their internal comments/whitespace), 70 unused import bindings, two unreferenced utility modules (about 1,309 lines), and an obsolete settings template. Removal of these has no identified current application caller to disrupt, subject to preserving module initialization when changing imports.

The strong candidates were removed after this audit, as requested. The findings and line numbers below describe the pre-removal snapshot. Exported APIs, test-only utilities, and provider branches outside the strong-candidate group remain deferred.

## Removal completed

- Removed all seven listed private functions, their associated documentation, the two unused utility files, and ui/settings.html.
- Removed the 70 listed import bindings plus API_TIMEOUT_MS in core/core-vector-api.js and getModelField in diagnostics/production-tests.js, which became unused after deleting the functions.
- Preserved every modified module's import sources and order, using side-effect imports where the last binding was removed. Removed commented dispatch references to the deleted embedding helpers.
- Compared the remaining executable AST against HEAD for all 19 modified JavaScript files: unchanged apart from the specified functions/import bindings. Parsed all 140 remaining tracked JavaScript/MJS files successfully. The same conservative scan reported no remaining unused import bindings.
- Post-removal validation: **46 test files passed, 1,470 tests passed**; git diff --check passed. No tests were changed or deleted. Live SillyTavern/Playwright checks were not run.

## Scope and evidence

- Inventoried all 297 tracked files; parsed all 142 JavaScript/MJS files with the installed Babel parser, with zero parse errors.
- Built a static/literal dynamic import graph from manifest entry point index.js; searched production and test references separately. Checked manifest hooks, global APIs, nonliteral imports, CSS imports, HTML, assets, CLI scripts, configuration, and documentation references.
- Used AST identifier counts to flag unused imports/private functions and repository-wide symbol searches to qualify export candidates. This is conservative candidate analysis, not a full JavaScript control-flow or scope-aware linter. Common names, aliases, object escapes, reflection, and third-party callers limit what it can prove.
- Dependencies, generated artifacts, local ignored notes, and vendored internals were not treated as application code to prune. Vendored asset entry points were checked.
- Compared the older CLAUDE.md findings log against current source rather than assuming its claims still apply.
- Baseline validation: npm test -- --reporter=dot: **46 test files passed, 1,470 tests passed**, 12.85 seconds. Initial sandbox startup failed because esbuild could not traverse a parent directory; the authorized rerun outside the sandbox passed.
- Playwright/live SillyTavern tests were not run. They target a configured external instance and share its state. No browser/provider integration validation is claimed; post-removal unit and static validation is recorded above.

## High-confidence private-function removals

Each function below has no executable identifier reference beyond its declaration. No callback registration, export, global exposure, or string-based invocation was found. Comments and historical plans are not callers.

| File and line | Function | Function lines | Assessment |
|---|---|---:|---|
| core/core-vector-api.js:456 | createWebLlmEmbeddings | 29 | Remove; its dispatch case is commented out. |
| core/core-vector-api.js:494 | createKoboldCppEmbeddings | 93 | Remove; its dispatch case is commented out. |
| core/core-vector-api.js:595 | createBananaBreadEmbeddings | 81 | Remove; its dispatch case is commented out. |
| diagnostics/production-tests.js:119 | getProviderBody | 20 | Remove; no caller. |
| ui/chunk-visualizer.js:264 | discardAllChanges | 13 | Remove; no handler references it. |
| ui/chunk-visualizer.js:1351 | openTextEditor | 82 | Remove; no handler opens this modal. Current chunk editing has separate code. |
| ui/ui-manager.js:2026 | showAutoSyncConfirmModal | 182 | Remove from current runtime; historical plan mentions it, but current code never invokes it. |

Removing these bodies does not require removing related live providers, editing paths, or backend functions. Re-scan dependencies afterward: a helper may have other callers elsewhere.

## Unreferenced files and test-only modules

| File | Assessment |
|---|---|
| utils/dom-utils.js | Approximately 803 lines. No production/test import, loader reference, or global registration found. Strong whole-file removal candidate. |
| utils/storage-manager.js | Approximately 506 lines. No production/test import, loader reference, or global registration found. Strong whole-file removal candidate. Removing this unused module does not delete stored user data. |
| ui/settings.html | No loader/reference found. Current settings UI is generated by renderSettings in ui/ui-manager.js:51; manifest loads index.js/vectfox.css and does not name this template. Strong obsolete-template candidate. |
| utils/vector-distance.js | Approximately 688 lines, imported by tests/vector-distance.test.js only. Safe for current application runtime, but deleting it alone breaks the suite. Retire its tests with it only if this standalone API is intentionally retired. |

No other production JS file was disconnected from the conservative import graph after accounting for Jieba's URL-based loader. Graph reachability means a file is loaded, not that all its exports execute.

## Unused import bindings (70)

Remove the listed bindings, **not automatically the entire import statement**. ES modules can initialize globals/register hooks at load time. If the last binding is removed, retain a side-effect import unless module initialization is separately proven unnecessary. This corrects the old log's blanket claim that deleting unused imports cannot change behavior.

| File | Unused bindings |
|---|---|
| backends/standard.js | `VECTOR_LIST_LIMIT` (line 32) |
| core/chat-vectorization.js | `chat_metadata` (line 12), `isUnitStrategy` (line 15), `cleanText` (line 17), `insertVectorItems` (line 20), `queryActiveCollections` (line 22), `deleteVectorItems` (line 23), `registerCollection` (line 26), `setCollectionLock` (line 27), `Queue` (line 33) |
| core/collection-export.js | `extension_settings` (line 20), `getAllChunkMetadata` (line 28), `getCollectionRegistry` (line 34), `COLLECTION_PREFIXES` (line 36), `parseCollectionId` (line 36) |
| core/collection-loader.js | `queryCollection` (line 15), `deleteCollectionMeta` (line 22), `getRegistryBackend` (line 37) |
| core/collection-metadata.js | `COLLECTION_PREFIXES` (line 14) |
| core/content-vectorization.js | `hasFeature` (line 13), `COLLECTION_PREFIXES` (line 24), `extractChatKeywords` (line 28), `EXTRACTION_LEVELS` (line 28), `DEFAULT_EXTRACTION_LEVEL` (line 28), `DEFAULT_BASE_WEIGHT` (line 28), `cleanText` (line 29) |
| core/core-vector-api.js | `extension_settings` (line 26), `oai_settings` (line 34), `parseRegistryKey` (line 38), `getUrlProviders` (line 46), `RATE_LIMIT_CALLS` (line 119), `RATE_LIMIT_WINDOW_MS` (line 120) |
| core/corpus-stats.js | `extension_settings` (line 30) |
| core/eventbase-extractor.js | `EVENT_TYPES` (line 18), `buildEmbedText` (line 22) |
| core/summarizer.js | `log` (line 23) |
| diagnostics/configuration.js | `getSavedHashes` (line 12) |
| diagnostics/infrastructure.js | `EMBEDDING_PROVIDERS` (line 16), `getValidProviderIds` (line 17), `getUrlProviders` (line 25) |
| diagnostics/production-tests.js | `getProviderConfig` (line 15) |
| diagnostics/visualizer-tests.js | `queryCollection` (line 17) |
| index.js | `purgeAllVectorIndexes` (line 27), `purgeVectorIndex` (line 27), `clearCollectionRegistry` (line 29) |
| ui/chunk-visualizer.js | `getContext` (line 26), `eventSource` (line 27) |
| ui/content-vectorizer.js | `CONTENT_TYPES` (line 14), `CHUNKING_STRATEGIES` (line 15), `strategyNeedsSize` (line 20), `strategyNeedsOverlap` (line 21), `SCOPE_OPTIONS` (line 24), `regexFromString` (line 44) |
| ui/database-browser.js | `registerCollection` (line 16), `unregisterCollection` (line 17), `purgeVectorIndex` (line 26), `deleteCollectionMeta` (line 32), `setCollectionTriggers` (line 36), `isCollectionEnabled` (line 40), `getCollectionLock` (line 42), `clearCollectionLock` (line 46), `clearCollectionCharacterLocks` (line 53), `queryCollection` (line 68), `isVectFoxPNG` (line 84) |
| ui/ui-manager.js | `secret_state` (line 15), `openVisualizer` (line 24), `openSearchDebugModal` (line 27), `getLastSearchDebug` (line 27), `doesChatHaveVectors` (line 32), `getChunkingStrategies` (line 36) |

## Export candidates with no production references

The following declarations have only one AST identifier occurrence in their own file and no symbol mention in other production JS files. These are **candidates**, not unconditional public-API deletion approval. The table records test references; check external consumers before removing exported contracts. onUpdate is excluded because manifest.json explicitly registers it.

| File:line | Export | Test consumers / condition |
|---|---|---|
| backends/backend-manager.js:489 | getAvailableBackends | tests/backend-manager.test.js |
| core/api-keys.js:201 | getVllmApiKey | None found; no in-repo runtime consumer |
| core/chunking.js:463 | getAvailableStrategies | tests/chunking.test.js |
| core/chunking.js:477 | getChatStrategies | tests/chunking.test.js |
| core/collection-export.js:263 | exportMultipleCollections | None found; no in-repo runtime consumer |
| core/collection-export.js:889 | importMultipleCollections | None found; no in-repo runtime consumer |
| core/collection-ids.js:23 | VF_PREFIX | None found; no in-repo runtime consumer |
| core/collection-metadata.js:276 | getAllCollectionMeta | None found; no in-repo runtime consumer |
| core/collection-metadata.js:855 | getLock | None found; no in-repo runtime consumer |
| core/collection-metadata.js:901 | setLock | tests/Eventbase-test.spec.js |
| core/collection-metadata.js:958 | recordCollectionUsage | None found; no in-repo runtime consumer |
| core/constants.js:24 | EXTENSION_NAME | None found; no in-repo runtime consumer |
| core/constants.js:91 | SENTENCE_SEARCH_WINDOW | None found; no in-repo runtime consumer |
| core/constants.js:98 | DEFAULT_RECENCY_THRESHOLD | None found; no in-repo runtime consumer |
| core/constants.js:105 | DEFAULT_SCORE_THRESHOLD | None found; no in-repo runtime consumer |
| core/constants.js:108 | DEFAULT_INSERT_COUNT | None found; no in-repo runtime consumer |
| core/constants.js:111 | DEFAULT_QUERY_COUNT | None found; no in-repo runtime consumer |
| core/constants.js:114 | DEFAULT_PROTECT_COUNT | None found; no in-repo runtime consumer |
| core/content-types.js:162 | strategyNeedsBatchSize | None found; no in-repo runtime consumer |
| core/content-vectorization.js:1039 | deleteContentCollection | tests/Eventbase-test.spec.js |
| core/core-vector-api.js:392 | getVectorsRequestBody | None found; no in-repo runtime consumer |
| core/core-vector-api.js:681 | throwIfSourceInvalid | None found; no in-repo runtime consumer |
| core/emotion-classifier.js:84 | isCottonTalesUsingVectFox | tests/emotion-classifier.test.js |
| core/eventbase-schema.js:272 | DEFAULT_EXTRACTION_PROMPT | None found; no in-repo runtime consumer |
| core/eventbase-store.js:256 | listEvents | None found; no in-repo runtime consumer |
| core/eventbase-store.js:273 | deleteEventByHash | None found; no in-repo runtime consumer |
| core/keyword-boost.js:502 | extractTextKeywordsSimple | tests/keyword-boost.test.js |
| core/lorebook-invalidation.js:181 | _clearPendingInvalidations | tests/lorebook-handshake.test.js |
| core/model-config-notifier.js:45 | resetInvalidModelNotifications | tests/model-config-notifier.test.js |
| core/providers.js:149 | getCloudProviders | None found; no in-repo runtime consumer |
| core/query-keyword-extractor.js:16 | DEFAULT_RETRIEVAL_KEYWORD_LEVEL | None found; no in-repo runtime consumer |
| core/reformat-schema.js:56 | REFORMAT_HIERARCHY_REL_TYPES | tests/reformat-schema.test.js |
| core/reformat-store.js:215 | deleteReformatCache | tests/reformat-store.test.js |
| core/stop-words.js:229 | CJK_STOP_WORD_SET | None found; no in-repo runtime consumer |
| core/summarizer.js:90 | getSummarizationConfigFingerprint | tests/summarizer.test.js |
| core/summarizer.js:114 | DEFAULT_SUMMARIZE_PROMPT | tests/summarizer.test.js |
| core/summarizer.js:276 | buildVllmChatCompletionsUrl | tests/summarizer.test.js |
| core/text-cleaning.js:790 | toggleBuiltinPattern | tests/text-cleaning-caching.test.js |
| core/tokenizer-lock.js:65 | invalidateCollectionMetadata | tests/backends.test.js |
| core/wiki-library-service.js:354 | startEnumeration | tests/wiki-library-service.test.js |
| core/wiki-library-store.js:347 | getPage | tests/wiki-library-service.test.js, tests/wiki-library-store.test.js |
| core/wiki-library-store.js:533 | _deleteDatabaseForTests | tests/wiki-library-service.test.js, tests/wiki-library-store.test.js |
| diagnostics/activation-tests.js:194 | testActivationTriggers | None found; no in-repo runtime consumer |
| diagnostics/configuration.js:200 | checkVisualizerApiReadiness | None found; no in-repo runtime consumer |
| diagnostics/index.js:272 | getFixSuggestion | None found; no in-repo runtime consumer |
| diagnostics/index.js:317 | executeFixAction | None found; no in-repo runtime consumer |
| ui/health-dashboard.js:365 | getHealthDashboardStyles | None found; no in-repo runtime consumer |
| ui/search-debug.js:168 | getQueryHistory | None found; no in-repo runtime consumer |
| ui/ui-manager.js:5234 | hideDiagnosticsResults | None found; no in-repo runtime consumer |

Additional related findings:

- core/chunking.js:isUnitStrategy and core/core-vector-api.js:queryActiveCollections have only unused production imports. Remove the imports first, then assess deletion of the exports together.
- core/conditional-activation.js's default-export object has no default/namespace consumer found. Its buildChunkContext, groupChunksByConditionStatus, validateConditions, getConditionStats, and recheckExpressionsExtension members have no application caller beyond that object. Remove the unused object and those members as one cleanup; retain live named exports, especially validateConditionRule.
- getAdditionalArgs in core/core-vector-api.js returns an empty object because all switch cases are commented out. It still has callers. Its body can be simplified; eliminating its calls requires preserving asynchronous sequencing/error behavior and checking each caller.
- throwIfSourceInvalid is itself uncalled. Its existence does not establish that active vector operations validate providers. Decide whether to wire it into the runtime or retire it; do not rely on it as a safety prerequisite for deleting provider branches.
- diagnostics/index.js:executeFixAction is uncalled and contains a dynamic import of missing ui/ui-settings.js. Removing the unused action dispatcher is reasonable; connecting it to a UI without fixing that import would introduce a failure.
- getHealthDashboardStyles is an unused CSS-string generator. Keep the separately imported ui/health-dashboard.css and live dashboard rendering.
- Over-exported internally live functions/constants are not dead bodies. Examples: EXPORT_FILE_EXTENSION, COLLECTION_TYPES, COLLECTION_SCOPES, diagnostics visualizer checks, and close-modal handlers. Narrowing their exports is optional API cleanup.

## Utility members

- StringUtils has five directly used production methods: escapeHtml, decodeHtmlEntities, stripHtml, stripMarkdown, similarity. **Keep levenshtein too**: similarity calls this.levenshtein. The other 19 methods have no direct production/test consumers found: truncate, toCamelCase, toSnakeCase, toKebabCase, toTitleCase, unescapeHtml, template, wordCount, charCount, slugify, reverse, isPalindrome, capitalize, repeat, pad, extractUrls, extractEmails, isAlphanumeric, random. Internal calls within this unused group mean they should be removed together. This corrects the older claim of 20 removable methods.
- AsyncUtils's directly used production surface is sleep, retry, timeout, batch. cancelable, debounceAsync, throttleAsync, queue, any, waterfall, delay have no direct production/test callers found. Other unused production methods are test-covered; retire those tests deliberately if removing the methods. Review this.method dependencies and any object/alias consumers before pruning a default-export object.
- PriorityQueue, CircularBuffer, Trie, BloomFilter, BiMap, SetOps in utils/data-structures.js are exercised by tests/utils.test.js but have no production consumers found. Keep LRUCache and Queue where still used; the unused Queue import in chat-vectorization is not proof the class is dead everywhere.
- ui/progress-tracker.js:updateBatch has no caller found. The other flagged-looking methods, such as createPanel/startTimeUpdater/updateErrorsList, are called internally and must remain.

## Code and assets to preserve / decisions to defer

- index.js:onUpdate and vectfox_rearrangeChat: host entry points named in manifest.json. No ordinary importer is required.
- core/emotion-classifier.js: explicitly side-effect imported by index.js and publishes window.VectFoxEmotionClassifier for Cotton-Tales. Preserve the global API and methods reachable through it. An individual exported helper without a caller still requires API review.
- core/world-info-integration.js: publishes window.VectFox_WorldInfo. Helpers exposed there remain live even if tests are their only named importers.
- core/content-vectorization.js:generateCollectionId's chat throw is a deliberate defensive tripwire, protected by tests/dead-code-deletion-contract.test.js. Preserve it, along with the documented empty defaults shim unless readers change.
- Provider branches keyed on webllm/koboldcpp/bananabread, rerankWithBananaBread, streamEmbeddingsAndWrite, and providers/webllm.js are not all proven dead. index.js merges persisted settings without normalizing source to the four visible providers; settings changes also store the selected string directly. Uncalled creation helpers can go, but removing reachable legacy behavior needs an explicit compatibility/migration decision and integration tests.
- core/vendor/jieba/jieba_rs_wasm.js, its WASM binary, and dict.txt are loaded through URLs built in bm25-scorer.js:44-46 and a nonliteral dynamic import. Preserve all three. TinySegmenter/wikitext vendor code also has live imports.
- All tracked CSS files have stylesheet/import references; the README image has documentation references. Selector-level deadness is not established: selectors can originate in generated markup or the SillyTavern host. Do not prune CSS solely by text counts.
- cleaning-presets/fatbody-dnd-megumin.json has no filename caller, but is a manually importable data artifact, not executable dead code.
- package scripts, Vitest/Playwright configs, and tools/migrate-logging.py are separate development entry points. Lack of an index.js import is expected. Test-only files likewise belong to their runners; tests/*.spec.js are outside the Vitest baseline and belong to Playwright.
- Historical plans, translated READMEs, Doc resources, and migration notes are not dead executable code merely because the application does not load them.
- The old collection-export.js standard-to-vectra ternary finding is stale: current code calls getRegistryBackend. Empty catches, fallback guards, and provider error branches require behavior analysis, not blanket deletion.

## Recommended removal sequence and verification

1. Remove the seven private functions and unused bindings while preserving module initialization. Remove the two unreferenced utility modules and obsolete HTML template after a final export/loader search.
2. Retire genuinely unused exports and their transitively unused helpers in small groups. Keep global/host APIs. For test-only utilities, explicitly decide whether to maintain the library API or retire its tests too.
3. Treat provider retirement and settings migration as separate behavior changes.
4. After each deletion group, rerun the unit suite and import/reference checks. Then smoke-test extension startup, settings, chunk editing/vectorization, EventBase auto-sync, diagnostics, and Cotton-Tales/world-info integration in a suitable SillyTavern instance. A unit-only result cannot establish browser/host compatibility.

The initial audit was read-only. The subsequent authorized strong-candidate removal is recorded above; no tests were removed.

/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API (Standard) or Qdrant.
 *
 * Functions:
 * - getVectorsRequestBody() - Builds request body for embedding providers
 * - getAdditionalArgs() - Special handling for WebLLM/KoboldCpp
 * - throwIfSourceInvalid() - Validates provider configuration
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 * - purgeFileVectorIndex() - DELETE file-specific collection
 *
 * @author Base: Cohee#1207 | VectFox: Backend abstraction
 * ============================================================================
 */

import { bindCollectionQueries } from './collection-query-bindings.js';

import { getRequestHeaders } from '../../../../../script.js';
import { modules } from '../../../../extensions.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
// Embedding-side: no key helpers needed here. vLLM, Ollama, and other
// "local-or-self-hosted" providers either resolve keys server-side via ST
// (vLLM → SECRET_KEYS.VLLM) or send no auth at all (Ollama — ST has no
// auth path for it). Cloud providers like OpenRouter route through ST's
// chat-completions proxy from elsewhere, not through this file.
import '../../../../openai.js';
import { isWebLlmSupported } from '../../../shared.js';
import { getWebLlmProvider } from '../providers/webllm.js';
import { getBackend, getBackendForCollection, invalidateBackendHealth, recordInsert, recordDelete, recordError } from '../backends/backend-manager.js';
import { getRegistryBackend } from './collection-ids.js';
import {
    getProviderConfig,
    getModelField,
    getModelFromSettings,
    getSecretKey,
    requiresApiKey,
    requiresUrl
} from './providers.js';
import { log } from './log.js';

/**
 * Lazy + best-effort cache invalidation for the corpus-IDF stats.
 *
 * Called from the chunk-write paths (insert / delete / purge). Any failure
 * here must NOT break the write — worst case is stale IDF until the next page
 * reload, which is the pre-fix behavior anyway. Dynamic import keeps the
 * corpus-stats module load deferred to when it's actually needed.
 */
async function _invalidateCorpusStats(collectionId, reason) {
    if (!collectionId) return;
    try {
        const mod = await import('./corpus-stats.js');
        mod.clearCorpusStatsCache(collectionId);
        log.trace(`[CorpusStats] Invalidated cache for ${collectionId} (${reason})`);
    } catch (err) {
        // Silent — invalidation is best-effort. Stale stats are acceptable;
        // a stack trace mid-write is not.
    }
}

/**
 * Session cache for getSavedHashes(collectionId, settings, includeMetadata=true) —
 * the full-collection metadata variant used by chat-vectorization.js's
 * expandSummaryChunks/fetchForceLinkedChunks on every message retrieval that
 * surfaces a summary/force-linked chunk. Uncached, that call downloads the
 * ENTIRE collection (hashes via backend.getSavedHashes + a second full
 * /chunks/list metadata fetch) from scratch on every message — the exact
 * full-collection scan vector search exists to avoid, and it can fire twice
 * in one rearrangeChat call (expandSummaryChunks then fetchForceLinkedChunks).
 *
 * Deliberately NOT applied to the includeMetadata=false (plain hashes) path —
 * insertVectorItems' dedup-by-hash logic reads that path and needs a fresh
 * result on every call, not a cached one.
 *
 * Same lazy-rebuild invalidation policy as corpus-stats.js: entries are
 * dropped on write, not eagerly rebuilt, so the cost lands on the next read.
 */
const _savedHashesMetaCache = new Map(); // collectionId -> {hashes, metadata}
const _savedHashesMetaInflight = new Map(); // collectionId -> Promise (dedupe concurrent fetches)

/**
 * Clears the getSavedHashes(..., true) cache. Mirrors clearCorpusStatsCache's
 * shape (collectionId or omit-for-all) so both caches invalidate the same way
 * from the same call sites.
 * @param {string} [collectionId]
 */
export function clearSavedHashesMetaCache(collectionId) {
    if (collectionId) {
        _savedHashesMetaCache.delete(collectionId);
        _savedHashesMetaInflight.delete(collectionId);
    } else {
        _savedHashesMetaCache.clear();
        _savedHashesMetaInflight.clear();
    }
}

function _invalidateSavedHashesMetaCache(collectionId, reason) {
    if (!collectionId) return;
    if (!_savedHashesMetaCache.has(collectionId) && !_savedHashesMetaInflight.has(collectionId)) return;
    clearSavedHashesMetaCache(collectionId);
    log.trace(`[SavedHashesMeta] Invalidated cache for ${collectionId} (${reason})`);
}
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER
} from './constants.js';

// Get shared WebLLM provider singleton (lazy-initialized)
const webllmProvider = getWebLlmProvider();

/**
 * VEC-33: Wrapper for backend operations that invalidates health cache on error
 * @param {Function} operation - Async function that performs the backend operation
 * @param {object} settings - Settings object (used to determine backend name)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Re-throws the original error after invalidating cache
 */
async function withHealthInvalidation(operation, settings) {
    try {
        return await operation();
    } catch (error) {
        // Invalidate health cache for the backend that failed
        const backendName = settings?.vector_backend || 'standard';
        invalidateBackendHealth(backendName, error);
        throw error;
    }
}

/**
 * Rate limiter that respects user settings dynamically.
 */
class DynamicRateLimiter {
    constructor() {
        this.timestamps = [];
    }

    /**
     * Executes a function if rate limits allow, or waits until they do.
     * @param {Function} fn Function to execute
     * @param {object} settings Settings containing rate_limit_calls and rate_limit_interval
     * @returns {Promise<any>} Result of the function
     */
    async execute(fn, settings) {
        const maxCalls = settings.rate_limit_calls || 0; // 0 = disabled
        const intervalMs = (settings.rate_limit_interval || 60) * 1000;

        if (maxCalls <= 0) {
            return await fn();
        }

        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < intervalMs);

        if (this.timestamps.length >= maxCalls) {
            // Calculate wait time
            const oldest = this.timestamps[0];
            const waitTime = (oldest + intervalMs) - now;

            if (waitTime > 0) {
                log.verbose(`VectFox: Rate limit reached. Waiting ${Math.round(waitTime / 1000)}s...`);
                await AsyncUtils.sleep(waitTime + 100); // Add small buffer
            }

            // Recursive call to re-check
            return this.execute(fn, settings);
        }

        // Add timestamp and execute
        this.timestamps.push(Date.now());
        return await fn();
    }
}

// Global rate limiter instance
const dynamicRateLimiter = new DynamicRateLimiter();

/**
 * Helper to batch array into chunks
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * callWithHedge — fire a duplicate request after a threshold to dodge connection-level
 * routing stalls on multi-upstream embedding providers (OpenRouter, SiliconFlow behind
 * the vllm slot, etc.). Race-first-wins via Promise — whoever finishes first settles.
 *
 * Why it works: routing affinity at OpenRouter and similar gateways is per-HTTP-connection.
 * Once your traffic lands on a stuck upstream, the SAME request stays stuck until ST's
 * 120s timeout fires. A NEW connection at t=15s gets a fresh routing decision and often
 * lands on a healthy upstream — confirmed 2026-05-30 (attempt 1 hung 120s, identical
 * payload on attempt 2 succeeded in 1.1s).
 *
 * Safety: same input → deterministic embedding → same hash → Qdrant upsert idempotent on
 * point ID. Whichever attempt wins, the data is correct. Late-arriving losers harmlessly
 * upsert the same point with identical data.
 *
 * Hedge-fatal: if all (maxHedges + 1) attempts fail (or are still in flight) by the hard
 * cutoff at (maxHedges + 1) × thresholdMs, throw an error with `name === 'HedgeFatalError'`
 * and `isHedgeFatal === true`. The shouldRetry filter in RETRY_CONFIG checks this flag and
 * skips retrying — the user can resume manually via Continue button. See
 * plans/embedding-resilience-hedge-and-diagnostics.md §6.
 *
 * @param {Function} fn - Async function to call (each invocation must be safe to repeat)
 * @param {number} thresholdMs - Time between attempts (e.g., 15000)
 * @param {number} maxHedges - Number of hedges to fire after primary (e.g., 3)
 * @param {object} ctx - { debugOn, batchIdx, totalBatches, provider } for logging
 * @returns {Promise<*>} - Result of the first attempt to succeed
 */
async function callWithHedge(fn, thresholdMs, maxHedges, ctx) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timers = [];
        const errors = [];
        const { debugOn, batchIdx, totalBatches, provider } = ctx || {};

        const settle = (kind, val) => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            kind === 'ok' ? resolve(val) : reject(val);
        };

        const label = (i) => (i === 0 ? 'primary' : `hedge ${i}/${maxHedges}`);

        const fire = (attemptIdx) => {
            const start = performance.now();
            fn().then(
                (r) => {
                    if (settled) return; // someone else already won
                    if (attemptIdx > 0) {
                        // A hedge (not the primary) won — recovered-from anomaly.
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.warn(`VectFox: hedge — ${label(attemptIdx)} WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s`);
                    } else {
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.lifecycle(`VectFox: hedge — primary WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${elapsed}s`);
                    }
                    settle('ok', r);
                },
                (e) => {
                    errors.push({ attemptIdx, error: e });
                    if (debugOn && !settled) {
                        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
                        log.warn(
                            `VectFox: hedge — ${label(attemptIdx)} FAILED after ${elapsed}s for batch ${batchIdx}/${totalBatches} — ${e?.name || 'Error'}: ${e?.message || e}`,
                        );
                    }
                    // Abort short-circuit: user pressed Stop, every future hedge would
                    // also bail with AbortError before even making the HTTP request,
                    // spamming the console for up to (maxHedges + 1) × thresholdMs (60s
                    // with defaults). Settle the whole race as failed immediately so
                    // the scheduled hedge timers' `!settled` check turns them into no-ops.
                    // Same applies to any abort propagated from the caller's signal.
                    // See 2026-05-30 bug: hedge kept firing for 60s after Stop.
                    if (e?.name === 'AbortError') {
                        settle('err', e);
                        return;
                    }
                    // Don't settle on other individual failures — later hedges may still succeed
                },
            );
        };

        // Primary at t=0
        fire(0);

        // Schedule hedges at t=thresholdMs, 2×thresholdMs, ..., maxHedges×thresholdMs
        for (let i = 1; i <= maxHedges; i++) {
            timers.push(setTimeout(() => {
                if (!settled) {
                    if (debugOn) {
                        log.warn(
                            `VectFox: hedge ${i}/${maxHedges} firing at t=${(i * thresholdMs) / 1000}s — batch ${batchIdx}/${totalBatches} via ${provider} (primary still slow)`,
                        );
                    }
                    fire(i);
                }
            }, i * thresholdMs));
        }

        // Hard fatal cutoff at t=(maxHedges + 1) × thresholdMs.
        // Catches both "all attempts failed" and "all attempts still in flight, none returned"
        // — either way, after 4 attempts to a routing-variant provider, more retries won't help.
        timers.push(setTimeout(() => {
            if (settled) return;
            const lastError = errors.length ? errors[errors.length - 1].error : null;
            const tail = lastError
                ? `last error: ${lastError?.name || 'Error'}: ${lastError?.message || lastError}`
                : `${maxHedges + 1} attempts still in-flight at cutoff, none returned`;
            const fatalErr = new Error(
                `Hedge fatal: ${maxHedges + 1} attempts to ${provider} over ${((maxHedges + 1) * thresholdMs) / 1000}s — ${tail}`,
            );
            fatalErr.name = 'HedgeFatalError';
            fatalErr.isHedgeFatal = true;
            settle('err', fatalErr);
        }, (maxHedges + 1) * thresholdMs));
    });
}

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: (error) => {
        // Hedge-fatal errors carry an isHedgeFatal flag. After hedge already
        // burned 4 fresh-connection attempts in ~60s without success, an
        // immediate outer retry would just trigger another 60s of hedge —
        // upstream is genuinely broken for our payload. Throw straight up to
        // the coordinator so the user can press Continue later. See
        // plans/embedding-resilience-hedge-and-diagnostics.md §6.5.
        if (error?.isHedgeFatal === true) return false;
        // Catch AbortSignal.timeout()'s DOMException ("TimeoutError" / message
        // "signal timed out") before the keyword fallback. The string "timed
        // out" is a separate word form from "timeout" and the keyword list
        // missed it, so OpenRouter embedding stalls that tripped ST's HTTP
        // timeout silently bypassed retry and killed the backfill mid-run.
        // See production failure 2026-05-30 10:26:26 — Doc/log.txt.
        if (error?.name === 'TimeoutError') return true;
        const message = error?.message?.toLowerCase() || '';
        const isRetryable =
            message.includes('network') ||
            message.includes('timeout') ||
            message.includes('timed out') ||
            message.includes('failed to fetch') ||
            message.includes('fetch') ||
            message.includes('suspended') ||
            message.includes('429') ||
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504');
        return isRetryable;
    }
};

/**
 * Strips HTML and Markdown formatting from text before embedding.
 * Uses StringUtils from ST-Helpers for consistent text cleaning.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function stripFormatting(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    // Strip HTML first, then Markdown
    let cleaned = StringUtils.stripHtml(text, true);
    cleaned = StringUtils.stripMarkdown(cleaned);
    return cleaned.trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @param {object} settings VectFox settings object
 * @returns {object} Request body
 */
export function getVectorsRequestBody(args = {}, settings) {
    const body = Object.assign({}, args);
    switch (settings.source) {
        case 'openrouter':
            body.model = settings.openrouter_model;
            break;
        case 'ollama':
            body.model = settings.ollama_model;
            body.apiUrl = settings.ollama_use_alt_endpoint ? settings.ollama_alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!settings.ollama_keep;
            // No apiKey: ST has no ollama auth path. See backends/qdrant.js for
            // the full rationale.
            break;
        case 'vllm':
            body.apiUrl = (settings.vllm_use_alt_endpoint ? settings.vllm_alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM])
                ?.replace(/\/$/, '')
                .replace(/\/v1\/embeddings$/, '')
                .replace(/\/embeddings$/, '');
            body.model = settings.vllm_model;
            // No apiKey passed: ST's vLLM embedding handler reads
            // SECRET_KEYS.VLLM server-side. See backends/standard.js for the
            // full rationale.
            break;
        // case 'extras': body.extrasUrl = extension_settings.apiUrl; body.extrasKey = extension_settings.apiKey; break;
        // case 'electronhub': body.model = settings.electronhub_model; break;
        // case 'togetherai': body.model = settings.togetherai_model; break;
        // case 'openai': body.model = settings.openai_model; break;
        // case 'cohere': body.model = settings.cohere_model; break;
        // case 'llamacpp': body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]; break;
        // case 'bananabread': body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008'; if (settings.bananabread_api_key) body.apiKey = settings.bananabread_api_key; break;
        // case 'webllm': body.model = settings.webllm_model; break;
        // case 'palm': body.model = settings.google_model; body.api = 'makersuite'; break;
        // case 'vertexai': body.model = settings.google_model; body.api = 'vertexai'; body.vertexai_auth_mode = oai_settings.vertexai_auth_mode; body.vertexai_region = oai_settings.vertexai_region; body.vertexai_express_project_id = oai_settings.vertexai_express_project_id; break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for embeddings.
 * For client-side providers (webllm, koboldcpp, bananabread), this generates embeddings.
 * @param {string[]} items Items to embed
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<object>} Additional arguments
 */
export async function getAdditionalArgs(items, settings, onProgress = null) {
    const args = {};
    switch (settings.source) {
        // No client-side embedding providers are currently dispatched here.
    }
    return args;
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 * @param {object} settings VectFox settings object
 */
export function throwIfSourceInvalid(settings) {
    const source = settings.source;
    const config = getProviderConfig(source);

    if (!config) {
        throw new Error(`VectFox: Unknown provider ${source}`, { cause: 'unknown_provider' });
    }

    // Check API key requirement
    if (requiresApiKey(source)) {
        const secretKey = getSecretKey(source);
        if (secretKey && !secret_state[secretKey]) {
            // Special case: VertexAI can use service account as fallback
            if (source === 'vertexai' && secret_state['VERTEXAI_SERVICE_ACCOUNT']) {
                // Service account auth is available, continue
            } else {
                throw new Error('VectFox: API key missing', { cause: 'api_key_missing' });
            }
        }
    }

    // Check URL requirement
    if (requiresUrl(source)) {
        if (settings.use_alt_endpoint) {
            if (!settings.alt_endpoint_url) {
                throw new Error('VectFox: API URL missing', { cause: 'api_url_missing' });
            }
        } else {
            // Check textgen settings for local providers
            const textgenMapping = {
                'ollama': textgen_types.OLLAMA,
                'vllm': textgen_types.VLLM,
                'koboldcpp': textgen_types.KOBOLDCPP,
                'llamacpp': textgen_types.LLAMACPP
            };

            if (textgenMapping[source] && !textgenerationwebui_settings.server_urls[textgenMapping[source]]) {
                throw new Error('VectFox: API URL missing', { cause: 'api_url_missing' });
            }
        }
    }

    // Check model requirement
    if (config.requiresModel) {
        const modelField = getModelField(source);
        if (modelField && !settings[modelField]) {
            throw new Error('VectFox: API model missing', { cause: 'api_model_missing' });
        }
    }

    // Special case: extras requires embeddings module
    if (source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('VectFox: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    // Special case: WebLLM requires browser support
    if (source === 'webllm' && !isWebLlmSupported()) {
        throw new Error('VectFox: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Gets the saved hashes for a collection
 * @param {string} collectionId Collection ID
 * @param {object} settings VectFox settings object
 * @param {boolean} includeMetadata If true, returns {hashes: [], metadata: []} instead of just hashes
 * @returns {Promise<number[]|{hashes: number[], metadata: object[]}>} Saved hashes or full data
 */
export async function getSavedHashes(collectionId, settings, includeMetadata = false) {
    if (!includeMetadata) {
        const backend = await getBackend(settings);
        return await backend.getSavedHashes(collectionId, settings);
    }

    const cached = _savedHashesMetaCache.get(collectionId);
    if (cached) return cached;

    const inflight = _savedHashesMetaInflight.get(collectionId);
    if (inflight) return inflight;

    const promise = _fetchSavedHashesWithMetadata(collectionId, settings)
        .then(result => {
            // Only cache the full {hashes, metadata} shape — the hashes-only
            // fallback (plugin call failed) must not poison the next call
            // into skipping metadata forever.
            if (result && typeof result === 'object' && !Array.isArray(result)) {
                _savedHashesMetaCache.set(collectionId, result);
            }
            return result;
        })
        .finally(() => {
            _savedHashesMetaInflight.delete(collectionId);
        });
    _savedHashesMetaInflight.set(collectionId, promise);
    return promise;
}

/**
 * Uncached full fetch backing getSavedHashes(..., true) — hashes from the
 * backend plus full metadata from the unified /chunks/list plugin endpoint
 * (works across all backends). Split out so the cache wrapper above can
 * dedupe concurrent calls and skip this entirely on a warm cache.
 */
async function _fetchSavedHashesWithMetadata(collectionId, settings) {
    const backend = await getBackend(settings);
    const hashes = await backend.getSavedHashes(collectionId, settings);

    try {
        const backendName = settings.vector_backend || 'standard';
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: getRegistryBackend(backendName),
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                limit: 10000
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success && data.items) {
                return {
                    hashes: hashes,
                    metadata: data.items.map(item => item.metadata || item)
                };
            }
        }
    } catch (error) {
        log.warn('VectFox: Failed to get full metadata from chunks API, returning hashes only', error);
    }

    // Fallback: return hashes as array (old format)
    return hashes;
}

/**
 * Inserts vector items into a collection
 * Handles batching and rate limiting.
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectFox settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<void>}
 */
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];

    try {
        // If source requires client-side embeddings, use streaming approach
        if (clientSideEmbeddingSources.includes(settings.source)) {
            log.lifecycle(`VectFox: Streaming embeddings and writing for ${settings.source}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal);
        } else {
            // Server-side embeddings - backend handles everything
            // VEC-6: Use configurable batch size for optimized bulk inserts
            // Some providers need smaller batches - Ollama and Transformers work best with batch size of 1
            // Qdrant with local GPU sources (transformers/ollama/llamacpp) also defaults to 1:
            // the Similharity server embeds all items in a single HTTP request sequentially,
            // so 5 items = 5×T on the GPU inside one request, which 504s for large models.
            // Sending 1 item per call keeps each request under the gateway timeout.
            // API-based sources (openai, openrouter, etc.) can batch safely — the server
            // runs those in parallel so total time stays ~T regardless of item count.
            const localGpuSources = new Set(['transformers', 'ollama', 'llamacpp', 'koboldcpp']);
            const configuredBatchSize = settings.insert_batch_size || 50;
            const hasExplicitBatchSize = !!settings.insert_batch_size;
            const hasRateLimit = settings.rate_limit_calls > 0;

            // Parallel-split insert — see plans/embedding-resilience-hedge-and-diagnostics.md §5.
            // Default behavior: each event becomes its own embedding+insert POST, fired in
            // parallel waves. Contains the blast radius when ONE upstream worker is stuck
            // (SiliconFlow, vLLM-the-software) or ONE routing decision is bad (OpenRouter) —
            // the stuck item retries in isolation while the rest finish normally.
            //
            // The `vector_group_embedding_call` setting (UI checkbox in the Core tab →
            // Embedding section — path-agnostic, applies to every caller of insertVectorItems
            // including EventBase ingestion AND content/document vectorization in
            // content-vectorization.js). Default unchecked. Checking it
            // opts INTO the legacy production behavior: a single batched POST containing all
            // items. Cheaper (fewer HTTP calls) but ONE stuck item hangs the WHOLE batch —
            // see the 555s monster batches observed 2026-05-30.
            //
            // Gated to non-local, non-rate-limited providers regardless of the setting —
            // Ollama already uses batch=1 sequentially, and rate-limit requires serial
            // execution via dynamicRateLimiter.
            const groupEmbeddingCall = settings?.vector_group_embedding_call === true;
            const shouldParallelSplit = (
                !groupEmbeddingCall
                && !localGpuSources.has(settings.source)
                && !hasRateLimit
                && items.length > 1
            );

            // Force 1-item batches for local GPU sources unless user overrides explicitly.
            // Also force 1-item batches when parallel-split experiment is active.
            const BATCH_SIZE = shouldParallelSplit
                ? 1
                : ((!hasExplicitBatchSize && localGpuSources.has(settings.source)) ? 1 : configuredBatchSize);
            const batches = chunkArray(items, BATCH_SIZE);

            log.verbose(`VectFox: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}${shouldParallelSplit ? ` [parallel-split: ${batches.length} concurrent POSTs in waves of up to 16]` : ''}`);

            if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });

            // Hedge gating — opt-in via `vector_hedge_after_ms` setting (0 = off).
            // Skipped for local providers where opening a new HTTP connection wouldn't
            // change routing (Ollama / transformers / llama.cpp / KoboldCpp all land on
            // the same single endpoint regardless of connection identity).
            // See plans/embedding-resilience-hedge-and-diagnostics.md §6.
            const rawHedgeAfterMs = Number(settings?.vector_hedge_after_ms) || 0;
            const HEDGE_MAX_COUNT = 3;
            const hedgeEnabled = (
                rawHedgeAfterMs > 0
                && !localGpuSources.has(settings.source)
            );
            const hedgeAfterMs = hedgeEnabled ? rawHedgeAfterMs : 0;

            if (hedgeEnabled) {
                log.lifecycle(`VectFox: hedge enabled — threshold ${hedgeAfterMs}ms, max ${HEDGE_MAX_COUNT} hedges, total budget ${((HEDGE_MAX_COUNT + 1) * hedgeAfterMs) / 1000}s per insert call`);
            }

            // Factored-out per-batch retry+log closure shared by serial and parallel paths.
            // Each invocation gets its OWN attempt counter and timing — under parallel-split
            // the per-item logs interleave but each line carries `batch X/Y` so they remain
            // attributable.
            const makeProcessBatch = (batch, batchIdx, batchItemCount) => async () => {
                let attemptCount = 0;
                await AsyncUtils.retry(async () => {
                    attemptCount++;
                    const attemptStart = performance.now();
                    const debugOn = log.enabled('verbose');
                    log.verbose(
                        `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} — POST ${batchItemCount} item(s) via ${settings.source}${hedgeEnabled ? ' [hedge armed]' : ''}`,
                    );
                    try {
                        if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                        const insertCall = () => backend.insertVectorItems(collectionId, batch, settings, abortSignal);
                        if (hedgeEnabled) {
                            await callWithHedge(insertCall, hedgeAfterMs, HEDGE_MAX_COUNT, {
                                debugOn,
                                batchIdx,
                                totalBatches: batches.length,
                                provider: settings.source,
                            });
                        } else {
                            await insertCall();
                        }
                        if (attemptCount > 1) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            log.verbose(
                                `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount} succeeded after ${elapsed}s`,
                            );
                        }
                    } catch (err) {
                        // Per-attempt failure log with elapsed time + provider + batch size.
                        // Without elapsed, "TimeoutError: signal timed out" tells you
                        // nothing — was it a fast connection refusal or a 120s upstream
                        // stall? Knowing the duration distinguishes "vLLM is down" (fails
                        // in <1s) from "OpenRouter routing storm" (fails at exactly
                        // ST's ~120s HTTP timeout). The provider/items context narrows
                        // where in the call chain it died: ST request → embedding
                        // provider call → Qdrant upsert.
                        if (debugOn) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            log.warn(
                                `VectFox: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} FAILED after ${elapsed}s — ${err?.name || 'Error'}: ${err?.message || err} (provider=${settings.source}, items=${batchItemCount})`,
                            );
                        }
                        throw err;
                    }
                }, RETRY_CONFIG);
            };

            if (shouldParallelSplit) {
                // Parallel waves of up to MAX_PARALLEL concurrent inserts. Each batch is 1
                // item with its own RETRY_CONFIG budget. Promise.allSettled lets all in-flight
                // finish even if one fails — successful ones are durable in Qdrant. If any
                // failed after retries, throw composite so the coordinator marks the WHOLE
                // batch failed (windows stay unmarked; resume re-extracts and hash-deterministic
                // upsert idempotently re-inserts the already-durable items).
                const MAX_PARALLEL = 16;
                for (let wave = 0; wave < batches.length; wave += MAX_PARALLEL) {
                    const slice = batches.slice(wave, wave + MAX_PARALLEL);
                    const results = await Promise.allSettled(
                        slice.map((batch, idx) => {
                            const processBatch = makeProcessBatch(batch, wave + idx + 1, batch.length);
                            return processBatch();
                        }),
                    );
                    const failed = results.filter(r => r.status === 'rejected');
                    if (failed.length > 0) {
                        const sample = failed[0].reason;
                        // Hedge-fatal propagation: if ANY of the wave's failures hit hedge-fatal
                        // (4 fresh-connection attempts in 60s with no success), the upstream is
                        // genuinely broken for our payload. Propagating isHedgeFatal lets the
                        // OUTER _insertWithRetry short-circuit and avoid burning 12+ minutes
                        // per retry × N retries on a wave that's certain to fail again the
                        // same way. Without this, the composite Error would hide the flag and
                        // the outer retry would re-run the whole 12-batch hedged wave 3 times
                        // (~36 minutes). Observed 2026-05-30 with similharity plugin 2.1MB
                        // truncated-JSON 500s under parallel-split + hedge concurrent load.
                        const anyHedgeFatal = failed.some(f => f.reason?.isHedgeFatal === true);
                        const composite = new Error(
                            `VectFox: ${failed.length}/${slice.length} parallel inserts in wave failed — first failure: ${sample?.name || 'Error'}: ${sample?.message || sample}`,
                        );
                        if (anyHedgeFatal) {
                            composite.name = 'HedgeFatalError';
                            composite.isHedgeFatal = true;
                        }
                        throw composite;
                    }
                    if (onProgress) {
                        onProgress(Math.min(wave + slice.length, items.length), items.length);
                    }
                }
            } else {
                // Existing serial path — preserves rate-limited and local-GPU semantics.
                for (let i = 0; i < batches.length; i++) {
                    const processBatch = makeProcessBatch(batches[i], i + 1, batches[i].length);
                    if (hasRateLimit) {
                        await dynamicRateLimiter.execute(processBatch, settings);
                    } else {
                        await processBatch();
                    }
                    if (onProgress) {
                        const embeddedCount = (i + 1) * BATCH_SIZE;
                        const actualEmbedded = Math.min(embeddedCount, items.length);
                        onProgress(actualEmbedded, items.length);
                    }
                }
            }
        }

        // VEC-18: Record successful insert operation
        recordInsert(settings?.vector_backend || 'standard', items.length);
        // Stale-stats fix: chunks just changed → next BM25 corpus-IDF query
        // must rebuild instead of returning pre-write df values. Fire-and-forget.
        _invalidateCorpusStats(collectionId, `insert ${items.length} item(s)`);
        _invalidateSavedHashesMetaCache(collectionId, `insert ${items.length} item(s)`);
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Stream embeddings and write to database as batches complete
 * @param {object} backend - The backend instance
 * @param {string} collectionId - Collection ID
 * @param {Array} items - Original items
 * @param {string[]} textStrings - Text strings extracted from items
 * @param {object} settings - Settings object
 * @param {Function} onProgress - Progress callback
 */
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal = null) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    log.lifecycle(`VectFox: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

        log.verbose(`VectFox: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);

        // VEC-6: Retry logic per batch instead of per chunk
        let additionalArgs;
        try {
            additionalArgs = await AsyncUtils.retry(async () => {
                return await getAdditionalArgs(batchTextStrings, settings);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectFox: Failed to generate embeddings for batch ${batchNum} after retries: ${error.message}`);
        }

        if (!additionalArgs.embeddings) {
            throw new Error(`VectFox: No embeddings returned from ${settings.source} for batch ${batchNum}`);
        }

        // Attach embeddings to items and validate
        let missingEmbeddings = 0;
        const itemsToWrite = [];

        for (let j = 0; j < batchItems.length; j++) {
            const text = batchTextStrings[j];
            const embedding = additionalArgs.embeddings[text];

            if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                // Validate embedding values
                const isValidEmbedding = embedding.every(val => typeof val === 'number' && !isNaN(val));
                if (!isValidEmbedding) {
                    log.error(`VectFox: Invalid embedding values for item ${i + j}:`, embedding.slice(0, 5));
                    missingEmbeddings++;
                    continue;
                }
                batchItems[j].vector = embedding;
                itemsToWrite.push(batchItems[j]);
            } else {
                missingEmbeddings++;
                log.warn(`VectFox: No embedding found for item ${i + j}, text: "${text.substring(0, 50)}..."`);
            }
        }

        if (missingEmbeddings > 0) {
            throw new Error(`VectFox: Failed to generate embeddings for ${settings.source} - ${missingEmbeddings} items missing in batch`);
        }

        // VEC-6: Write batch to database with retry logic
        log.verbose(`VectFox: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        try {
            await AsyncUtils.retry(async () => {
                if (abortSignal?.aborted) throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
                await backend.insertVectorItems(collectionId, itemsToWrite, settings, abortSignal);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectFox: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;

        // Update progress
        if (onProgress) {
            log.verbose(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length);
        }
    }

    log.lifecycle(`VectFox: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 *
 * Deliberately does NOT invalidate the Auto-Reformat cache: inserted chunk
 * hashes can differ from cached chunk text (glossary injection mutates text
 * before insert), so hash-matching is unsound, and a partial delete doesn't
 * mean the source was never reformatted. The reuse-vs-rerun prompt in
 * runAutoReformat covers this case.
 *
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function deleteVectorItems(collectionId, hashes, settings) {
    const backend = await getBackend(settings);
    try {
        // VEC-33: Wrap with health invalidation
        const result = await withHealthInvalidation(
            () => backend.deleteVectorItems(collectionId, hashes, settings),
            settings
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        // Stale-stats fix: corpus shrank.
        _invalidateCorpusStats(collectionId, `delete ${hashes?.length || 0} hash(es)`);
        _invalidateSavedHashesMetaCache(collectionId, `delete ${hashes?.length || 0} hash(es)`);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Queries multiple collections with conditional activation filtering.
 * Collections that don't meet their activation conditions are skipped.
 *
 * @param {string[]} collectionIds - Collection IDs to potentially query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings - VectFox settings object
 * @param {object} context - Search context (from buildSearchContext)
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) {
    // Lazy import to avoid circular dependency
    const { filterActiveCollections } = await import('./collection-metadata.js');

    // Filter collections based on their activation conditions
    const activeCollectionIds = await filterActiveCollections(collectionIds, context);

    if (activeCollectionIds.length === 0) {
        log.lifecycle('VectFox: No collections passed activation conditions');
        return {};
    }

    // Query only the active collections
    const backend = await getBackend(settings);
    return await backend.queryMultipleCollections(activeCollectionIds, searchText, topK, threshold, settings);
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
export async function purgeVectorIndex(collectionId, settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeVectorIndex(collectionId, settings);
        log.lifecycle(`VectFox: Purged vector index for collection ${collectionId}`);
        // Stale-stats fix: entire collection is gone.
        _invalidateCorpusStats(collectionId, 'purge');
        _invalidateSavedHashesMetaCache(collectionId, 'purge');
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge', error);
        return false;
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeFileVectorIndex(collectionId, settings) {
    try {
        log.lifecycle(`VectFox: Purging file vector index for collection ${collectionId}`);
        const backend = await getBackend(settings);
        await backend.purgeFileVectorIndex(collectionId, settings);
        log.lifecycle(`VectFox: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge file', error);
    }
}

/**
 * Purges all vector indexes.
 * @param {object} settings VectFox settings object
 * @returns {Promise<void>}
 */
export async function purgeAllVectorIndexes(settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeAllVectorIndexes(settings);
        // Every collection on this backend is gone — drop the Auto-Reformat
        // freezes that were vectorized into it (see reformat-store.js).
        const { invalidateAllVectorizedReformatCaches } = await import('./reformat-store.js');
        invalidateAllVectorizedReformatCaches(settings?.vector_backend || 'standard');
        // Every collection is gone — drop cached full-collection metadata too.
        clearSavedHashesMetaCache();
        log.lifecycle('VectFox: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        log.error('VectFox: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

/**
 * List chunks in a collection
 * Routes through the active backend so model is resolved via getModelFromSettings,
 * not from a stale collection.model field.
 * @param {string} collectionId - Collection ID
 * @param {object} settings - VectFox settings (must include vector_backend + source)
 * @param {object} options - {offset, limit, includeVectors}
 * @returns {Promise<{items: Array<{hash, text, metadata}>, total: number}>}
 */
export async function listChunks(collectionId, settings, options = {}) {
    const backend = await getBackend(settings);
    return await backend.listChunks(collectionId, settings, options);
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectFox settings
 */
export async function updateChunkText(collectionId, hash, newText, settings) {
    const backend = await getBackend(settings);
    const result = await backend.updateChunkText(collectionId, hash, newText, settings);
    _invalidateSavedHashesMetaCache(collectionId, `update chunk text (hash ${hash})`);
    return result;
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectFox settings
 */
export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    const backend = await getBackend(settings);
    const result = await backend.updateChunkMetadata(collectionId, hash, metadata, settings);
    _invalidateSavedHashesMetaCache(collectionId, `update chunk metadata (hash ${hash})`);
    return result;
}

// Compatibility entry points for existing callers.
const collectionQueries = bindCollectionQueries(getAdditionalArgs);
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) {
    return collectionQueries.queryCollection(collectionId, searchText, topK, settings, filters);
}

export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
    return collectionQueries.queryMultipleCollections(collectionIds, searchText, topK, threshold, settings);
}

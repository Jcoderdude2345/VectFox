import { DEFAULT_RRF_K, reciprocalRankFusion, weightedCombination } from './query-score-fusion.js';

/**
 * Executes the three existing query contracts over the same private machinery.
 * Routing, threshold timing and fallback differences are compatibility behavior:
 * single queries are not implemented as bulk queries (or vice versa).
 * Dependencies are bound once; settings, embedding reuse and backend resolution
 * remain scoped to each original operation. No cross-call cache is introduced.
 */
export function createCollectionQueryExecution({
    getBackend, getBackendForCollection, getAdditionalArgs, recordQuery, recordError,
    resolveBackendForCollection, parseRegistryKey, COLLECTION_PREFIXES,
    getOverfetchAmount, applyBM25Scoring, createBM25Scorer, porterStemmer,
    extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken, getCorpusStats, log,
}) {
    const KNOWN_BACKENDS = ['standard', 'vectra', 'qdrant'];
    const CLIENT_EMBEDDING_SOURCES = ['webllm', 'koboldcpp', 'bananabread'];

    // Single-query contract: resolve the input ID, preserve filters and score
    // provenance, and propagate backend errors outside hybrid's own fallbacks.
    async function queryCollection(collectionId, searchText, topK, settings, filters = {}) {
        // Canonical routing (Doc/collection_helper.md): resolveBackendForCollection accepts either form
        //   (registry-key "backend:id" or bare ID) and returns the backend label
        //   plus the BARE collectionId for downstream calls. Falls back to
        //   getBackend(settings) only when BOTH resolution paths fail, which
        //   should never happen for a well-formed VectFox collection ID.
        const resolved = resolveBackendForCollection(collectionId);
        const bareCollectionId = resolved.collectionId;
        const backend = resolved.backend
            ? await getBackendForCollection(resolved.backend, settings)
            : await getBackend(settings);

        const queryVector = CLIENT_EMBEDDING_SOURCES.includes(settings.source)
            ? await prepareQueryVector(searchText, settings, true)
            : null;

        // Append concepts_any terms to the query text so BM25 naturally boosts events containing
        // those theme words — without hard-filtering anything out. Dense vector stays clean for
        // client-side embedding paths because queryVector is already captured above.
        let effectiveQuery = searchText;
        if (Array.isArray(filters.concepts_any) && filters.concepts_any.length > 0) {
            effectiveQuery = `${searchText} ${filters.concepts_any.join(' ')}`;
            if (log.enabled('lifecycle')) {
                log.verbose(`[VectFox] concepts_any appended to query text: [${filters.concepts_any.join(', ')}]`);
            }
        }

        // Three-case routing:
        //   A3 — server-side hybrid (Qdrant with prefer_native ON) — dense vector search +
        //         full-corpus payload/text keyword matching via Qdrant scroll, fused in plugin code
        //         (NOT Qdrant native dense+sparse-vector hybrid; no sparse vectors stored)
        //   A2 — client-side hybrid over ANN candidates (standard backend, method = 'hybrid')
        //   A1 — BM25 re-rank of ANN top-K (standard backend default, method = 'bm25')
        const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
        const preferNative = settings.hybrid_native_prefer !== false;
        const useHybridPath = usesHybrid(nativeHybridAvailable, preferNative, settings);

        if (useHybridPath) {
            if (log.enabled('lifecycle')) {
                const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
                log.verbose(`[VectFox] Hybrid search (${reason}), dispatching to hybrid search module`);
            }
            const queryStart = Date.now();
            try {
                const result = await hybridSearch(bareCollectionId, effectiveQuery, topK, settings, { queryVector, filters });
                const queryLatency = Date.now() - queryStart;
                recordQuery(resolved.backend || settings?.vector_backend || 'standard', queryLatency);
                if (log.enabled('lifecycle')) {
                    const scores = (result.metadata || []).map(m => (m.score ?? 0).toFixed(4));
                    const fusionMethod = (settings.hybrid_fusion_method || 'rrf').toUpperCase();
                    log.verbose(`[VectFox] Hybrid search (${fusionMethod}) response: ${result.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
                }
                return result;
            } catch (error) {
                recordError(resolved.backend || settings?.vector_backend || 'standard', error);
                throw error;
            }
        }

        // Standard vector search flow (A1/A2). Filters are not supported here.
        if (Object.keys(filters).length > 0 && log.enabled('lifecycle')) {
            log.warn('[VectFox] queryCollection: filters ignored on A1/A2 Standard backend path');
        }
        // Overfetch to allow keyword-boosted chunks to surface
        const overfetchAmount = getOverfetchAmount(topK);
        // VEC-18: Track query latency for health dashboard
        const queryStart = Date.now();
        let rawResults;
        // Backend name for metrics — resolved backend wins, fall back to settings.
        const actualBackendName = resolved.backend || settings?.vector_backend || 'standard';
        try {
            rawResults = await backend.queryCollection(bareCollectionId, effectiveQuery, overfetchAmount, settings, queryVector);
            const queryLatency = Date.now() - queryStart;
            recordQuery(actualBackendName, queryLatency);
            if (log.enabled('lifecycle')) {
                const scores = (rawResults.metadata || []).map(m => (m.score ?? 0).toFixed(4));
                log.verbose(`[EventBase] Embedding search response: ${rawResults.hashes?.length ?? 0} result(s) in ${queryLatency}ms, scores=[${scores.join(', ')}]`);
            }
        } catch (error) {
            // VEC-18: Record query error
            recordError(actualBackendName, error);
            throw error;
        }

        // Convert to format expected by keyword boost
        const resultsForBoost = toScoringCandidates(rawResults);

        let finalResults = await scoreResults(resultsForBoost, effectiveQuery, topK, settings, bareCollectionId);

        if (log.enabled('trace')) {
            const idfMode = settings.bm25_use_corpus_idf ? 'corpus-IDF' : 'local-IDF';
            finalResults.forEach((r, i) => {
                log.trace(`[VectFox] #${i + 1} final=${r.score?.toFixed(4)} vector=${r.vectorScore?.toFixed(4) ?? 'n/a'} bm25=${r.bm25Score?.toFixed(4) ?? 'n/a'} (A1 BM25 re-rank, ${idfMode})`);
            });
        }

        // Convert back to expected format
        return serializeScoredResults(finalResults);
    }

    async function scoreResults(resultsForBoost, searchText, topK, settings, collectionId = null) {
        // Short-circuit: nothing to re-rank means no need to extract keywords or run BM25.
        if (!resultsForBoost || resultsForBoost.length === 0) {
            return [];
        }

        // A1 — BM25 re-rank over ANN top-K candidates only (no full corpus scan)
        const level = settings?.hybrid_keyword_level || 'balance';
        const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[level]?.maxKeywords ?? 50;
        const rawKeywords = extractQueryKeywords(searchText, maxKeywords, settings?.cjk_tokenizer_mode);
        const queryTokens = rawKeywords.map(token => isCJKToken(token) ? token : porterStemmer(token));

        // Optional: full-corpus IDF (A/B toggle in Core → Hybrid Search & BM25).
        // Fetches and tokenizes every chunk of the collection on first use, then
        // caches in-memory for the session.
        //
        // Hardening: this is an *enhancement* on top of valid vector results. Any
        // failure — module load error, network blip, plugin 5xx, tokenizer crash —
        // must NOT discard the ANN results. We catch every failure mode, log it
        // clearly, and continue with corpusStats=null (= local-IDF BM25, the
        // pre-toggle default). Without this, a single ./corpus-stats.js import
        // error bubbles up through scoreResults → queryCollection →
        // eventbase-retrieval.js:400 catch, which discards every match.
        let corpusStats = null;
        if (settings?.bm25_use_corpus_idf === true && collectionId) {
            try {
                corpusStats = await getCorpusStats(collectionId, settings);
                if (!corpusStats && log.enabled('lifecycle')) {
                    log.warn(`[VectFox] Corpus-IDF disabled for ${collectionId}: getCorpusStats returned null (plugin unavailable or /chunks/list failed). Falling back to local-IDF BM25.`);
                }
            } catch (err) {
                log.warn(`[VectFox] Corpus-IDF unavailable for ${collectionId}, falling back to local-IDF BM25. Reason: ${err?.message || err}`);
                corpusStats = null;
            }
        }

        const bm25Results = applyBM25Scoring(resultsForBoost, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            alpha: 0.5,
            beta: 0.5,
            queryTokens,
            corpusStats,
        });
        return bm25Results.slice(0, topK);
    }

    // Bulk contract: retain input-keyed results, per-collection topK and one
    // embedding per call. Only the raw bulk path receives the explicit threshold.
    async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
        const backend = await getBackend(settings);

        const queryVector = CLIENT_EMBEDDING_SOURCES.includes(settings.source)
            ? await prepareQueryVector(searchText, settings, false)
            : null;

        // Three-case routing (mirrors queryCollection):
        //   A3/A2 — native or client-side hybrid per collection
        //   A1    — BM25 re-rank after bulk ANN (below)
        const nativeHybridAvailable = backend?.supportsHybridSearch?.() === true;
        const preferNative = settings.hybrid_native_prefer !== false;
        const useHybridPath = usesHybrid(nativeHybridAvailable, preferNative, settings);

        if (useHybridPath) {
            if (log.enabled('lifecycle')) {
                const reason = nativeHybridAvailable && preferNative ? 'native' : 'client-side';
                log.verbose(`[VectFox] Hybrid search (${reason}) for multi-collection query`);
            }
            const processedResults = {};
            for (const collectionId of collectionIds) {
                try {
                    const queryStart = Date.now();
                    processedResults[collectionId] = await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
                    const queryLatency = Date.now() - queryStart;
                    recordQuery(settings?.vector_backend || 'standard', queryLatency);
                } catch (error) {
                    log.warn(`[VectFox] Hybrid search failed for ${collectionId}:`, error.message);
                    recordError(settings?.vector_backend || 'standard', error);
                    processedResults[collectionId] = { hashes: [], metadata: [] };
                }
            }
            return processedResults;
        }

        // Standard vector search flow
        // Get raw results from backend (with overfetch for each collection)
        const overfetchAmount = getOverfetchAmount(topK);
        // VEC-18: Track query latency for health dashboard
        const queryStart = Date.now();
        let rawResults;
        try {
            rawResults = await backend.queryMultipleCollections(collectionIds, searchText, overfetchAmount, threshold, settings, queryVector);
            const queryLatency = Date.now() - queryStart;
            recordQuery(settings?.vector_backend || 'standard', queryLatency);
        } catch (error) {
            // VEC-18: Record query error
            recordError(settings?.vector_backend || 'standard', error);
            throw error;
        }

        // Apply scoring to each collection's results
        const processedResults = {};

        for (const [collectionId, collectionResults] of Object.entries(rawResults)) {
            if (!collectionResults || !collectionResults.metadata) {
                processedResults[collectionId] = collectionResults;
                continue;
            }

            // Convert to format expected by scoring functions
            const resultsForBoost = toScoringCandidates(collectionResults);

            let finalResults = await scoreResults(resultsForBoost, searchText, topK, settings, collectionId);

            // Convert back to expected format
            processedResults[collectionId] = serializeScoredResults(finalResults);
        }

        return processedResults;
    }

    // Compatibility: direct hybrid routing currently interprets IDs differently
    // from the canonical single-query resolver. Correcting this is separate work.
    function resolveCollectionBackend(collectionId) {
        const fromRegistry = parseRegistryKey(collectionId).backend;
        if (fromRegistry) return fromRegistry;

        const TYPE_PREFIXES = [
            COLLECTION_PREFIXES.VECTFOX_EVENTBASE,
            COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT,
            COLLECTION_PREFIXES.VECTFOX_LOREBOOK,
            COLLECTION_PREFIXES.VECTFOX_CHARACTER,
            COLLECTION_PREFIXES.VECTFOX_DOCUMENT,
        ];
        for (const prefix of TYPE_PREFIXES) {
            if (collectionId.startsWith(prefix)) {
                const firstSegment = collectionId.slice(prefix.length).split('_')[0];
                if (KNOWN_BACKENDS.includes(firstSegment)) return firstSegment;
                return null; // legacy name without backend tag — caller decides
            }
        }
        return null;
    }

    // Hybrid contract: native failure falls back to client fusion; vector failure
    // there produces empty results. Raw vector/text scores survive fusion.
    async function hybridSearch(collectionId, searchText, topK, settings, options = {}) {
        // Resolve the backend the collection was *created with*, not the user's currently
        // selected backend. The DB Browser can search across collections that live in
        // different backends (e.g. some in Qdrant, some in Vectra), and routing a
        // standard-backend collection to Qdrant would 404.
        const collectionBackend = resolveCollectionBackend(collectionId);
        const backend = collectionBackend
            ? await getBackendForCollection(collectionBackend, settings)
            : await getBackend(settings);

        const {
            fusionMethod = settings.hybrid_fusion_method || 'rrf',
            vectorWeight = settings.hybrid_vector_weight ?? 0.5,
            textWeight = settings.hybrid_text_weight ?? 0.5,
            rrfK = settings.hybrid_rrf_k || DEFAULT_RRF_K,
            queryVector = null,
            filters = {},
        } = options;

        // Check if backend supports native hybrid search and user prefers it
        const preferNative = settings.hybrid_native_prefer !== false;
        if (preferNative && backend.supportsHybridSearch && backend.supportsHybridSearch()) {
            log.verbose(`[HybridSearch] Using native hybrid search (${backend.constructor.name})`);
            try {
                return await backend.hybridQuery(collectionId, searchText, topK, settings, {
                    vectorWeight,
                    textWeight,
                    fusionMethod,
                    rrfK,
                }, filters);
            } catch (error) {
                log.warn(`[HybridSearch] Native hybrid failed, falling back to client-side:`, error.message);
                // Fall through to client-side fusion
            }
        }

        // Client-side fusion for backends without native support
        log.verbose(`[HybridSearch] Using client-side ${fusionMethod.toUpperCase()} fusion`);
        return clientSideHybridSearch(
            backend,
            collectionId,
            searchText,
            topK,
            settings,
            { fusionMethod, vectorWeight, textWeight, rrfK, queryVector }
        );
    }

    async function clientSideHybridSearch(backend, collectionId, searchText, topK, settings, options) {
        const {
            fusionMethod,
            vectorWeight,
            textWeight,
            rrfK,
            queryVector,
        } = options;

        // Fetch more results for fusion (need candidates from both methods)
        const expandedTopK = Math.min(topK * 3, 100);

        // 1. Vector search
        log.verbose(`[HybridSearch] Fetching ${expandedTopK} vector results from collection: ${collectionId}`);
        log.verbose(`[HybridSearch] Backend: ${backend.constructor.name}, Source: ${settings.source}`);

        let vectorResults;
        try {
            vectorResults = await backend.queryCollection(
                collectionId,
                searchText,
                expandedTopK,
                settings,
                queryVector
            );
            log.verbose(`[HybridSearch] Raw vector results:`, vectorResults ? `hashes=${vectorResults.hashes?.length}, metadata=${vectorResults.metadata?.length}` : 'null');
        } catch (error) {
            log.error(`[HybridSearch] Vector query failed:`, error);
            return { hashes: [], metadata: [] };
        }

        if (!vectorResults || !vectorResults.metadata || vectorResults.metadata.length === 0) {
            log.verbose('[HybridSearch] No vector results found');
            log.trace(`[HybridSearch] Debug - vectorResults:`, JSON.stringify(vectorResults));
            return { hashes: [], metadata: [] };
        }

        // 2. Convert to format for BM25 scoring (include title and tags for field boosting)
        const resultsWithText = vectorResults.metadata.map((meta, idx) => ({
            hash: vectorResults.hashes[idx],
            text: meta.text || '',
            title: meta.entryName || meta.title || '',
            tags: meta.keywords || [],
            score: meta.score || 0,
            metadata: meta
        }));

        // 3. Perform BM25 scoring over the ANN candidate set.
        //    By default IDF is computed locally over those candidates. When
        //    settings.bm25_use_corpus_idf is ON, IDF is pulled from full-corpus
        //    stats (N + df across every chunk) — same idea as Qdrant A3's global IDF.
        //    Either way, recall is still bounded by what vector ANN returned.
        //
        // Hardening: corpus-IDF is an enhancement on top of valid vector results.
        // Any failure (module load, network, plugin error) must not discard the
        // ANN candidates — fall back to local-IDF BM25 and continue.
        let corpusStats = null;
        if (settings?.bm25_use_corpus_idf === true) {
            try {
                corpusStats = await getCorpusStats(collectionId, settings);
                if (!corpusStats) {
                    log.warn(`[HybridSearch] Corpus-IDF disabled for ${collectionId}: getCorpusStats returned null (plugin unavailable or /chunks/list failed). Falling back to local-IDF BM25.`);
                }
            } catch (err) {
                log.warn(`[HybridSearch] Corpus-IDF unavailable for ${collectionId}, falling back to local-IDF BM25. Reason: ${err?.message || err}`);
                corpusStats = null;
            }
        }
        log.verbose(`[HybridSearch] Computing BM25 scores for ${resultsWithText.length} results (idf=${corpusStats ? 'corpus' : 'local'})...`);
        const bm25Results = performBM25Search(resultsWithText, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            fieldBoosting: true,  // Enable title (4x) and tags (4x) boosting (see bm25-scorer.js:534, 541)
            corpusStats,
            settings,
        });

        // 4. Fuse results
        let fusedResults;
        if (fusionMethod === 'rrf') {
            log.verbose(`[HybridSearch] Applying RRF fusion (k=${rrfK})...`);
            fusedResults = reciprocalRankFusion(
                [vectorResultsToRanked(vectorResults), bm25Results],
                rrfK
            );
        } else {
            log.verbose(`[HybridSearch] Applying weighted fusion (α=${vectorWeight}, β=${textWeight})...`);
            fusedResults = weightedCombination(
                vectorResultsToScored(vectorResults),
                bm25Results,
                vectorWeight,
                textWeight
            );
        }

        // 5. Return top K fused results
        const topResults = fusedResults.slice(0, topK);

        log.verbose(`[HybridSearch] Returning ${topResults.length} fused results`);
        if (topResults.length > 0) {
            const scores = topResults.map(r => r.rrfScore || r.combinedScore || 0);
            log.verbose(`[HybridSearch] Score distribution: min=${Math.min(...scores).toFixed(4)}, max=${Math.max(...scores).toFixed(4)}`);
            log.verbose(`[HybridSearch] Top 3 results:`);
            topResults.slice(0, 3).forEach((r, i) => {
                const score = (r.rrfScore || r.combinedScore || 0).toFixed(4);
                const vRank = r.ranks?.vector || 'N/A';
                const tRank = r.ranks?.text || 'N/A';
                const vScore = (r.vectorScore || 0).toFixed(4);
                const tScore = (r.textScore || r.bm25Score || 0).toFixed(4);
                log.trace(`  [${i + 1}] finalScore=${score}, vectorRank=${vRank}, textRank=${tRank}, vectorScore=${vScore}, textScore=${tScore}`);
            });
        }

        return {
            hashes: topResults.map(r => r.result?.hash ?? r.hash),
            metadata: topResults.map(r => ({
                ...(r.result?.metadata || r.metadata || {}),
                text: r.result?.text ?? r.text,
                hash: r.result?.hash ?? r.hash,
                score: r.rrfScore ?? r.combinedScore ?? 0,
                vectorScore: r.vectorScore ?? 0,
                textScore: r.textScore ?? r.bm25Score ?? 0,
                vectorRank: r.ranks?.vector,
                textRank: r.ranks?.text,
                fusionMethod: fusionMethod,
                hybridSearch: true
            }))
        };
    }

    function performBM25Search(results, query, options = {}) {
        if (!results || results.length === 0) return [];
        if (!query || typeof query !== 'string') {
            log.warn('[HybridSearch] Invalid query for BM25 search');
            return results;
        }

        const { settings, ...scorerOptions } = options;
        const scorer = createBM25Scorer(results, scorerOptions);
        if (!scorer || scorer.totalDocs === 0) {
            log.warn('[HybridSearch] Failed to create BM25 scorer or no documents indexed');
            return results;
        }

        // Extract CJK-prioritized keywords then stem Latin tokens to match indexed form
        const level = settings?.hybrid_keyword_level || 'balance';
        const maxKeywords = RETRIEVAL_KEYWORD_LEVELS[level]?.maxKeywords ?? 50;
        const rawKeywords = extractQueryKeywords(query, maxKeywords, settings?.cjk_tokenizer_mode);
        const queryTokens = rawKeywords.map(token => isCJKToken(token) ? token : porterStemmer(token));
        log.verbose(`[HybridSearch] BM25 query tokens (${queryTokens.length}): [${queryTokens.join(', ')}]`);
        const scoredResults = results.map((result, idx) => {
            const bm25Score = scorer.scoreDocument(queryTokens, idx);
            return {
                ...result,
                bm25Score
            };
        });

        // Sort by BM25 score (descending)
        scoredResults.sort((a, b) => b.bm25Score - a.bm25Score);

        return scoredResults;
    }

    function vectorResultsToRanked(vectorResults) {
        return vectorResults.metadata.map((meta, idx) => ({
            hash: vectorResults.hashes[idx],
            score: meta.score || 0,
            text: meta.text || '',
            metadata: meta
        }));
    }

    function vectorResultsToScored(vectorResults) {
        return vectorResultsToRanked(vectorResults);
    }

    function serializeScoredResults(finalResults) {
        return {
            hashes: finalResults.map(r => r.hash),
            metadata: finalResults.map(r => ({
                ...r.metadata,
                score: r.score,
                originalScore: r.originalScore || r.vectorScore,
                keywordBoost: r.keywordBoost,
                bm25Score: r.bm25Score,
                normalizedBM25: r.normalizedBM25,
                vectorScore: r.vectorScore,
                matchedKeywords: r.matchedKeywords,
                matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
                keywordBoosted: r.keywordBoosted
            }))
        };
    }

    function toScoringCandidates(results) {
        return results.metadata.map((meta, idx) => ({
            hash: results.hashes[idx], score: meta.score || 0, metadata: meta, text: meta.text || '',
        }));
    }

    function usesHybrid(nativeHybridAvailable, preferNative, settings) {
        return (nativeHybridAvailable && preferNative) || settings.keyword_scoring_method === 'hybrid';
    }

    async function prepareQueryVector(searchText, settings, logVector) {
        let queryVector = null;

        // If source requires client-side embeddings, generate query vector
        try {
            const additionalArgs = await getAdditionalArgs([searchText], settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
                if (logVector) log.verbose(`[EventBase] Embedding model (${settings.source}) returned vector: dim=${queryVector.length}, first5=[${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}], last5=[${queryVector.slice(-5).map(v => v.toFixed(4)).join(', ')}], model=${additionalArgs.model || 'n/a'}`);
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                log.warn(`[VectFox] Client-side embedding generation returned empty result for ${settings.source}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            log.warn(`[VectFox] Client-side embedding failed for ${settings.source}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }

        return queryVector;
    }

    return { queryCollection, queryMultipleCollections, hybridSearch };
}

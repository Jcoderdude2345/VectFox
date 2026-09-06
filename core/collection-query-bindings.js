/** Production bindings for collection query execution; no retrieval policy lives here. */
import { getBackend, getBackendForCollection, recordQuery, recordError } from '../backends/backend-manager.js';
import { resolveBackendForCollection, parseRegistryKey, COLLECTION_PREFIXES } from './collection-ids.js';
import { getOverfetchAmount } from './keyword-boost.js';
import { applyBM25Scoring, createBM25Scorer, porterStemmer } from './bm25-scorer.js';
import { extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken } from './query-keyword-extractor.js';
import { log } from './log.js';
import { createCollectionQueryExecution } from './collection-query-execution.js';

export function bindCollectionQueries(getAdditionalArgs) {
    return createCollectionQueryExecution({
        getBackend, getBackendForCollection, getAdditionalArgs,
        recordQuery: (...args) => recordQuery(...args),
        recordError: (...args) => recordError(...args),
        resolveBackendForCollection, parseRegistryKey, COLLECTION_PREFIXES,
        getOverfetchAmount,
        applyBM25Scoring: (...args) => applyBM25Scoring(...args),
        createBM25Scorer, porterStemmer, extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken, log,
        getCorpusStats: async (...args) => (await import('./corpus-stats.js')).getCorpusStats(...args),
    });
}

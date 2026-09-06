import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/log.js', () => ({ log: {
    trace: vi.fn(), verbose: vi.fn(), lifecycle: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false,
} }));
vi.mock('../../../../../script.js', () => ({ substituteParams: text => text, getCurrentChatId: () => 'chat', chat_metadata: {} }));
vi.mock('../../../../extensions.js', () => ({ getContext: () => ({}) }));

import { createCollectionQueryExecution } from '../core/collection-query-execution.js';
import { resolveBackendForCollection, parseRegistryKey, COLLECTION_PREFIXES } from '../core/collection-ids.js';
import { applyBM25Scoring, createBM25Scorer, porterStemmer } from '../core/bm25-scorer.js';
import { getOverfetchAmount } from '../core/keyword-boost.js';
import { extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken } from '../core/query-keyword-extractor.js';
import { log } from '../core/log.js';

const raw = () => ({ hashes: [1, 2], metadata: [
    { text: 'dragon fire', score: 0.8, arbitrary: { preserved: true } },
    { text: 'sword', score: 0 },
] });

function fixture({ native = false } = {}) {
    const backend = {
        supportsHybridSearch: () => native,
        queryCollection: vi.fn(async () => raw()),
        queryMultipleCollections: vi.fn(async ids => Object.fromEntries(ids.map(id => [id, raw()]))),
        hybridQuery: vi.fn(async () => raw()),
    };
    const deps = {
        getBackend: vi.fn(async () => backend),
        getBackendForCollection: vi.fn(async () => backend),
        getAdditionalArgs: vi.fn(async ([text]) => ({ embeddings: { [text]: [0.1, 0.2] } })),
        recordQuery: vi.fn(), recordError: vi.fn(),
        getCorpusStats: vi.fn(async () => null),
        resolveBackendForCollection, parseRegistryKey, COLLECTION_PREFIXES,
        applyBM25Scoring, createBM25Scorer, porterStemmer, getOverfetchAmount,
        extractQueryKeywords, RETRIEVAL_KEYWORD_LEVELS, isCJKToken, log,
    };
    return { backend, deps, queries: createCollectionQueryExecution(deps) };
}

describe('Collection query execution compatibility', () => {
    it('preserves metadata and raw scores through shared single/multiple scoring', async () => {
        const { queries, backend } = fixture();
        const settings = { source: 'openai', score_threshold: 0.7 };
        const single = await queries.queryCollection('standard:docs', 'dragon', 2, settings);
        const multiple = await queries.queryMultipleCollections(['docs', 'other'], 'dragon', 2, 0.3, settings);
        expect(multiple.docs).toEqual(single);
        expect(multiple.other.hashes).toHaveLength(2);
        const first = single.metadata[single.hashes.indexOf(1)];
        expect(first).toMatchObject({ arbitrary: { preserved: true }, vectorScore: 0.8 });
        expect(single.metadata[single.hashes.indexOf(2)].vectorScore).toBe(0);
        expect(backend.queryCollection).toHaveBeenCalledWith('docs', 'dragon', getOverfetchAmount(2), settings, null);
        expect(backend.queryMultipleCollections).toHaveBeenCalledWith(['docs', 'other'], 'dragon', getOverfetchAmount(2), 0.3, settings, null);
    });

    it('embeds once per multiple query and once per single query, before concepts are appended', async () => {
        const { queries, backend, deps } = fixture();
        const settings = { source: 'webllm' };
        await queries.queryMultipleCollections(['a', 'b'], 'dragon', 2, 0, settings);
        expect(deps.getAdditionalArgs).toHaveBeenCalledTimes(1);
        await queries.queryCollection('a', 'dragon', 2, settings, { concepts_any: ['fire'] });
        await queries.queryCollection('b', 'dragon', 2, settings);
        expect(deps.getAdditionalArgs).toHaveBeenCalledTimes(3);
        expect(deps.getAdditionalArgs).toHaveBeenNthCalledWith(2, ['dragon'], settings);
        expect(backend.queryCollection).toHaveBeenNthCalledWith(1, 'a', 'dragon fire', getOverfetchAmount(2), settings, [0.1, 0.2]);
    });

    it('falls back to server embeddings when client embedding fails', async () => {
        const { queries, backend, deps } = fixture();
        deps.getAdditionalArgs.mockRejectedValue(new Error('embedding offline'));
        const settings = { source: 'webllm' };
        await queries.queryCollection('a', 'dragon', 1, settings);
        expect(backend.queryCollection.mock.calls[0][4]).toBeNull();
    });

    it('keeps raw-query rejections and hybrid vector failures distinct', async () => {
        const { queries, backend, deps } = fixture();
        const failure = new Error('offline');
        backend.queryCollection.mockRejectedValue(failure);
        await expect(queries.queryCollection('a', 'dragon', 2, {})).rejects.toBe(failure);
        expect(deps.recordError).toHaveBeenCalledWith('standard', failure);
        await expect(queries.hybridSearch('a', 'dragon', 2, {})).resolves.toEqual({ hashes: [], metadata: [] });
        backend.queryMultipleCollections.mockRejectedValue(failure);
        await expect(queries.queryMultipleCollections(['a'], 'dragon', 2, 0.5, {})).rejects.toBe(failure);
    });

    it('preserves hybrid batch failure isolation and omits the bulk threshold', async () => {
        const { queries, backend, deps } = fixture({ native: true });
        deps.getBackendForCollection.mockImplementation(async name => {
            if (name === 'qdrant') throw new Error('unavailable backend');
            return backend;
        });
        const result = await queries.queryMultipleCollections(['qdrant:a', 'standard:b'], 'dragon', 2, 0.95, {});
        expect(result['qdrant:a']).toEqual({ hashes: [], metadata: [] });
        expect(result['standard:b'].hashes).toEqual([1, 2]);
        expect(backend.queryMultipleCollections).not.toHaveBeenCalled();
        expect(backend.hybridQuery.mock.calls[0][2]).toBe(2);
        expect(backend.hybridQuery.mock.calls[0]).not.toContain(0.95);
    });

    it('retains single-query bare-ID re-resolution on the hybrid path', async () => {
        const { queries, backend, deps } = fixture({ native: true });
        await queries.queryCollection('qdrant:legacy', 'dragon', 2, {});
        expect(deps.getBackendForCollection).toHaveBeenCalledWith('qdrant', {});
        expect(deps.getBackend).toHaveBeenCalledTimes(1);
        expect(backend.hybridQuery.mock.calls[0][0]).toBe('legacy');
    });

    it('keeps native filters and current filter omission on client fallback', async () => {
        const { queries, backend } = fixture({ native: true });
        backend.hybridQuery.mockRejectedValue(new Error('native unavailable'));
        const filters = { concepts_any: ['fire'], speaker: 'someone' };
        const result = await queries.hybridSearch('docs', 'dragon', 2, {}, { filters });
        expect(backend.hybridQuery.mock.calls[0].at(-1)).toEqual(filters);
        expect(backend.queryCollection.mock.calls[0]).toHaveLength(5);
        expect(result.metadata[0]).toHaveProperty('vectorScore');
        expect(result.metadata[0]).toHaveProperty('textScore');
    });

    it.each(['single', 'hybrid'])('retains candidates when corpus IDF fails on %s', async mode => {
        const { queries, deps } = fixture();
        deps.getCorpusStats.mockRejectedValue(new Error('corpus unavailable'));
        const settings = { bm25_use_corpus_idf: true };
        const result = mode === 'single'
            ? await queries.queryCollection('docs', 'dragon', 2, settings)
            : await queries.hybridSearch('docs', 'dragon', 2, settings);
        expect(result.hashes).toHaveLength(2);
        expect(result.metadata.find(m => m.arbitrary)?.arbitrary).toEqual({ preserved: true });
    });
});

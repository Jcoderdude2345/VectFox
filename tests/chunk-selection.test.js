import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ registry: [], metadata: {}, results: {}, events: [], debug: null, prompts: {} }));
vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: () => 'chat', is_send_press: false, extension_prompts: state.prompts,
    setExtensionPrompt: (tag, value, position, depth) => {
        state.events.push(['prompt', tag, value]);
        state.prompts[tag] = { value, position, depth };
    }, substituteParams: text => text,
    getRequestHeaders: () => ({}), chat_metadata: { integrity: 'chat' },
}));
vi.mock('../../../../extensions.js', () => ({ getContext: () => ({}), extension_settings: {} }));
vi.mock('../../../../utils.js', () => ({ getStringHash: text => text === 'duplicate' ? 99 : 999 }));
vi.mock('../core/chunking.js', () => ({}));
vi.mock('../core/text-cleaning.js', () => ({}));
vi.mock('../core/eventbase-workflow.js', () => ({
    runEventBaseRetrieval: async () => { state.events.push(['eventbase']); },
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../backends/backend-manager.js', () => ({ isBackendAvailable: vi.fn() }));
vi.mock('../core/keyword-boost.js', () => ({ extractChatKeywords: () => [{ text: 'dragon' }] }));
vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: async (id, text, topK) => {
        state.events.push(['query', id, text, topK]);
        if (state.results[id] instanceof Error) throw state.results[id];
        return state.results[id];
    },
    getSavedHashes: async () => ({ hashes: [], metadata: [] }),
}));
vi.mock('../core/collection-loader.js', () => ({
    getCollectionRegistry: () => state.registry, isCollectionEmpty: () => false,
}));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, filterActiveCollections: async ids => ids,
    getChunkMetadata: hash => state.metadata[hash], getCollectionMeta: () => ({}),
}));
vi.mock('../ui/search-debug.js', async importOriginal => {
    const original = await importOriginal();
    return { ...original, setLastSearchDebug: data => { state.debug = data; } };
});
import { rearrangeChat } from '../core/chat-vectorization.js';
import { createChunkSelection } from '../core/chunk-retrieval-selection.js';
import { buildSearchContext, filterChunksByConditions } from '../core/conditional-activation.js';
import { parseRegistryKey, COLLECTION_PREFIXES, INTERNAL_COLLECTION_IDS } from '../core/collection-ids.js';
import { EXTENSION_PROMPT_TAG, RETRIEVAL_TIMEOUT_MS } from '../core/constants.js';

const settings = { query: 1, top_k: 1, score_threshold: 0.5, retrieval_popup_on_start: true,
    retrieval_popup_on_result: true, position: 0, depth: 0 };
const response = (...metadata) => ({ hashes: metadata.map(m => m.hash), metadata });

beforeEach(() => {
    state.registry = ['standard:docs-a', 'standard:docs-b'];
    state.metadata = {};
    state.results = {};
    state.events = [];
    state.debug = null;
    for (const key of Object.keys(state.prompts)) delete state.prompts[key];
    vi.stubGlobal('window', {});
    vi.stubGlobal('toastr', {
        info: () => state.events.push(['start']), success: () => state.events.push(['result']),
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function makeSelection({ query, saved, rerank, empty = () => false, enabled = () => true } = {}) {
    const history = {};
    return createChunkSelection({
        host: {
            calculateHash: text => text === 'duplicate' ? 99 : 999,
            substituteParams: text => text,
            getCollectionRegistry: () => state.registry,
            isCollectionEmpty: empty, isCollectionEnabled: enabled,
            filterActiveCollections: async ids => ids,
            getChunkMetadata: hash => state.metadata[hash],
            getContext: () => ({}), getCurrentChatId: () => 'chat',
            getActivationHistory: () => history,
            trackChunkActivation: (hash, count) => {
                state.events.push(['activation', hash]);
                history[hash] = { count: (history[hash]?.count || 0) + 1, lastActivation: count };
            },
            notifyStart: () => state.events.push(['start']),
            notifyResult: () => state.events.push(['result']),
            publishSearch: data => state.events.push(['visualizer', data.chunks.map(c => c.hash)]),
            fetch: rerank, getRequestHeaders: () => ({}),
            log: Object.fromEntries(['trace', 'verbose', 'lifecycle', 'warn', 'error'].map(k => [k, vi.fn()])),
        },
        queries: {
            queryCollection: query || (async id => state.results[id]),
            getSavedHashes: saved || (async () => ({ hashes: [], metadata: [] })),
        },
        rules: {
            extractChatKeywords: () => [{ text: 'dragon' }, { text: 'fire' }],
            buildSearchContext, filterChunksByConditions,
            parseRegistryKey, COLLECTION_PREFIXES, INTERNAL_COLLECTION_IDS,
        },
    });
}

const request = overrides => ({ chat: [{ mes: 'question' }], settings, generationType: 'normal', ...overrides });

describe('Related-chunk compatibility through selection', () => {
    it.each([false, true])('retains last-summary-wins identity, across collections: %s', async acrossCollections => {
        state.registry = acrossCollections ? ['a', 'b'] : ['a'];
        const summaries = [
            { hash: 10, text: 'first summary', score: 0.9, isSummary: true, parentHash: 2 },
            { hash: 11, text: 'last summary', score: 0.7, isSummary: true, parentHash: 2 },
        ];
        state.results.a = response(...(acrossCollections ? summaries.slice(0, 1) : summaries));
        state.results.b = response(summaries[1]);
        const saved = vi.fn(async id => response({ hash: 2, text: `parent from ${id}` }));
        const result = await makeSelection({ saved }).select(request());
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]).toMatchObject({ hash: '2', score: 0.7,
            text: `parent from ${acrossCollections ? 'b' : 'a'}`, metadata: { originalSummaryHash: 11 } });
        expect(saved).toHaveBeenCalledTimes(1);
    });

    it('retains an already-retrieved parent alongside its string-hash expansion', async () => {
        state.registry = ['a'];
        state.results.a = response(
            { hash: 1, text: 'summary', score: 0.9, isSummary: true, parentHash: 2 },
            { hash: 2, text: 'parent', score: 0.8 },
        );
        const result = await makeSelection({ saved: async () => response({ hash: 2, text: 'parent' }) }).select(request());
        expect(result.chunks.map(c => c.hash)).toEqual([2, '2']);
    });

    it.each(['missing', 'unavailable', 'failed'])('retains summaries and omits force targets when storage is %s', async mode => {
        state.registry = ['a'];
        state.results.a = response(
            { hash: 1, text: 'summary', score: 0.9, isSummary: true, parentHash: 2 },
            { hash: 3, text: 'source', score: 0.8, chunkLinks: [{ targetHash: '4', mode: 'force' }] },
        );
        const saved = vi.fn(async () => {
            if (mode === 'failed') throw new Error('storage failed');
            return mode === 'missing' ? response() : [1, 3];
        });
        const result = await makeSelection({ saved }).select(request());
        expect(result.chunks.map(c => c.hash)).toEqual([3, 1]);
        expect(result.chunks[1].text).toBe('summary');
        expect(saved).toHaveBeenCalledTimes(2);
    });

    it('does not follow fetched targets recursively and still deduplicates them against chat', async () => {
        state.registry = ['a'];
        state.results.a = response({ hash: 1, text: 'source', score: 0.9, chunkLinks: [{ targetHash: '99', mode: 'force' }] });
        const saved = vi.fn(async () => response(
            { hash: 99, text: 'duplicate', chunkLinks: [{ targetHash: '3', mode: 'force' }] },
            { hash: 3, text: 'next link' },
        ));
        const result = await makeSelection({ saved }).select(request({ chat: [{ mes: 'duplicate' }] }));
        expect(result.chunks.map(c => c.hash)).toEqual([1]);
        expect(result.skippedDuplicates.map(c => c.hash)).toEqual([99]);
        expect(saved).toHaveBeenCalledTimes(1);
    });

    it.each([2, '2'])('preserves numeric versus string soft-link targets: %s', async hash => {
        state.registry = ['a'];
        state.results.a = response(
            { hash: 1, text: 'source', score: 0.9, chunkLinks: [{ targetHash: '2', mode: 'soft' }] },
            { hash, text: 'target', score: 0.6 },
        );
        const result = await makeSelection().select(request());
        expect(result.chunks[1].score).toBe(typeof hash === 'number' ? 0.75 : 0.6);
    });

    it('uses the last source collection when two collections force the same hash', async () => {
        state.registry = ['a', 'b'];
        state.results.a = response({ hash: 1, text: 'a', score: 0.9, chunkLinks: [{ targetHash: '3', mode: 'force' }] });
        state.results.b = response({ hash: 2, text: 'b', score: 0.8, chunkLinks: [{ targetHash: '3', mode: 'force' }] });
        const saved = vi.fn(async id => response({ hash: 3, text: id }));
        const result = await makeSelection({ saved }).select(request());
        expect(saved).toHaveBeenCalledTimes(1);
        expect(saved).toHaveBeenCalledWith('b', settings, true);
        expect(result.chunks[2]).toMatchObject({ hash: 3, text: 'b', collectionId: 'b', score: 1 });
    });
});

describe('Chunk retrieval selection interface', () => {
    it.each([
        [{ keywords: ['DRAGON'] }, {}, true],
        [{ keywords: [] }, { keywords: [{ text: 'Dragon' }] }, true],
        [{}, { keywords: ['dragon'] }, true],
        [{ keywords: ['sword'] }, { keywords: ['dragon'] }, false],
        [{}, {}, false],
    ])('uses backend keywords first and saved metadata as fallback: %j', async (metadata, savedMetadata, boosted) => {
        state.registry = ['standard:docs-a'];
        state.metadata[1] = savedMetadata;
        state.results['standard:docs-a'] = response({ hash: 1, text: 'entry', score: 0.6, ...metadata });
        const result = await makeSelection().select(request());
        expect(result.chunks[0].score).toBe(boosted ? 1 : 0.6);
        expect(result.chunks[0].keywordMatched).toBe(boosted ? true : undefined);
    });

    it('retains all matched keywords and their original score', async () => {
        state.registry = ['standard:docs-a'];
        state.results['standard:docs-a'] = response({ hash: 1, text: 'entry', score: 0.2, keywords: ['dragon', 'fire'] });
        const result = await makeSelection().select(request());
        expect(result.chunks[0]).toMatchObject({ score: 1, originalScore: 0.2, matchedQueryKeywords: ['dragon', 'fire'] });
    });

    it('excludes other workflows, internal, disabled and empty collections before querying', async () => {
        state.registry = [
            `standard:${COLLECTION_PREFIXES.VECTFOX_EVENTBASE}one`,
            `standard:${COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT}one`,
            `standard:${COLLECTION_PREFIXES.VECTFOX_LOREBOOK}one`,
            `standard:${INTERNAL_COLLECTION_IDS[0]}`, 'disabled', 'empty', 'kept',
        ];
        const query = vi.fn(async () => response());
        await makeSelection({ query, enabled: id => id !== 'disabled', empty: id => id === 'empty' }).select(request());
        expect(query.mock.calls.map(args => args[0])).toEqual(['kept']);
    });

    it('boosts summaries before expansion, reranks parents before threshold and forces links afterwards', async () => {
        state.registry = ['standard:docs-a'];
        state.results['standard:docs-a'] = response({ hash: 1, text: 'summary', score: 0.2,
            keywords: ['dragon'], isSummary: true, parentHash: 2 });
        const saved = vi.fn(async () => response(
            { hash: 2, text: 'parent', chunkLinks: [{ targetHash: '3', mode: 'force' }] },
            { hash: 3, text: 'forced', score: 0.01 },
        ));
        const rerank = vi.fn(async (url, options) => {
            expect(url).toBe('/api/plugins/similharity/rerank');
            expect(JSON.parse(options.body)).toMatchObject({ query: 'question', documents: ['parent'] });
            return { ok: true, json: async () => ({ results: [{ index: 0, score: 0.8 }] }) };
        });
        const result = await makeSelection({ saved, rerank }).select(request({
            settings: { ...settings, source: 'bananabread', bananabread_rerank: true },
        }));
        expect(result.chunks.map(c => c.hash)).toEqual(['2', 3]);
        expect(result.chunks[0]).toMatchObject({ score: 0.8, originalScore: 1 });
        expect(rerank).toHaveBeenCalledTimes(1);
        expect(result.chunks[1]).toMatchObject({ forceLinked: true, score: 1 });
        expect(saved).toHaveBeenCalledTimes(2);
        expect(saved).toHaveBeenCalledWith('standard:docs-a', expect.any(Object), true);
    });

    it('records activation before deduplication and reads history anew on the next selection', async () => {
        state.registry = ['standard:docs-a'];
        state.results['standard:docs-a'] = response({ hash: 99, text: 'duplicate', score: 0.9,
            conditions: { enabled: true, rules: [{ type: 'frequency', settings: { cooldownMessages: 5 } }] } });
        const selection = makeSelection();
        const first = await selection.select(request({ chat: [{ mes: 'duplicate' }] }));
        expect(first.chunks).toEqual([]);
        expect(first.skippedDuplicates).toHaveLength(1);
        expect(state.events).toEqual([['start'], ['result'], ['activation', 99], ['visualizer', [99]]]);
        const second = await selection.select(request({ chat: [{ mes: 'duplicate' }] }));
        expect(second.skippedDuplicates).toEqual([]);
        expect(state.events.filter(e => e[0] === 'activation')).toHaveLength(1);
    });

    it('keeps the soft query timeout without cancelling or waiting for late queries', async () => {
        vi.useFakeTimers();
        state.registry = ['standard:docs-a'];
        let finish;
        const query = () => new Promise(resolve => { finish = resolve; });
        const pending = makeSelection({ query }).select(request());
        await vi.advanceTimersByTimeAsync(RETRIEVAL_TIMEOUT_MS);
        const result = await pending;
        expect(result.chunks).toEqual([]);
        finish(response({ hash: 1, text: 'late', score: 0.9 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(result.chunks).toEqual([]);
        expect(state.events).toEqual([['start'], ['result'], ['visualizer', []]]);
    });
});

describe('Chunk retrieval selection compatibility through the generation entry point', () => {
    it('keeps generation prompt grouping and clearing distinct from preview formatting', async () => {
        state.results['standard:docs-a'] = response({ hash: 1, text: 'first entry', score: 0.9, position: 0, depth: 1 });
        state.results['standard:docs-b'] = response({ hash: 2, text: 'second entry', score: 0.8, position: 1, depth: 2 });
        state.prompts[`${EXTENSION_PROMPT_TAG}_pos9`] = { value: 'stale' };
        const chat = [{ mes: 'question' }];
        await rearrangeChat(chat, settings, 'normal');
        expect(state.debug.injection.verified).toBe(true);
        expect(state.prompts[`${EXTENSION_PROMPT_TAG}_pos0`]).toMatchObject({ position: 0, depth: 1 });
        expect(state.prompts[`${EXTENSION_PROMPT_TAG}_pos1`]).toMatchObject({ position: 1, depth: 2 });
        expect(state.prompts[`${EXTENSION_PROMPT_TAG}_pos9`].value).toBe('');
        expect(state.events.slice(0, 3)).toEqual([
            ['prompt', EXTENSION_PROMPT_TAG, ''], ['prompt', `${EXTENSION_PROMPT_TAG}_pos9`, ''], ['eventbase'],
        ]);
        state.events = [];
        const preview = await rearrangeChat(chat, settings, 'normal', { dryRun: true });
        expect(preview.injectionText).toContain('first entry');
        expect(preview.injectionText).toContain('second entry');
        expect(state.events.some(e => e[0] === 'prompt' || e[0] === 'eventbase')).toBe(false);
    });

    it('preserves zero scores, keyword fallback, per-collection limits and preview effects', async () => {
        state.metadata[2] = { keywords: [{ text: 'dragon' }] };
        state.results['standard:docs-a'] = response({ hash: 1, text: 'zero', score: 0 });
        state.results['standard:docs-b'] = response({ hash: 2, text: 'boosted', score: 0.2 });
        const result = await rearrangeChat([{ mes: 'question' }], settings, 'normal', { dryRun: true });
        expect(result.chunkCount).toBe(2);
        expect(state.debug.stages.afterThreshold.map(c => c.score)).toEqual([1, 1]);
        expect(state.debug.stages.afterThreshold[1].originalScore).toBe(0.2);
        expect(state.events).toEqual([
            ['start'], ['query', 'standard:docs-a', 'question', 1],
            ['query', 'standard:docs-b', 'question', 1], ['result'],
        ]);
        expect(window.VectFox_LastSearch.chunks).toHaveLength(2);
    });

    it('continues after an individual query failure and publishes before deduplication', async () => {
        state.results['standard:docs-a'] = new Error('offline');
        state.results['standard:docs-b'] = response({ hash: 99, text: 'duplicate', score: 0.9 });
        const result = await rearrangeChat([{ mes: 'duplicate' }], settings, 'normal', { dryRun: true });
        expect(result).toEqual({ injectionText: null, chunkCount: 0, allDuplicates: true });
        expect(window.VectFox_LastSearch.chunks.map(c => c.hash)).toEqual([99]);
        expect(state.debug.stats.skippedDuplicates).toBe(1);
    });
});


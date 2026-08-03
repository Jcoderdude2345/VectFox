/**
 * Characterization tests for core/corpus-stats.js
 *
 * The module is a lazy, session-scoped cache in front of the plugin's
 * /chunks/list endpoint that builds BM25 corpus statistics (N, per-term document
 * frequency, average document length). These tests pin the cache/in-flight
 * dedup lifecycle, the plugin gate, the request shape, the df/avgLen math, and
 * the "return null, never throw" failure contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

// Whitespace tokenizer stand-in: keeps the df math readable and independent of
// the real CJK tokenizer chain.
vi.mock('../core/bm25-scorer.js', () => ({
    tokenize: (text) => String(text).toLowerCase().split(/\s+/).filter(Boolean),
}));

vi.mock('../core/providers.js', () => ({
    getModelFromSettings: (settings) => settings?.model || 'resolved-model',
}));

const pluginAvailable = { value: true, throws: false };
vi.mock('../core/collection-loader.js', () => ({
    checkPluginAvailable: async () => {
        if (pluginAvailable.throws) throw new Error('probe exploded');
        return pluginAvailable.value;
    },
}));

import { getCorpusStats, clearCorpusStatsCache } from '../core/corpus-stats.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const listResponse = (items) => ({ ok: true, status: 200, json: async () => ({ items }) });

const settings = (overrides = {}) => ({
    vector_backend: 'standard',
    source: 'transformers',
    ...overrides,
});

let collectionCounter = 0;
/** Unique id per test — the module cache is process-wide and never reset between tests. */
const freshId = () => `col-${++collectionCounter}`;

beforeEach(() => {
    pluginAvailable.value = true;
    pluginAvailable.throws = false;
    globalThis.fetch = vi.fn();
    clearCorpusStatsCache();
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Guards and the plugin gate
// ---------------------------------------------------------------------------

describe('guards', () => {
    it('returns null for a falsy collectionId without touching the network', async () => {
        expect(await getCorpusStats('', settings())).toBeNull();
        expect(await getCorpusStats(null, settings())).toBeNull();
        expect(await getCorpusStats(undefined, settings())).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns null and skips the fetch entirely when the plugin is unavailable', async () => {
        pluginAvailable.value = false;
        expect(await getCorpusStats(freshId(), settings())).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('does NOT cache a null from the plugin gate — a later call retries', async () => {
        const id = freshId();
        pluginAvailable.value = false;
        expect(await getCorpusStats(id, settings())).toBeNull();

        pluginAvailable.value = true;
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'alpha' }]));
        expect(await getCorpusStats(id, settings())).toMatchObject({ totalDocs: 1 });
    });

    it('attempts the fetch anyway when the plugin probe itself throws', async () => {
        pluginAvailable.throws = true;
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'alpha beta' }]));
        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.totalDocs).toBe(1);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('the /chunks/list request', () => {
    beforeEach(() => globalThis.fetch.mockResolvedValue(listResponse([])));

    it('POSTs to the similharity plugin endpoint with ST request headers', async () => {
        const id = freshId();
        await getCorpusStats(id, settings());
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/plugins/similharity/chunks/list');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'tok' });
        expect(JSON.parse(init.body)).toEqual({
            backend: 'vectra',
            collectionId: id,
            source: 'transformers',
            model: 'resolved-model',
            limit: 10000,
            includeVectors: false,
        });
    });

    it('maps the "standard" backend to the plugin name "vectra"', async () => {
        await getCorpusStats(freshId(), settings({ vector_backend: 'standard' }));
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).backend).toBe('vectra');
    });

    it('defaults to "vectra" when no backend is configured', async () => {
        await getCorpusStats(freshId(), {});
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).backend).toBe('vectra');
    });

    it('passes any other backend through, lowercased', async () => {
        await getCorpusStats(freshId(), settings({ vector_backend: 'QDRANT' }));
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).backend).toBe('qdrant');
    });

    it('defaults source to "transformers" when unset', async () => {
        await getCorpusStats(freshId(), { vector_backend: 'qdrant' });
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).source).toBe('transformers');
    });

    it('caps the fetch at 10000 chunks — larger collections are silently truncated', async () => {
        await getCorpusStats(freshId(), settings());
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).limit).toBe(10000);
    });

    it('tolerates a completely missing settings object', async () => {
        expect(await getCorpusStats(freshId(), undefined)).toMatchObject({ totalDocs: 0 });
    });
});

// ---------------------------------------------------------------------------
// Statistics math
// ---------------------------------------------------------------------------

describe('statistics computation', () => {
    it('computes totalDocs, document frequencies and avgDocLength', async () => {
        globalThis.fetch.mockResolvedValue(listResponse([
            { text: 'the quick brown fox' },       // 4 tokens
            { text: 'the lazy dog' },              // 3 tokens
            { text: 'the fox and the dog' },       // 5 tokens
        ]));

        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.totalDocs).toBe(3);
        expect(stats.avgDocLength).toBe(4); // (4 + 3 + 5) / 3
        expect(stats.documentFrequencies).toBeInstanceOf(Map);
        expect(stats.documentFrequencies.get('the')).toBe(3);
        expect(stats.documentFrequencies.get('fox')).toBe(2);
        expect(stats.documentFrequencies.get('quick')).toBe(1);
        expect(stats.documentFrequencies.has('missing')).toBe(false);
    });

    it('counts each term once per document, not once per occurrence', async () => {
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'dog dog dog dog' }]));
        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.documentFrequencies.get('dog')).toBe(1);
        expect(stats.avgDocLength).toBe(4); // length still counts every occurrence
    });

    it('reads chunk text from item.text, falling back to item.metadata.text', async () => {
        globalThis.fetch.mockResolvedValue(listResponse([
            { text: 'top level' },
            { metadata: { text: 'nested only' } },
        ]));
        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.documentFrequencies.get('level')).toBe(1);
        expect(stats.documentFrequencies.get('nested')).toBe(1);
    });

    it('counts empty chunks in totalDocs but not in the length total — deflating avgDocLength', () => {
        // BUG-SHAPED: `skipped++` bumps past the text accumulation but the
        // divisor stays items.length, so empty chunks drag avgDocLength down
        // and inflate N for the IDF formula.
        globalThis.fetch.mockResolvedValue(listResponse([
            { text: 'one two three four' }, // 4 tokens
            { text: '' },
            { metadata: {} },
            {},
        ]));
        return getCorpusStats(freshId(), settings()).then(stats => {
            expect(stats.totalDocs).toBe(4);
            expect(stats.avgDocLength).toBe(1); // 4 / 4, not 4 / 1
        });
    });

    it('returns zeroed stats for an empty collection without dividing by zero', async () => {
        globalThis.fetch.mockResolvedValue(listResponse([]));
        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.totalDocs).toBe(0);
        expect(stats.avgDocLength).toBe(0);
        expect(stats.documentFrequencies.size).toBe(0);
    });

    it('treats a non-array items payload as an empty corpus', async () => {
        globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: 'oops' }) });
        expect(await getCorpusStats(freshId(), settings())).toMatchObject({ totalDocs: 0 });

        globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        expect(await getCorpusStats(freshId(), settings())).toMatchObject({ totalDocs: 0 });
    });

    it('stamps builtAt with a wall-clock timestamp', async () => {
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'a' }]));
        const before = Date.now();
        const stats = await getCorpusStats(freshId(), settings());
        expect(stats.builtAt).toBeGreaterThanOrEqual(before);
        expect(stats.builtAt).toBeLessThanOrEqual(Date.now());
    });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('failure handling', () => {
    it('returns null (never throws) on a non-OK HTTP response', async () => {
        globalThis.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
        expect(await getCorpusStats(freshId(), settings())).toBeNull();
    });

    it('returns null when the network request rejects', async () => {
        globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await getCorpusStats(freshId(), settings())).toBeNull();
    });

    it('returns null when the response body is not JSON', async () => {
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        });
        expect(await getCorpusStats(freshId(), settings())).toBeNull();
    });

    it('does NOT cache a failure — the next call retries the fetch', async () => {
        const id = freshId();
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        expect(await getCorpusStats(id, settings())).toBeNull();

        globalThis.fetch.mockResolvedValueOnce(listResponse([{ text: 'recovered now' }]));
        expect(await getCorpusStats(id, settings())).toMatchObject({ totalDocs: 1 });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Caching and in-flight dedup
// ---------------------------------------------------------------------------

describe('caching', () => {
    it('fetches once per collection and serves the identical object thereafter', async () => {
        const id = freshId();
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'alpha beta' }]));

        const first = await getCorpusStats(id, settings());
        const second = await getCorpusStats(id, settings());
        expect(globalThis.fetch).toHaveBeenCalledOnce();
        expect(second).toBe(first); // same instance, not a copy
    });

    it('ignores settings changes once cached — the cache key is the collectionId alone', async () => {
        const id = freshId();
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'alpha' }]));
        await getCorpusStats(id, settings({ vector_backend: 'standard' }));
        await getCorpusStats(id, settings({ vector_backend: 'qdrant', source: 'openai' }));
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it('caches collections independently', async () => {
        const a = freshId();
        const b = freshId();
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'x' }]));
        await getCorpusStats(a, settings());
        await getCorpusStats(b, settings());
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('dedupes concurrent calls into a single in-flight fetch', async () => {
        const id = freshId();
        let release;
        globalThis.fetch.mockReturnValue(new Promise(r => { release = () => r(listResponse([{ text: 'a b' }])); }));

        const p1 = getCorpusStats(id, settings());
        const p2 = getCorpusStats(id, settings());
        const p3 = getCorpusStats(id, settings());
        release();

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
        expect(r2).toBe(r1);
        expect(r3).toBe(r1);
    });

    it('clears the in-flight entry after settling so later calls are not stuck', async () => {
        const id = freshId();
        globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        await getCorpusStats(id, settings());
        globalThis.fetch.mockResolvedValueOnce(listResponse([{ text: 'now works' }]));
        expect(await getCorpusStats(id, settings())).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

describe('clearCorpusStatsCache', () => {
    it('forces a rebuild for the named collection only', async () => {
        const a = freshId();
        const b = freshId();
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'x' }]));
        await getCorpusStats(a, settings());
        await getCorpusStats(b, settings());
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);

        clearCorpusStatsCache(a);
        await getCorpusStats(a, settings()); // rebuilds
        await getCorpusStats(b, settings()); // still cached
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('clears every collection when called with no argument', async () => {
        const a = freshId();
        const b = freshId();
        globalThis.fetch.mockResolvedValue(listResponse([{ text: 'x' }]));
        await getCorpusStats(a, settings());
        await getCorpusStats(b, settings());

        clearCorpusStatsCache();
        await getCorpusStats(a, settings());
        await getCorpusStats(b, settings());
        expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    });

    it('is a silent no-op for an unknown collection id', async () => {
        expect(() => clearCorpusStatsCache('never-existed')).not.toThrow();
    });

    it('rebuilds with fresh data after invalidation', async () => {
        const id = freshId();
        globalThis.fetch.mockResolvedValueOnce(listResponse([{ text: 'one' }]));
        expect((await getCorpusStats(id, settings())).totalDocs).toBe(1);

        clearCorpusStatsCache(id);
        globalThis.fetch.mockResolvedValueOnce(listResponse([{ text: 'one' }, { text: 'two' }]));
        expect((await getCorpusStats(id, settings())).totalDocs).toBe(2);
    });

    it('does NOT cancel an in-flight build — the pending promise still resolves and callers get stats', async () => {
        // Clearing mid-flight drops the dedup entry but the already-started
        // `.then(...)` still writes its result into the cache afterwards.
        const id = freshId();
        let release;
        globalThis.fetch.mockReturnValue(new Promise(r => { release = () => r(listResponse([{ text: 'a' }])); }));

        const pending = getCorpusStats(id, settings());
        clearCorpusStatsCache(id);
        release();
        expect(await pending).toMatchObject({ totalDocs: 1 });
    });
});

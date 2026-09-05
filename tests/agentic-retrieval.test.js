/**
 * Characterization tests for core/agentic-retrieval.js
 *
 * retrieveEventsWithAgent() wraps retrieveEvents() with an optional LLM
 * planning step. Everything about it is "additive or nothing": each gate and
 * each failure mode must return the untouched pre-search result. These tests
 * pin the gate order, the query/filter validators, the Qdrant fan-out shape,
 * the merge back into retrieveEvents, and the debug annotations.
 *
 * retrieveEvents and queryCollection are stubbed — this is a unit test of the
 * orchestration, not of the re-ranker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

const { chatState, retrieveEvents, queryCollection, keys } = vi.hoisted(() => ({
    chatState: { chat: [] },
    retrieveEvents: vi.fn(),
    queryCollection: vi.fn(),
    keys: { openrouter: 'or-masked', custom: 'custom-masked' },
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: () => chatState,
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection }));
vi.mock('../core/api-keys.js', () => ({
    getOpenRouterApiKey: () => keys.openrouter,
    getCustomApiKey: () => keys.custom,
}));
vi.mock('../core/model-config-notifier.js', () => ({
    isInvalidModelConfigError: (e) => e?.code === 'invalid_model_config',
    notifyInvalidModel: vi.fn(),
}));

import {
    retrieveEventsWithAgent,
    _resolveAgenticLLMConfig,
    _validatePlannerFilters,
} from '../core/agentic-retrieval.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function agenticSettings(overrides = {}) {
    return {
        agentic_retrieval_enabled: true,
        vector_backend: 'qdrant',
        agentic_retrieval_provider: 'openrouter',
        agentic_retrieval_model: 'anthropic/claude-3-haiku',
        ...overrides,
    };
}

function params(overrides = {}) {
    return {
        settings: agenticSettings(),
        liveCollectionIds: ['col-a'],
        keywordQuery: 'what happened at the docks?',
        searchText: 'docks',
        additionalCandidates: [],
        ...overrides,
    };
}

const preSearchResult = (events = [{ event_id: 'e1', text: 'pre-search hit', _finalScore: 0.8 }]) =>
    ({ events, debug: { source: 'pre-search' } });

const plannerReply = (plan, usage) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }], ...(usage ? { usage } : {}) }),
});

const lastPlannerBody = () => JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body);

beforeEach(() => {
    keys.openrouter = 'or-masked';
    keys.custom = 'custom-masked';
    chatState.chat = [];
    retrieveEvents.mockReset();
    queryCollection.mockReset().mockResolvedValue({ hashes: [], metadata: [] });
    globalThis.fetch = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// _resolveAgenticLLMConfig
// ---------------------------------------------------------------------------

describe('_resolveAgenticLLMConfig', () => {
    it('resolves a complete OpenRouter config', () => {
        expect(_resolveAgenticLLMConfig(agenticSettings()))
            .toEqual({ ok: true, provider: 'openrouter', model: 'anthropic/claude-3-haiku', apiKey: 'or-masked' });
    });

    it('inherits provider and model from the summarize_* settings when agentic ones are blank', () => {
        expect(_resolveAgenticLLMConfig({ summarize_provider: 'openrouter', summarize_model: 'inherited/model' }))
            .toMatchObject({ ok: true, model: 'inherited/model' });
    });

    it('prefers the agentic override over the inherited value', () => {
        expect(_resolveAgenticLLMConfig({
            agentic_retrieval_model: 'agentic/model',
            summarize_model: 'summarize/model',
        }).model).toBe('agentic/model');
    });

    it('defaults to openrouter when neither provider setting is present', () => {
        expect(_resolveAgenticLLMConfig({ summarize_model: 'm' }).provider).toBe('openrouter');
    });

    it('lowercases the provider name', () => {
        expect(_resolveAgenticLLMConfig({ agentic_retrieval_provider: 'OpenRouter', summarize_model: 'm' }).provider)
            .toBe('openrouter');
    });

    it('reports missing_model for an absent or whitespace-only model', () => {
        expect(_resolveAgenticLLMConfig({})).toEqual({ ok: false, reason: 'missing_model' });
        expect(_resolveAgenticLLMConfig({ summarize_model: '   ' })).toEqual({ ok: false, reason: 'missing_model' });
        expect(_resolveAgenticLLMConfig()).toEqual({ ok: false, reason: 'missing_model' });
    });

    it('reports missing_openrouter_api_key when the shared key is empty', () => {
        keys.openrouter = '';
        expect(_resolveAgenticLLMConfig(agenticSettings())).toEqual({ ok: false, reason: 'missing_openrouter_api_key' });
    });

    it('resolves a vLLM config, inheriting the summarize URL', () => {
        expect(_resolveAgenticLLMConfig({
            agentic_retrieval_provider: 'vllm',
            summarize_model: 'local/qwen',
            summarize_vllm_url: 'http://localhost:8000',
        })).toEqual({
            ok: true, provider: 'vllm', model: 'local/qwen',
            vllmUrl: 'http://localhost:8000', apiKey: 'custom-masked',
        });
    });

    it('reports missing_vllm_url and missing_vllm_api_key in that order', () => {
        expect(_resolveAgenticLLMConfig({ agentic_retrieval_provider: 'vllm', summarize_model: 'm' }))
            .toEqual({ ok: false, reason: 'missing_vllm_url' });
        keys.custom = '';
        expect(_resolveAgenticLLMConfig({
            agentic_retrieval_provider: 'vllm', summarize_model: 'm', summarize_vllm_url: 'http://h',
        })).toEqual({ ok: false, reason: 'missing_vllm_api_key' });
    });

    it('embeds the offending provider name in the unknown-provider reason', () => {
        expect(_resolveAgenticLLMConfig({ agentic_retrieval_provider: 'ollama', summarize_model: 'm' }))
            .toEqual({ ok: false, reason: 'unknown_provider_ollama' });
    });
});

// ---------------------------------------------------------------------------
// _validatePlannerFilters
// ---------------------------------------------------------------------------

describe('_validatePlannerFilters', () => {
    it('passes through the six known array fields', () => {
        const raw = {
            characters_any: ['Aria'], locations_any: ['Docks'], factions_any: ['Iron Company'],
            items_any: ['Sword'], concepts_any: ['betrayal'], event_type_any: ['combat'],
        };
        expect(_validatePlannerFilters(raw, {})).toEqual(raw);
    });

    it('drops unknown keys entirely', () => {
        expect(_validatePlannerFilters({ characters_any: ['A'], nonsense: ['B'], summary: 'x' }, {}))
            .toEqual({ characters_any: ['A'] });
    });

    it('trims strings, drops empties and non-strings, and dedupes', () => {
        expect(_validatePlannerFilters({ characters_any: ['  Aria  ', 'Aria', '', '  ', 42, null, 'Leon'] }, {}))
            .toEqual({ characters_any: ['Aria', 'Leon'] });
    });

    it('dedupes AFTER trimming, so " Aria" and "Aria" collapse', () => {
        expect(_validatePlannerFilters({ items_any: [' Sword', 'Sword ', 'Sword'] }, {}))
            .toEqual({ items_any: ['Sword'] });
    });

    it('is case-SENSITIVE when deduping', () => {
        expect(_validatePlannerFilters({ items_any: ['Sword', 'sword'] }, {}).items_any).toEqual(['Sword', 'sword']);
    });

    it('caps each field at 8 values', () => {
        const many = Array.from({ length: 20 }, (_, i) => `c${i}`);
        expect(_validatePlannerFilters({ characters_any: many }, {}).characters_any).toHaveLength(8);
    });

    it('omits a field whose values all wash out', () => {
        expect(_validatePlannerFilters({ characters_any: ['', '  ', 7] }, {})).toEqual({});
        expect(_validatePlannerFilters({ characters_any: [] }, {})).toEqual({});
    });

    it('rejects a non-array value for an array field', () => {
        expect(_validatePlannerFilters({ characters_any: 'Aria' }, {})).toEqual({});
    });

    it('clamps and rounds importance_gte into 1..10', () => {
        expect(_validatePlannerFilters({ importance_gte: 7 }, {}).importance_gte).toBe(7);
        expect(_validatePlannerFilters({ importance_gte: 0 }, {}).importance_gte).toBe(1);
        expect(_validatePlannerFilters({ importance_gte: -5 }, {}).importance_gte).toBe(1);
        expect(_validatePlannerFilters({ importance_gte: 99 }, {}).importance_gte).toBe(10);
        expect(_validatePlannerFilters({ importance_gte: 6.7 }, {}).importance_gte).toBe(7);
    });

    it('drops a non-finite or non-numeric importance_gte', () => {
        expect(_validatePlannerFilters({ importance_gte: '7' }, {})).toEqual({});
        expect(_validatePlannerFilters({ importance_gte: NaN }, {})).toEqual({});
        expect(_validatePlannerFilters({ importance_gte: Infinity }, {})).toEqual({});
    });

    it('returns {} for nullish or non-object input', () => {
        for (const bad of [null, undefined, 'x', 42, true]) {
            expect(_validatePlannerFilters(bad, {})).toEqual({});
        }
    });

    it('returns {} when agentic_filters_enabled is explicitly false', () => {
        expect(_validatePlannerFilters({ characters_any: ['Aria'] }, { agentic_filters_enabled: false })).toEqual({});
    });

    it('keeps filters when the flag is absent, true, or any non-false value (default ON)', () => {
        for (const flag of [undefined, true, 'yes', 0]) {
            expect(_validatePlannerFilters({ characters_any: ['Aria'] }, { agentic_filters_enabled: flag }))
                .toEqual({ characters_any: ['Aria'] });
        }
    });

    it('accepts arrays as input and returns {} — arrays have no known keys', () => {
        expect(_validatePlannerFilters(['characters_any'], {})).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// Gates: every one returns the pre-search result untouched
// ---------------------------------------------------------------------------

describe('early-exit gates', () => {
    const expectPassthrough = async (overrides) => {
        const pre = preSearchResult();
        retrieveEvents.mockResolvedValue(pre);
        const out = await retrieveEventsWithAgent(params(overrides));
        expect(out).toBe(pre); // identical object, not a rebuilt one
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(retrieveEvents).toHaveBeenCalledOnce();
    };

    it('always runs the pre-search first, even when agentic is off', async () => {
        await expectPassthrough({ settings: agenticSettings({ agentic_retrieval_enabled: false }) });
    });

    it('passes through when agentic_retrieval_enabled is missing', async () => {
        await expectPassthrough({ settings: { vector_backend: 'qdrant' } });
    });

    it('passes through on any non-Qdrant backend', async () => {
        await expectPassthrough({ settings: agenticSettings({ vector_backend: 'standard' }) });
        globalThis.fetch.mockClear();
        retrieveEvents.mockClear();
        await expectPassthrough({ settings: agenticSettings({ vector_backend: 'vectra' }) });
    });

    it('passes through when the LLM config is incomplete', async () => {
        keys.openrouter = '';
        await expectPassthrough({});
    });

    it('passes through when there are no live collections to fan out to', async () => {
        retrieveEvents.mockResolvedValue(preSearchResult());
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['a query'] }));
        const out = await retrieveEventsWithAgent(params({ liveCollectionIds: [] }));
        expect(out.debug.agenticMode).toBeUndefined();
        expect(queryCollection).not.toHaveBeenCalled();
    });

    it('tolerates settings being entirely absent', async () => {
        const pre = preSearchResult();
        retrieveEvents.mockResolvedValue(pre);
        expect(await retrieveEventsWithAgent({ settings: undefined })).toBe(pre);
    });
});

// ---------------------------------------------------------------------------
// Planner call
// ---------------------------------------------------------------------------

describe('planner LLM call', () => {
    beforeEach(() => retrieveEvents.mockResolvedValue(preSearchResult()));

    it('posts through ST\'s proxy, requesting a JSON object at low temperature', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['docks incident'] }));
        await retrieveEventsWithAgent(params());

        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/backends/chat-completions/generate');
        expect(JSON.parse(init.body)).toMatchObject({
            chat_completion_source: 'openrouter',
            model: 'anthropic/claude-3-haiku',
            temperature: 0.2,
            max_tokens: 2000,
            response_format: { type: 'json_object' },
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('sends the planner prompt as system and the built context as user', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        chatState.chat = [{ is_user: true, mes: 'I want to know about the docks.' }];
        await retrieveEventsWithAgent(params());

        const [system, user] = lastPlannerBody().messages;
        expect(system.role).toBe('system');
        expect(system.content).toContain('You are a retrieval planner');
        expect(user.role).toBe('user');
        expect(user.content).toContain('what happened at the docks?');
        expect(user.content).toContain('E1 [0.80] event — pre-search hit');
    });

    it('includes the final retrieval score in planner candidates', async () => {
        retrieveEvents.mockResolvedValue(preSearchResult([
            { event_id: 'e1', text: 'ranked hit', _finalScore: 0.93 },
        ]));
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        await retrieveEventsWithAgent(params());
        expect(lastPlannerBody().messages[1].content).toContain('E1 [0.93]');
    });

    it('does show a score when the candidate carries a plain `score` field', async () => {
        retrieveEvents.mockResolvedValue(preSearchResult([{ event_id: 'e1', text: 'hit', score: 0.42 }]));
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        await retrieveEventsWithAgent(params());
        expect(lastPlannerBody().messages[1].content).toContain('E1 [0.42]');
    });

    it('routes vLLM through the same proxy with custom_url', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        await retrieveEventsWithAgent(params({
            settings: agenticSettings({ agentic_retrieval_provider: 'vllm', agentic_retrieval_vllm_url: 'http://vllm:8000' }),
        }));
        expect(lastPlannerBody()).toMatchObject({ chat_completion_source: 'custom', custom_url: 'http://vllm:8000' });
    });

    it('reads recent non-system chat turns at the configured depth', async () => {
        chatState.chat = [
            { mes: 'oldest', name: 'Aria' },
            { mes: 'system note', is_system: true },
            { mes: 'middle', is_user: true },
            { mes: 'newest', name: 'Aria' },
        ];
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_chat_depth: 2 }) }));

        const user = lastPlannerBody().messages[1].content;
        expect(user).toContain('[-2] {{user}}: middle');
        expect(user).toContain('[-1] Aria: newest');
        expect(user).not.toContain('Aria: oldest');
        expect(user).not.toContain('system note');
    });

    it('clamps chat depth to 1..50 and defaults to 3', async () => {
        chatState.chat = Array.from({ length: 80 }, (_, i) => ({ mes: `m${i}`, is_user: true }));
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));

        await retrieveEventsWithAgent(params());
        expect(lastPlannerBody().messages[1].content).toContain('[-3]');
        expect(lastPlannerBody().messages[1].content).not.toContain('[-4]');

        await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_chat_depth: 500 }) }));
        expect(lastPlannerBody().messages[1].content).toContain('[-50]');
        expect(lastPlannerBody().messages[1].content).not.toContain('[-51]');

        await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_chat_depth: -5 }) }));
        expect(lastPlannerBody().messages[1].content).toContain('[-1]');
        expect(lastPlannerBody().messages[1].content).not.toContain('[-2]');
    });

    it('shows at most 12 pre-search candidates by default, clamped to 1..20', async () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ event_id: `e${i}`, text: `hit ${i}` }));
        retrieveEvents.mockResolvedValue(preSearchResult(many));
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));

        await retrieveEventsWithAgent(params());
        expect(lastPlannerBody().messages[1].content).toContain('E12 ');
        expect(lastPlannerBody().messages[1].content).not.toContain('E13 ');

        await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_candidates_to_show: 999 }) }));
        expect(lastPlannerBody().messages[1].content).toContain('E20 ');
        expect(lastPlannerBody().messages[1].content).not.toContain('E21 ');
    });

    it('strips markdown fences from the planner reply before parsing', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['fenced query'] }));
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: '```json\n{"queries":["fenced query"]}\n```' } }] }),
        });
        const out = await retrieveEventsWithAgent(params());
        expect(out.debug.agenticQueries).toEqual(['fenced query']);
    });

    it('never puts the API key on the wire', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['q one'] }));
        await retrieveEventsWithAgent(params());
        expect(globalThis.fetch.mock.calls[0][1].body).not.toContain('or-masked');
    });
});

// ---------------------------------------------------------------------------
// Planner failures — all fall back to pre-search
// ---------------------------------------------------------------------------

describe('planner failure fallbacks', () => {
    let pre;
    beforeEach(() => {
        pre = preSearchResult();
        retrieveEvents.mockResolvedValue(pre);
    });

    const expectFallback = async (mockFetch) => {
        globalThis.fetch.mockImplementation(mockFetch);
        const out = await retrieveEventsWithAgent(params());
        expect(out).toBe(pre);
        expect(queryCollection).not.toHaveBeenCalled();
    };

    it('falls back on an HTTP error', async () => {
        await expectFallback(async () => ({ ok: false, status: 500, statusText: 'x', text: async () => 'boom' }));
    });

    it('falls back on a model-config error (and notifies the user)', async () => {
        const { notifyInvalidModel } = await import('../core/model-config-notifier.js');
        await expectFallback(async () => ({ ok: false, status: 404, statusText: 'x', text: async () => 'model not found' }));
        expect(notifyInvalidModel).toHaveBeenCalledOnce();
    });

    it('falls back on an empty content field', async () => {
        await expectFallback(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) }));
    });

    it('falls back when the reply is not valid JSON', async () => {
        await expectFallback(async () => ({
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: 'sure, here you go!' } }] }),
        }));
    });

    it('falls back on a network rejection', async () => {
        await expectFallback(async () => { throw new TypeError('Failed to fetch'); });
    });

    it('falls back on a timeout/abort', async () => {
        await expectFallback(async () => {
            const e = new Error('The operation was aborted');
            e.name = 'TimeoutError';
            throw e;
        });
    });

    it('falls back when the planner emits zero usable queries', async () => {
        for (const plan of [
            { queries: [] },
            { queries: 'not an array' },
            { queries: ['ab'] },                                  // under 3 chars
            { queries: ['x'.repeat(301)] },                       // over 300 chars
            { queries: [123, null, {}] },                         // non-strings
            { rationale: 'no queries key at all' },
        ]) {
            globalThis.fetch.mockResolvedValue(plannerReply(plan));
            queryCollection.mockClear();
            expect(await retrieveEventsWithAgent(params())).toBe(pre);
            expect(queryCollection).not.toHaveBeenCalled();
        }
    });
});

// ---------------------------------------------------------------------------
// Query validation and fan-out
// ---------------------------------------------------------------------------

describe('query validation and fan-out', () => {
    beforeEach(() => {
        retrieveEvents.mockResolvedValue(preSearchResult());
    });

    it('trims queries, drops duplicates case-insensitively, and caps at 4 by default', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({
            queries: ['  docks incident  ', 'DOCKS INCIDENT', 'second query', 'third query', 'fourth query', 'fifth query'],
        }));
        const out = await retrieveEventsWithAgent(params());
        expect(out.debug.agenticQueries).toEqual(['docks incident', 'second query', 'third query', 'fourth query']);
    });

    it('honours agentic_retrieval_max_queries, clamped to 1..4', async () => {
        const plan = { queries: ['query one', 'query two', 'query three', 'query four'] };
        globalThis.fetch.mockResolvedValue(plannerReply(plan));

        let out = await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_max_queries: 2 }) }));
        expect(out.debug.agenticQueries).toHaveLength(2);

        out = await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_max_queries: 99 }) }));
        expect(out.debug.agenticQueries).toHaveLength(4);

        out = await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_retrieval_max_queries: -1 }) }));
        expect(out.debug.agenticQueries).toHaveLength(1);
    });

    it('accepts a 3-char query and rejects a 2-char one at the boundary', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['abc', 'ab'] }));
        expect((await retrieveEventsWithAgent(params())).debug.agenticQueries).toEqual(['abc']);
    });

    it('fans out queries x collections and passes topK = 2x the retrieval top_k', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one', 'query two'] }));
        await retrieveEventsWithAgent(params({
            liveCollectionIds: ['col-a', 'col-b'],
            settings: agenticSettings({ eventbase_retrieval_top_k: 5 }),
        }));

        expect(queryCollection).toHaveBeenCalledTimes(4);
        const [colId, queryText, topK] = queryCollection.mock.calls[0];
        expect(colId).toBe('col-a');
        expect(queryText).toBe('query one');
        expect(topK).toBe(10);
    });

    it('defaults topK to 16 (8 x 2)', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        await retrieveEventsWithAgent(params());
        expect(queryCollection.mock.calls[0][2]).toBe(16);
    });

    it('forces the keyword scoring method to bm25 for the fan-out', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        await retrieveEventsWithAgent(params({
            settings: agenticSettings({ keyword_scoring_method: 'tfidf' }),
        }));
        expect(queryCollection.mock.calls[0][3].keyword_scoring_method).toBe('bm25');
    });

    it('honours eventbase_keyword_scoring_method when set', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        await retrieveEventsWithAgent(params({
            settings: agenticSettings({ eventbase_keyword_scoring_method: 'tfidf' }),
        }));
        expect(queryCollection.mock.calls[0][3].keyword_scoring_method).toBe('tfidf');
    });

    it('threads validated planner filters into every fan-out call', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({
            queries: ['query one'],
            filters: { characters_any: ['Aria', 'Aria'], importance_gte: 20, bogus: ['x'] },
        }));
        await retrieveEventsWithAgent(params());
        expect(queryCollection.mock.calls[0][4]).toEqual({ characters_any: ['Aria'], importance_gte: 10 });
    });

    it('passes {} when the planner emits no filters or they are disabled', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        await retrieveEventsWithAgent(params());
        expect(queryCollection.mock.calls[0][4]).toEqual({});

        queryCollection.mockClear();
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'], filters: { characters_any: ['Aria'] } }));
        await retrieveEventsWithAgent(params({ settings: agenticSettings({ agentic_filters_enabled: false }) }));
        expect(queryCollection.mock.calls[0][4]).toEqual({});
    });

    it('survives a per-query failure — that query yields no hits and the rest proceed', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one', 'query two'] }));
        queryCollection
            .mockRejectedValueOnce(new Error('qdrant unreachable'))
            .mockResolvedValueOnce({ hashes: ['h1'], metadata: [{ event_id: 'a1', text: 'agentic hit' }] });

        const out = await retrieveEventsWithAgent(params());
        expect(out.debug.agenticMode).toBe(true);
        expect(out.debug.agenticHitCount).toBe(1);
    });

    it('treats an empty hashes array as zero hits', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        queryCollection.mockResolvedValue({ hashes: [], metadata: [{ event_id: 'ghost' }] });
        const out = await retrieveEventsWithAgent(params());
        expect(out.debug.agenticHitCount).toBe(0);
    });

    it('attaches the returned hash to each hit as _hash', async () => {
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        queryCollection.mockResolvedValue({ hashes: ['h1', 'h2'], metadata: [{ event_id: 'a1' }, { event_id: 'a2' }] });
        await retrieveEventsWithAgent(params());

        const merged = retrieveEvents.mock.calls[1][0].additionalCandidates;
        expect(merged).toContainEqual({ event_id: 'a1', _hash: 'h1' });
        expect(merged).toContainEqual({ event_id: 'a2', _hash: 'h2' });
    });
});

// ---------------------------------------------------------------------------
// Merge and re-rank
// ---------------------------------------------------------------------------

describe('merge back through retrieveEvents', () => {
    it('re-runs retrieveEvents with skipLiveQuery and the merged candidate pool', async () => {
        const pre = preSearchResult([{ event_id: 'p1', text: 'pre hit' }]);
        const final = { events: [{ event_id: 'p1' }, { event_id: 'a1' }], debug: { reranked: true } };
        retrieveEvents.mockResolvedValueOnce(pre).mockResolvedValueOnce(final);
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        queryCollection.mockResolvedValue({ hashes: ['h1'], metadata: [{ event_id: 'a1' }] });

        const archive = [{ event_id: 'arch1' }];
        const out = await retrieveEventsWithAgent(params({ additionalCandidates: archive }));

        expect(retrieveEvents).toHaveBeenCalledTimes(2);
        const second = retrieveEvents.mock.calls[1][0];
        expect(second.skipLiveQuery).toBe(true);
        expect(second.liveCollectionIds).toEqual([]);
        // Order: archive candidates, then pre-search events, then agentic hits.
        expect(second.additionalCandidates).toEqual([
            { event_id: 'arch1' },
            { event_id: 'p1', text: 'pre hit' },
            { event_id: 'a1', _hash: 'h1' },
        ]);
        expect(out.events).toBe(final.events);
    });

    it('preserves the final debug object and layers agentic annotations on top', async () => {
        retrieveEvents
            .mockResolvedValueOnce(preSearchResult())
            .mockResolvedValueOnce({ events: [], debug: { reranked: true, weights: [1, 2] } });
        globalThis.fetch.mockResolvedValue(plannerReply({
            queries: ['query one', 'query two'],
            rationale: 'Splitting by time and perspective.',
        }));

        const out = await retrieveEventsWithAgent(params());
        expect(out.debug).toMatchObject({
            reranked: true,
            weights: [1, 2],
            agenticMode: true,
            agenticQueries: ['query one', 'query two'],
            agenticRationale: 'Splitting by time and perspective.',
            agenticHitCount: 0,
        });
        expect(typeof out.debug.agenticLLMMs).toBe('number');
        expect(typeof out.debug.agenticFanoutMs).toBe('number');
        expect(typeof out.debug.agenticTotalMs).toBe('number');
    });

    it('nulls agenticRationale when the planner omits it or returns a non-string', async () => {
        retrieveEvents
            .mockResolvedValueOnce(preSearchResult())
            .mockResolvedValue({ events: [], debug: {} });
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'], rationale: { not: 'a string' } }));
        expect((await retrieveEventsWithAgent(params())).debug.agenticRationale).toBeNull();
    });

    it('tolerates a final result with no debug object', async () => {
        retrieveEvents
            .mockResolvedValueOnce(preSearchResult())
            .mockResolvedValueOnce({ events: [] });
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        expect((await retrieveEventsWithAgent(params())).debug.agenticMode).toBe(true);
    });

    it('does NOT dedupe before merging — a pre-search event and its agentic re-hit both go in', async () => {
        // Dedup is delegated entirely to retrieveEvents' re-ranker.
        retrieveEvents
            .mockResolvedValueOnce(preSearchResult([{ event_id: 'dup', text: 'same event' }]))
            .mockResolvedValueOnce({ events: [], debug: {} });
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        queryCollection.mockResolvedValue({ hashes: ['h1'], metadata: [{ event_id: 'dup' }] });

        await retrieveEventsWithAgent(params());
        const merged = retrieveEvents.mock.calls[1][0].additionalCandidates;
        expect(merged.filter(c => c.event_id === 'dup')).toHaveLength(2);
    });

    it('lets a failure in the second retrieveEvents call propagate — no fallback at this stage', async () => {
        retrieveEvents
            .mockResolvedValueOnce(preSearchResult())
            .mockRejectedValueOnce(new Error('rerank blew up'));
        globalThis.fetch.mockResolvedValue(plannerReply({ queries: ['query one'] }));
        await expect(retrieveEventsWithAgent(params())).rejects.toThrow('rerank blew up');
    });

    it('lets a pre-search failure propagate before any agentic work happens', async () => {
        retrieveEvents.mockRejectedValue(new Error('pre-search failed'));
        await expect(retrieveEventsWithAgent(params())).rejects.toThrow('pre-search failed');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

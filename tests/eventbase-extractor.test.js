/**
 * Characterization tests for core/eventbase-extractor.js
 *
 * extractEvents() is the LLM ingestion path: build an excerpt, prompt a model,
 * then survive whatever JSON-shaped thing comes back. The interesting surface
 * is the multi-strategy parser (direct / NDJSON / balanced-bracket scan /
 * object-stream), the importance-based cap, the fatal-vs-skippable error split,
 * and the ingestion metadata stamped onto each record.
 *
 * Mocks ST globals + fetch; eventbase-schema and text-cleaning run for real so
 * validation behavior is captured end to end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: () => ({ chat: [] }),
}));

// text-cleaning.js pulls in ST's utils for uuidv4.
vi.mock('../../../../utils.js', () => ({
    uuidv4: () => 'test-uuid',
}));

const { keys } = vi.hoisted(() => ({ keys: { openrouter: 'or-masked', custom: 'custom-masked' } }));
vi.mock('../core/api-keys.js', () => ({
    getOpenRouterApiKey: () => keys.openrouter,
    getCustomApiKey: () => keys.custom,
}));

import { extractEvents } from '../core/eventbase-extractor.js';
import { EVENTBASE_SCHEMA_VERSION } from '../core/eventbase-schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validEvent(overrides = {}) {
    return {
        event_type: 'relationship_change',
        importance: 7,
        summary: 'Aria takes the blame for Leon in front of the commander.',
        cause: 'Leon froze during the briefing.',
        result: 'Leon feels indebted to Aria.',
        characters: ['Aria', 'Leon'],
        locations: ['Command Tent'],
        factions: ['Iron Company'],
        items: [],
        concepts: ['sacrifice', 'debt'],
        keywords: ['blame', 'shield', 'punishment'],
        open_threads: ['Will Leon repay Aria?'],
        should_persist: true,
        ...overrides,
    };
}

const messages = [
    { name: 'Aria', mes: 'I gave the order. It was my call.' },
    { name: 'Leon', mes: 'You did not have to do that.' },
];

function settings(overrides = {}) {
    return {
        summarize_provider: 'openrouter',
        summarize_model: 'anthropic/claude-3-haiku',
        cjk_tokenizer_mode: 'intl',
        ...overrides,
    };
}

const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const httpError = (status, text) => ({ ok: false, status, statusText: `S${status}`, text: async () => text });

const run = (overrides = {}) => extractEvents({
    messages,
    windowStart: 10,
    windowEnd: 11,
    windowIndex: 3,
    settings: settings(),
    ...overrides,
});

const lastPrompt = () => JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body).messages[0].content;
const lastBody = () => JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body);

beforeEach(() => {
    keys.openrouter = 'or-masked';
    keys.custom = 'custom-masked';
    globalThis.fetch = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Excerpt construction and prompting
// ---------------------------------------------------------------------------

describe('excerpt and prompt construction', () => {
    beforeEach(() => globalThis.fetch.mockResolvedValue(reply('[]')));

    it('returns [] for an empty message array without calling the LLM', async () => {
        expect(await run({ messages: [] })).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('skips named blank messages without calling the LLM', async () => {
        await run({ messages: [{ name: 'A', mes: '' }, { name: 'B', mes: '   ' }] });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('skips messages without text or a label', async () => {
        await run({ messages: [{}] });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('counts kana once when deciding whether to add a language hint', async () => {
        await run({ messages: [{ name: 'A', mes: 'あabcdefghij' }] });
        expect(lastPrompt()).not.toContain('DETECTED EXCERPT LANGUAGE');
    });

    it('keeps nonempty content when other messages in the window are blank', async () => {
        await run({ messages: [{ name: 'A', mes: '' }, { name: 'B', mes: 'We agreed to leave.' }] });
        expect(globalThis.fetch).toHaveBeenCalledOnce();
        expect(lastPrompt()).toContain('B: We agreed to leave.');
    });

    it('formats the excerpt as "Speaker: text" blocks separated by blank lines', async () => {
        await run();
        expect(lastPrompt()).toContain('Aria: I gave the order. It was my call.\n\nLeon: You did not have to do that.');
    });

    it('falls back to User/Assistant labels when a message has no name', async () => {
        await run({ messages: [{ is_user: true, mes: 'hi' }, { mes: 'hello' }] });
        const p = lastPrompt();
        expect(p).toContain('User: hi');
        expect(p).toContain('Assistant: hello');
    });

    it('runs message text through cleanText before prompting', async () => {
        await run({ messages: [{ name: 'A', mes: '<i>*emphasis*</i> stays readable' }] });
        expect(lastPrompt()).not.toContain('<i>');
    });

    it('substitutes the maxCount cap into the prompt, defaulting to 5', async () => {
        await run();
        expect(lastPrompt()).toContain('Return AT MOST 5 events.');
        await run({ settings: settings({ eventbase_max_events_per_window: 2 }) });
        expect(lastPrompt()).toContain('Return AT MOST 2 events.');
    });

    it('leaves no unsubstituted placeholders in the final prompt', async () => {
        await run();
        expect(lastPrompt()).not.toContain('{{text}}');
        expect(lastPrompt()).not.toContain('{{maxCount}}');
    });

    it('prepends a detected-language banner for CJK excerpts only', async () => {
        await run();
        expect(lastPrompt()).not.toContain('DETECTED EXCERPT LANGUAGE');

        await run({ messages: [{ name: '师父', mes: '我承诺帮你寻找失踪的父亲，无论要花多少时间。' }] });
        expect(lastPrompt().startsWith('DETECTED EXCERPT LANGUAGE: 中文 (Chinese).')).toBe(true);
    });

    it('distinguishes Korean and Japanese in the language banner', async () => {
        await run({ messages: [{ name: '스승', mes: '메이라의 실종된 아버지를 찾아주기로 약속했다.' }] });
        expect(lastPrompt()).toContain('한국어 (Korean)');

        await run({ messages: [{ name: '師匠', mes: 'メイラのゆくえふめいのちちをさがすとやくそくした。' }] });
        expect(lastPrompt()).toContain('日本語 (Japanese)');
    });

    it('picks the prompt variant from cjk_tokenizer_mode', async () => {
        await run({ settings: settings({ cjk_tokenizer_mode: 'korean' }) });
        expect(lastPrompt()).toContain('MUST be in Korean');
    });

    it('sends temperature 0.2 and 4096 max tokens by default, overridable via settings', async () => {
        await run();
        expect(lastBody()).toMatchObject({ temperature: 0.2, max_tokens: 4096 });

        await run({ settings: settings({ eventbase_temperature: 0, eventbase_max_tokens: 8192 }) });
        expect(lastBody()).toMatchObject({ temperature: 0, max_tokens: 8192 });
    });

    it('does NOT force response_format — the prompt requires a top-level array', async () => {
        await run();
        expect(lastBody().response_format).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Parser: the many shapes an LLM reply can take
// ---------------------------------------------------------------------------

describe('reply parsing', () => {
    const extractOne = async (content) => {
        globalThis.fetch.mockResolvedValue(reply(content));
        return run();
    };

    it('parses a clean JSON array', async () => {
        const out = await extractOne(JSON.stringify([validEvent()]));
        expect(out).toHaveLength(1);
        expect(out[0].event_type).toBe('relationship_change');
    });

    it('accepts an empty array as a valid "no events" answer', async () => {
        expect(await extractOne('[]')).toEqual([]);
    });

    it('accepts a bare {} as "no events" rather than failing the window', async () => {
        expect(await extractOne('{}')).toEqual([]);
    });

    it('strips markdown code fences', async () => {
        expect(await extractOne('```json\n' + JSON.stringify([validEvent()]) + '\n```')).toHaveLength(1);
        expect(await extractOne('```\n[]\n```')).toEqual([]);
    });

    it('unwraps an array nested under an arbitrary object key', async () => {
        const out = await extractOne(JSON.stringify({ events: [validEvent()] }));
        expect(out).toHaveLength(1);
    });

    it('parses NDJSON — one event object per line', async () => {
        const out = await extractOne([
            JSON.stringify(validEvent()),
            JSON.stringify(validEvent({ event_type: 'combat', summary: 'A skirmish at the ford breaks out.' })),
        ].join('\n'));
        expect(out).toHaveLength(2);
        expect(out.map(e => e.event_type)).toEqual(['relationship_change', 'combat']);
    });

    it('finds an array embedded in surrounding prose', async () => {
        const out = await extractOne(`Here are the events I found:\n${JSON.stringify([validEvent()])}\nHope that helps!`);
        expect(out).toHaveLength(1);
    });

    it('prefers a real event array over inner property arrays like "items": []', async () => {
        const out = await extractOne(JSON.stringify([validEvent({ items: [], concepts: ['a', 'b'] })]));
        expect(out).toHaveLength(1);
        expect(out[0].concepts).toEqual(['a', 'b']);
    });

    it('recovers a concatenated object stream with no array brackets', async () => {
        const out = await extractOne(
            `${JSON.stringify(validEvent())}${JSON.stringify(validEvent({ event_type: 'combat', summary: 'A skirmish erupts at the ford.' }))}`,
        );
        expect(out).toHaveLength(2);
    });

    it('identifies an event array by event_type, summary OR importance', async () => {
        for (const probe of [{ event_type: 'combat' }, { summary: 's' }, { importance: 5 }]) {
            globalThis.fetch.mockResolvedValue(reply(JSON.stringify([{ ...validEvent(), ...probe }])));
            await expect(run()).resolves.toBeInstanceOf(Array);
        }
    });

    it('throws an extraction error when the reply is empty after fence-stripping', async () => {
        globalThis.fetch.mockResolvedValue(reply('```json\n```'));
        await expect(run()).rejects.toThrow(/JSON parse failed for window 3/);
    });

    it('throws an extraction error when nothing array-shaped can be found', async () => {
        globalThis.fetch.mockResolvedValue(reply('I could not find any events in this excerpt.'));
        const err = await run().catch(e => e);
        expect(err.name).toBe('EventBaseExtractionError');
        expect(err.message).toContain('msgs=10-11');
    });

    it('throws when the chosen array holds non-objects', async () => {
        globalThis.fetch.mockResolvedValue(reply('["just", "strings"]'));
        await expect(run()).rejects.toThrow(/JSON parse failed/);
    });

    it('tags parse failures with the window index and message range', async () => {
        globalThis.fetch.mockResolvedValue(reply('nonsense'));
        const err = await run({ windowIndex: 7, windowStart: 40, windowEnd: 45 }).catch(e => e);
        expect(err.message).toContain('window 7');
        expect(err.message).toContain('msgs=40-45');
    });
});

// ---------------------------------------------------------------------------
// Cap enforcement and validation
// ---------------------------------------------------------------------------

describe('cap enforcement', () => {
    it('keeps the highest-importance events when the LLM exceeds the cap', async () => {
        const many = [3, 9, 1, 7, 5].map(importance =>
            validEvent({ importance, summary: `Event with importance ${importance} occurs.` }));
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify(many)));

        const out = await run({ settings: settings({ eventbase_max_events_per_window: 2 }) });
        expect(out.map(e => e.importance)).toEqual([9, 7]);
    });

    it('leaves the order untouched when the reply is within the cap', async () => {
        const inOrder = [3, 9, 1].map(importance =>
            validEvent({ importance, summary: `Event number ${importance} happens here.` }));
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify(inOrder)));
        const out = await run({ settings: settings({ eventbase_max_events_per_window: 5 }) });
        expect(out.map(e => e.importance)).toEqual([3, 9, 1]);
    });

    it('treats a non-numeric importance as 0 when sorting for the cap', async () => {
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify([
            validEvent({ importance: 'high', summary: 'The string-importance event occurs first.' }),
            validEvent({ importance: 4, summary: 'The numeric-importance event occurs second.' }),
        ])));
        const out = await run({ settings: settings({ eventbase_max_events_per_window: 1 }) });
        expect(out[0].importance).toBe(4);
    });
});

describe('per-event validation', () => {
    it('drops invalid events and keeps the valid ones from the same window', async () => {
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify([
            validEvent(),
            { event_type: 'combat' }, // no summary
        ])));
        const out = await run();
        expect(out).toHaveLength(1);
        expect(out[0].event_type).toBe('relationship_change');
    });

    it('returns [] rather than throwing when every event fails validation', async () => {
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify([{ event_type: 'combat' }, { importance: 5 }])));
        expect(await run()).toEqual([]);
    });

    it('keeps an event whose summary language does not match the excerpt (warn only)', async () => {
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify([
            validEvent({ summary: '师傅承诺帮梅拉寻找失踪的父亲，这成为队伍的核心目标。' }),
        ])));
        // Latin excerpt, CJK summary — still returned.
        expect(await run()).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Ingestion metadata
// ---------------------------------------------------------------------------

describe('ingestion metadata', () => {
    beforeEach(() => globalThis.fetch.mockResolvedValue(reply(JSON.stringify([validEvent()]))));

    it('stamps window provenance and the schema version onto each record', async () => {
        const [event] = await run();
        expect(event).toMatchObject({
            source_window_start: 10,
            source_window_end: 11,
            source_message_ids: [10, 11],
            schema_version: EVENTBASE_SCHEMA_VERSION,
        });
        expect(event.created_at).toBeGreaterThan(0);
    });

    it('generates an eb_-prefixed event_id embedding the window start and item index', async () => {
        const [event] = await run();
        expect(event.event_id).toMatch(/^eb_\d+_10_0_[a-z0-9]{1,5}$/);
    });

    it('generates distinct event_ids for events in the same window', async () => {
        globalThis.fetch.mockResolvedValue(reply(JSON.stringify([
            validEvent(),
            validEvent({ event_type: 'combat', summary: 'A second and distinct event occurs.' }),
        ])));
        const out = await run();
        expect(out[0].event_id).not.toBe(out[1].event_id);
    });

    it('derives source_message_ids from position, NOT from any id on the message', async () => {
        // A window that does not start at the message it claims still gets
        // sequential ids counted off windowStart.
        const [event] = await run({ windowStart: 100, windowEnd: 101 });
        expect(event.source_message_ids).toEqual([100, 101]);
    });

    it('prefers a stored message hash and falls back to a computed one', async () => {
        const [event] = await run({
            messages: [{ name: 'A', mes: 'text one', hash: 12345 }, { name: 'B', mes: 'text two' }],
        });
        expect(event.source_message_hashes[0]).toBe(12345);
        expect(typeof event.source_message_hashes[1]).toBe('number');
    });

    it('computes the fallback hash deterministically from name + text', async () => {
        const first = (await run({ messages: [{ name: 'A', mes: 'stable text' }] }))[0];
        const second = (await run({ messages: [{ name: 'A', mes: 'stable text' }] }))[0];
        expect(first.source_message_hashes).toEqual(second.source_message_hashes);

        const different = (await run({ messages: [{ name: 'B', mes: 'stable text' }] }))[0];
        expect(different.source_message_hashes).not.toEqual(first.source_message_hashes);
    });

    it('hashes the RAW message text, not the cleaned excerpt text', async () => {
        const withMarkup = (await run({ messages: [{ name: 'A', mes: '<i>x</i>' }] }))[0];
        const plain = (await run({ messages: [{ name: 'A', mes: 'x' }] }))[0];
        expect(withMarkup.source_message_hashes).not.toEqual(plain.source_message_hashes);
    });
});

// ---------------------------------------------------------------------------
// Provider dispatch and error taxonomy
// ---------------------------------------------------------------------------

describe('provider dispatch', () => {
    it('defaults to OpenRouter and routes through ST\'s chat-completions proxy', async () => {
        globalThis.fetch.mockResolvedValue(reply('[]'));
        await run({ settings: { summarize_model: 'm' } });
        expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/backends/chat-completions/generate');
        expect(lastBody().chat_completion_source).toBe('openrouter');
    });

    it('routes vllm through the same proxy as chat_completion_source "custom"', async () => {
        globalThis.fetch.mockResolvedValue(reply('[]'));
        await run({ settings: settings({ summarize_provider: 'vllm', summarize_vllm_url: 'http://localhost:8000' }) });
        expect(lastBody()).toMatchObject({ chat_completion_source: 'custom', custom_url: 'http://localhost:8000' });
    });

    it('is case-insensitive about the provider name', async () => {
        globalThis.fetch.mockResolvedValue(reply('[]'));
        await run({ settings: settings({ summarize_provider: 'VLLM', summarize_vllm_url: 'http://h' }) });
        expect(lastBody().chat_completion_source).toBe('custom');
    });

    it('falls back to OpenRouter for any unrecognised provider instead of erroring', async () => {
        // Unlike summarizer.js, which throws unknown_provider.
        globalThis.fetch.mockResolvedValue(reply('[]'));
        await run({ settings: settings({ summarize_provider: 'ollama' }) });
        expect(lastBody().chat_completion_source).toBe('openrouter');
    });

    it('never puts the API key on the wire', async () => {
        globalThis.fetch.mockResolvedValue(reply('[]'));
        await run();
        expect(globalThis.fetch.mock.calls[0][1].body).not.toContain('or-masked');
    });
});

describe('fatal vs skippable errors', () => {
    const fatal = (p) => p.catch(e => e).then(e => ({ name: e.name, code: e.code, message: e.message }));

    it('treats a missing OpenRouter key as fatal, before any request', async () => {
        keys.openrouter = '';
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseFatalError', code: 'missing_api_key' });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('treats a missing model as fatal', async () => {
        expect(await fatal(run({ settings: settings({ summarize_model: '  ' }) })))
            .toMatchObject({ name: 'EventBaseFatalError', code: 'missing_model' });
    });

    it('treats a missing vLLM URL as fatal, checked before the model', async () => {
        expect(await fatal(run({ settings: settings({ summarize_provider: 'vllm', summarize_model: '' }) })))
            .toMatchObject({ code: 'missing_url' });
    });

    it('treats a missing vLLM key as fatal', async () => {
        keys.custom = '';
        expect(await fatal(run({ settings: settings({ summarize_provider: 'vllm', summarize_vllm_url: 'http://h' }) })))
            .toMatchObject({ code: 'missing_api_key' });
    });

    it.each([401, 403])('treats HTTP %i as fatal invalid_api_key', async (status) => {
        globalThis.fetch.mockResolvedValue(httpError(status, 'denied'));
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseFatalError', code: 'invalid_api_key' });
    });

    it('treats a 404 model error as fatal invalid_model_config', async () => {
        globalThis.fetch.mockResolvedValue(httpError(404, '{"message":"Not Found"}'));
        expect(await fatal(run())).toMatchObject({ code: 'invalid_model_config' });
    });

    it('treats other HTTP failures as SKIPPABLE extraction errors, not fatal', async () => {
        globalThis.fetch.mockResolvedValue(httpError(500, 'upstream exploded'));
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseExtractionError' });
    });

    it('treats a 400 context-length error as skippable rather than fatal', async () => {
        globalThis.fetch.mockResolvedValue(httpError(400, "this model's maximum context length is 8192 tokens"));
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseExtractionError' });
    });

    it('treats an empty reply as a skippable per-window error', async () => {
        globalThis.fetch.mockResolvedValue(reply(''));
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseExtractionError' });
    });

    it('promotes an HTTP 200 body carrying a model error to FATAL', async () => {
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ error: { message: 'model is deprecated' } }),
        });
        expect(await fatal(run())).toMatchObject({ name: 'EventBaseFatalError', code: 'invalid_model_config' });
    });

    it('applies the same taxonomy on the vLLM path', async () => {
        const vllm = settings({ summarize_provider: 'vllm', summarize_vllm_url: 'http://h' });
        globalThis.fetch.mockResolvedValue(httpError(401, 'nope'));
        expect(await fatal(run({ settings: vllm }))).toMatchObject({ code: 'invalid_api_key' });

        globalThis.fetch.mockResolvedValue(httpError(503, 'busy'));
        expect(await fatal(run({ settings: vllm }))).toMatchObject({ name: 'EventBaseExtractionError' });
    });

    it('lets a network-level rejection propagate untouched', async () => {
        globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(run()).rejects.toThrow('Failed to fetch');
    });
});

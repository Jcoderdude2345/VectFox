/**
 * Characterization tests for core/summarizer.js
 *
 * Covers config validation, the fingerprint used to detect settings changes,
 * the vLLM URL normalizer, and the full error taxonomy of both provider calls
 * (fatal vs. transient). Mocks ST globals + fetch — same convention as
 * reformat-extractor.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

// api-keys reads ST secret state; stub it so the summarizer's presence checks
// are driven by the test rather than by ST internals.
const keys = { openrouter: 'sk-or-masked-1234', custom: 'custom-masked-9876' };
vi.mock('../core/api-keys.js', () => ({
    getOpenRouterApiKey: () => keys.openrouter,
    getCustomApiKey: () => keys.custom,
}));

import {
    summarizeText,
    validateLLMConfig,
    getSummarizationConfigFingerprint,
    buildVllmChatCompletionsUrl,
    SummarizationFatalError,
    isSummarizationFatalError,
    DEFAULT_SUMMARIZE_PROMPT,
} from '../core/summarizer.js';
import { getDefaultSummarizePrompt } from '../core/prompts-i18n.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function orSettings(overrides = {}) {
    return { summarize_provider: 'openrouter', summarize_model: 'anthropic/claude-3-haiku', ...overrides };
}
function vllmSettings(overrides = {}) {
    return {
        summarize_provider: 'vllm',
        summarize_model: 'local/qwen',
        summarize_vllm_url: 'http://localhost:8000',
        ...overrides,
    };
}

const okReply = (content) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
});
const httpError = (status, text) => ({
    ok: false,
    status,
    statusText: `Status ${status}`,
    text: async () => text,
});

const lastBody = () => JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body);

beforeEach(() => {
    keys.openrouter = 'sk-or-masked-1234';
    keys.custom = 'custom-masked-9876';
    globalThis.fetch = vi.fn();
});
afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// validateLLMConfig
// ---------------------------------------------------------------------------

describe('validateLLMConfig', () => {
    it('accepts a complete OpenRouter config', () => {
        expect(validateLLMConfig(orSettings())).toEqual({ ok: true });
    });

    it('accepts a complete vLLM config', () => {
        expect(validateLLMConfig(vllmSettings())).toEqual({ ok: true });
    });

    it('rejects a missing or whitespace-only model before checking credentials', () => {
        expect(validateLLMConfig(orSettings({ summarize_model: '' })))
            .toEqual({ ok: false, reason: 'Summarization / EventBase extraction model is not set.' });
        expect(validateLLMConfig(orSettings({ summarize_model: '   ' })).ok).toBe(false);
        expect(validateLLMConfig({}).reason).toContain('model is not set');
    });

    it('rejects OpenRouter with no API key', () => {
        keys.openrouter = '';
        expect(validateLLMConfig(orSettings()))
            .toEqual({ ok: false, reason: 'OpenRouter API key is not set.' });
    });

    it('rejects vLLM with no base URL', () => {
        expect(validateLLMConfig(vllmSettings({ summarize_vllm_url: '  ' })))
            .toEqual({ ok: false, reason: 'vLLM Base URL is not set.' });
    });

    it('does NOT check the vLLM API key, unlike the actual call path', () => {
        // Asymmetry: _callVLLM throws missing_api_key, but validateLLMConfig
        // reports ok:true for the same settings.
        keys.custom = '';
        expect(validateLLMConfig(vllmSettings())).toEqual({ ok: true });
    });

    it('rejects unknown providers by name', () => {
        expect(validateLLMConfig(orSettings({ summarize_provider: 'ollama' })))
            .toEqual({ ok: false, reason: 'Unknown LLM provider: ollama' });
    });

    it('lowercases the provider, so "OpenRouter" is accepted', () => {
        expect(validateLLMConfig(orSettings({ summarize_provider: 'OpenRouter' }))).toEqual({ ok: true });
    });

    it('defaults to openrouter when no provider is set', () => {
        keys.openrouter = '';
        expect(validateLLMConfig({ summarize_model: 'm' }).reason).toBe('OpenRouter API key is not set.');
    });

    it('tolerates being called with no argument at all', () => {
        expect(validateLLMConfig().ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getSummarizationConfigFingerprint
// ---------------------------------------------------------------------------

describe('getSummarizationConfigFingerprint', () => {
    it('encodes only key length + boundary chars, never the key itself', () => {
        keys.openrouter = 'sk-or-v1-SECRETMATERIAL';
        const fp = getSummarizationConfigFingerprint(orSettings());
        expect(fp).toBe('openrouter|23:sk:AL');
        expect(fp).not.toContain('SECRETMATERIAL');
    });

    it('reports "missing" when there is no key', () => {
        keys.openrouter = '';
        expect(getSummarizationConfigFingerprint(orSettings())).toBe('openrouter|missing');
    });

    it('includes the trimmed vLLM URL alongside the key signature', () => {
        keys.custom = 'abcd1234';
        expect(getSummarizationConfigFingerprint(vllmSettings({ summarize_vllm_url: '  http://h:8000  ' })))
            .toBe('vllm|http://h:8000|8:ab:34');
    });

    it('changes when the key rotates but the model does not', () => {
        const a = getSummarizationConfigFingerprint(orSettings());
        keys.openrouter = 'sk-or-DIFFERENT-KEY!!';
        expect(getSummarizationConfigFingerprint(orSettings())).not.toBe(a);
    });

    it('does NOT include the model — swapping models leaves the fingerprint unchanged', () => {
        // Callers using this to detect "user fixed their settings" will not see
        // a model change.
        expect(getSummarizationConfigFingerprint(orSettings({ summarize_model: 'a' })))
            .toBe(getSummarizationConfigFingerprint(orSettings({ summarize_model: 'b' })));
    });

    it('is case-SENSITIVE about the provider, unlike validateLLMConfig', () => {
        expect(getSummarizationConfigFingerprint(orSettings({ summarize_provider: 'OpenRouter' })))
            .toBe('other|OpenRouter');
    });

    it('returns an other|<provider> tag for unknown providers', () => {
        expect(getSummarizationConfigFingerprint({ summarize_provider: 'ollama' })).toBe('other|ollama');
    });

    it('defaults to openrouter with no arguments', () => {
        expect(getSummarizationConfigFingerprint()).toMatch(/^openrouter\|/);
    });
});

// ---------------------------------------------------------------------------
// buildVllmChatCompletionsUrl
// ---------------------------------------------------------------------------

describe('buildVllmChatCompletionsUrl', () => {
    it.each([
        ['http://localhost:8000', 'http://localhost:8000/v1/chat/completions'],
        ['http://localhost:8000/', 'http://localhost:8000/v1/chat/completions'],
        ['http://localhost:8000///', 'http://localhost:8000/v1/chat/completions'],
        ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
        ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/chat/completions'],
        ['  http://h:1  ', 'http://h:1/v1/chat/completions'],
    ])('normalizes %s', (input, expected) => {
        expect(buildVllmChatCompletionsUrl(input)).toBe(expected);
    });

    it('strips only ONE trailing /v1 — a doubled suffix survives', () => {
        expect(buildVllmChatCompletionsUrl('http://h/v1/v1')).toBe('http://h/v1/v1/chat/completions');
    });

    it('produces a bare relative path for empty input instead of erroring', () => {
        expect(buildVllmChatCompletionsUrl('')).toBe('/v1/chat/completions');
        expect(buildVllmChatCompletionsUrl(null)).toBe('/v1/chat/completions');
        expect(buildVllmChatCompletionsUrl()).toBe('/v1/chat/completions');
    });

    it('is not actually used by _callVLLM, which posts to ST\'s proxy instead', async () => {
        globalThis.fetch.mockResolvedValue(okReply('s'));
        await summarizeText('text', vllmSettings());
        expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/backends/chat-completions/generate');
        expect(lastBody().custom_url).toBe('http://localhost:8000'); // raw, not normalized
    });
});

// ---------------------------------------------------------------------------
// SummarizationFatalError
// ---------------------------------------------------------------------------

describe('SummarizationFatalError', () => {
    it('carries name, provider and code', () => {
        const e = new SummarizationFatalError('boom', 'openrouter', 'missing_model');
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('SummarizationFatalError');
        expect(e.provider).toBe('openrouter');
        expect(e.code).toBe('missing_model');
    });

    it('is detected by isSummarizationFatalError and plain Errors are not', () => {
        expect(isSummarizationFatalError(new SummarizationFatalError('x', 'p', 'c'))).toBe(true);
        expect(isSummarizationFatalError(new Error('x'))).toBe(false);
        expect(isSummarizationFatalError(null)).toBe(false);
        expect(isSummarizationFatalError({ name: 'SummarizationFatalError' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// summarizeText — input handling and prompt construction
// ---------------------------------------------------------------------------

describe('summarizeText input handling', () => {
    it('returns non-string / empty input unchanged without calling the provider', async () => {
        expect(await summarizeText('', orSettings())).toBe('');
        expect(await summarizeText(null, orSettings())).toBeNull();
        expect(await summarizeText(undefined, orSettings())).toBeUndefined();
        expect(await summarizeText(42, orSettings())).toBe(42);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('throws a fatal missing_model error when no model is configured', async () => {
        await expect(summarizeText('t', orSettings({ summarize_model: '  ' })))
            .rejects.toMatchObject({ name: 'SummarizationFatalError', code: 'missing_model' });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('throws a fatal unknown_provider error for an unsupported provider', async () => {
        await expect(summarizeText('t', orSettings({ summarize_provider: 'ollama' })))
            .rejects.toMatchObject({ code: 'unknown_provider', provider: 'ollama' });
    });

    it('is case-SENSITIVE about the provider on the call path', async () => {
        // validateLLMConfig lowercases; summarizeText does not, so 'OpenRouter'
        // is rejected here even though validation passed it.
        await expect(summarizeText('t', orSettings({ summarize_provider: 'OpenRouter' })))
            .rejects.toMatchObject({ code: 'unknown_provider' });
    });

    it('substitutes the excerpt into the {{text}} slot of the default prompt', async () => {
        globalThis.fetch.mockResolvedValue(okReply('summary'));
        await summarizeText('The bridge collapsed.', orSettings());
        const prompt = lastBody().messages[0].content;
        expect(prompt).toBe(getDefaultSummarizePrompt('intl').replace('{{text}}', 'The bridge collapsed.'));
    });

    it('picks the prompt language from cjk_tokenizer_mode', async () => {
        globalThis.fetch.mockResolvedValue(okReply('summary'));
        await summarizeText('本文', orSettings({ cjk_tokenizer_mode: 'jieba' }));
        expect(lastBody().messages[0].content).toContain('以简体中文撰写');
    });

    it('honours a custom prompt template over the localized default', async () => {
        globalThis.fetch.mockResolvedValue(okReply('summary'));
        await summarizeText('EXCERPT', orSettings({ summarize_prompt: 'Compress this: {{text}} -- done' }));
        expect(lastBody().messages[0].content).toBe('Compress this: EXCERPT -- done');
    });

    it('replaces only the FIRST {{text}} occurrence in a custom prompt', async () => {
        globalThis.fetch.mockResolvedValue(okReply('s'));
        await summarizeText('X', orSettings({ summarize_prompt: '{{text}} and {{text}}' }));
        expect(lastBody().messages[0].content).toBe('X and {{text}}');
    });

    it('sends a custom prompt with no {{text}} slot verbatim — the excerpt is silently dropped', async () => {
        globalThis.fetch.mockResolvedValue(okReply('s'));
        await summarizeText('IMPORTANT TEXT', orSettings({ summarize_prompt: 'no slot here' }));
        expect(lastBody().messages[0].content).toBe('no slot here');
    });

    it('exports DEFAULT_SUMMARIZE_PROMPT as the intl variant', () => {
        expect(DEFAULT_SUMMARIZE_PROMPT).toBe(getDefaultSummarizePrompt('intl'));
    });
});

// ---------------------------------------------------------------------------
// summarizeText — request shape and token budget
// ---------------------------------------------------------------------------

describe('summarizeText request shape', () => {
    beforeEach(() => globalThis.fetch.mockResolvedValue(okReply('the summary')));

    it('posts OpenRouter requests through ST\'s chat-completions proxy at temperature 0.3', async () => {
        await summarizeText('t', orSettings());
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/backends/chat-completions/generate');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toMatchObject({
            chat_completion_source: 'openrouter',
            model: 'anthropic/claude-3-haiku',
            temperature: 0.3,
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('posts vLLM requests as chat_completion_source "custom" with custom_url', async () => {
        await summarizeText('t', vllmSettings());
        expect(lastBody()).toMatchObject({
            chat_completion_source: 'custom',
            custom_url: 'http://localhost:8000',
            model: 'local/qwen',
        });
    });

    it('never puts the API key on the wire — ST reads the real key server-side', async () => {
        await summarizeText('t', orSettings());
        expect(globalThis.fetch.mock.calls[0][1].body).not.toContain('sk-or-masked-1234');
    });

    it('budgets 768 output tokens for Latin text', async () => {
        await summarizeText('Plain English excerpt about a bridge.', orSettings());
        expect(lastBody().max_tokens).toBe(768);
    });

    it('budgets 1536 output tokens once CJK exceeds 10% of the characters', async () => {
        await summarizeText('师傅承诺帮梅拉寻找失踪的父亲。', orSettings());
        expect(lastBody().max_tokens).toBe(1536);
    });

    it('stays on the Latin budget just under the 10% CJK threshold', async () => {
        // 1 CJK char in 20 = 5% → Latin budget.
        await summarizeText(`中${'a'.repeat(19)}`, orSettings());
        expect(lastBody().max_tokens).toBe(768);
        // 3 CJK chars in 20 = 15% → CJK budget.
        await summarizeText(`中文字${'a'.repeat(17)}`, orSettings());
        expect(lastBody().max_tokens).toBe(1536);
    });

    it('counts Korean Hangul toward the CJK budget', async () => {
        await summarizeText('스승은 메이라의 아버지를 찾아주기로 약속했다.', orSettings());
        expect(lastBody().max_tokens).toBe(1536);
    });

    it('counts Japanese kana toward the CJK budget', async () => {
        // The U+3000-U+9FFF range swallows hiragana (U+3040-309F) and katakana
        // (U+30A0-30FF), so kana-only Japanese is detected without needing an
        // explicit kana range — unlike eventbase-extractor._inferLanguageHint,
        // which adds one.
        await summarizeText('ゆきはりょうのせいかつになじんでいる。', orSettings());
        expect(lastBody().max_tokens).toBe(1536);
    });

    it('trims whitespace off the returned summary', async () => {
        globalThis.fetch.mockResolvedValue(okReply('   spaced summary  \n'));
        expect(await summarizeText('t', orSettings())).toBe('spaced summary');
    });
});

// ---------------------------------------------------------------------------
// summarizeText — OpenRouter error paths
// ---------------------------------------------------------------------------

describe('summarizeText OpenRouter error paths', () => {
    it('throws fatal missing_api_key before issuing a request', async () => {
        keys.openrouter = '';
        await expect(summarizeText('t', orSettings()))
            .rejects.toMatchObject({ code: 'missing_api_key', provider: 'openrouter' });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([401, 403])('treats HTTP %i as fatal invalid_api_key', async (status) => {
        globalThis.fetch.mockResolvedValue(httpError(status, 'nope'));
        await expect(summarizeText('t', orSettings()))
            .rejects.toMatchObject({ code: 'invalid_api_key', provider: 'openrouter' });
    });

    it('treats a 404 "not found" body as fatal invalid_model_config', async () => {
        globalThis.fetch.mockResolvedValue(httpError(404, '{"message":"Not Found"}'));
        await expect(summarizeText('t', orSettings()))
            .rejects.toMatchObject({ code: 'invalid_model_config' });
    });

    it('treats a 400 "deprecated" body as fatal invalid_model_config', async () => {
        globalThis.fetch.mockResolvedValue(httpError(400, 'model is deprecated'));
        await expect(summarizeText('t', orSettings()))
            .rejects.toMatchObject({ code: 'invalid_model_config' });
    });

    it('treats a 500 as a plain transient Error, not a fatal one', async () => {
        globalThis.fetch.mockResolvedValue(httpError(500, 'upstream exploded'));
        const err = await summarizeText('t', orSettings()).catch(e => e);
        expect(isSummarizationFatalError(err)).toBe(false);
        expect(err.message).toBe('OpenRouter HTTP 500: upstream exploded');
    });

    it('does NOT promote a 500 "not found" body to fatal — the status gate blocks it', async () => {
        globalThis.fetch.mockResolvedValue(httpError(500, 'model not found'));
        const err = await summarizeText('t', orSettings()).catch(e => e);
        expect(isSummarizationFatalError(err)).toBe(false);
    });

    it('does NOT promote a 400 "context length exceeded" body to fatal', async () => {
        globalThis.fetch.mockResolvedValue(httpError(400, "this model's maximum context length is 8192"));
        const err = await summarizeText('t', orSettings()).catch(e => e);
        expect(isSummarizationFatalError(err)).toBe(false);
        expect(err.message).toContain('OpenRouter HTTP 400');
    });

    it('falls back to statusText when reading the error body throws', async () => {
        globalThis.fetch.mockResolvedValue({
            ok: false, status: 502, statusText: 'Bad Gateway',
            text: async () => { throw new Error('stream closed'); },
        });
        await expect(summarizeText('t', orSettings()))
            .rejects.toThrow('OpenRouter HTTP 502: Bad Gateway');
    });

    it('throws a transient Error on an empty 200 reply', async () => {
        globalThis.fetch.mockResolvedValue(okReply(''));
        const err = await summarizeText('t', orSettings()).catch(e => e);
        expect(isSummarizationFatalError(err)).toBe(false);
        expect(err.message).toBe('OpenRouter returned empty summary');
    });

    it('promotes an HTTP 200 body carrying a model error to fatal (status gate disabled)', async () => {
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ error: { message: 'No endpoints found for this model' } }),
        });
        await expect(summarizeText('t', orSettings()))
            .rejects.toMatchObject({ code: 'invalid_model_config' });
    });

    it('treats a whitespace-only reply as empty', async () => {
        globalThis.fetch.mockResolvedValue(okReply('   \n  '));
        await expect(summarizeText('t', orSettings())).rejects.toThrow('OpenRouter returned empty summary');
    });

    it('lets a network-level fetch rejection propagate untouched', async () => {
        globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(summarizeText('t', orSettings())).rejects.toThrow('Failed to fetch');
    });
});

// ---------------------------------------------------------------------------
// summarizeText — vLLM error paths
// ---------------------------------------------------------------------------

describe('summarizeText vLLM error paths', () => {
    it('throws fatal missing_url when the base URL is blank', async () => {
        await expect(summarizeText('t', vllmSettings({ summarize_vllm_url: '   ' })))
            .rejects.toMatchObject({ code: 'missing_url', provider: 'vllm' });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('throws fatal missing_api_key when the custom key is absent', async () => {
        keys.custom = '';
        await expect(summarizeText('t', vllmSettings()))
            .rejects.toMatchObject({ code: 'missing_api_key', provider: 'vllm' });
    });

    it('checks the URL before the key', async () => {
        keys.custom = '';
        await expect(summarizeText('t', vllmSettings({ summarize_vllm_url: '' })))
            .rejects.toMatchObject({ code: 'missing_url' });
    });

    it.each([401, 403])('treats HTTP %i as fatal invalid_api_key', async (status) => {
        globalThis.fetch.mockResolvedValue(httpError(status, 'denied'));
        await expect(summarizeText('t', vllmSettings()))
            .rejects.toMatchObject({ code: 'invalid_api_key', provider: 'vllm' });
    });

    it('treats a 404 model error as fatal invalid_model_config', async () => {
        globalThis.fetch.mockResolvedValue(httpError(404, 'unknown model'));
        await expect(summarizeText('t', vllmSettings()))
            .rejects.toMatchObject({ code: 'invalid_model_config', provider: 'vllm' });
    });

    it('treats other HTTP failures as transient', async () => {
        globalThis.fetch.mockResolvedValue(httpError(503, 'server busy'));
        const err = await summarizeText('t', vllmSettings()).catch(e => e);
        expect(isSummarizationFatalError(err)).toBe(false);
        expect(err.message).toBe('vLLM HTTP 503: server busy');
    });

    it('throws a transient Error on an empty reply', async () => {
        globalThis.fetch.mockResolvedValue(okReply(null));
        await expect(summarizeText('t', vllmSettings())).rejects.toThrow('vLLM returned empty summary');
    });

    it('returns the summary on success', async () => {
        globalThis.fetch.mockResolvedValue(okReply('a dense summary'));
        expect(await summarizeText('t', vllmSettings())).toBe('a dense summary');
    });
});

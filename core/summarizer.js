/**
 * ============================================================================
 * VectFox SUMMARIZER
 * ============================================================================
 * Summarizes chat message text before it is embedded and stored, producing
 * compact, information-dense summaries optimized for semantic retrieval.
 *
 * Supported providers:
 *   - openrouter : Uses the OpenRouter chat completions API
 *   - vllm       : Uses a local vLLM server (OpenAI-compatible endpoint)
 *
 * All failures throw — summaries are never silently replaced with raw text (a raw
 * chunk is useless in the vector store, and the chunk path no longer calls this).
 * Config/auth/invalid-model failures throw SummarizationFatalError; transient
 * provider failures throw a plain Error. Callers abort with clear UX either way.
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { getDefaultSummarizePrompt } from './prompts-i18n.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import { callChatCompletion, extractReply, errorBodyText } from './llm-transport.js';
import { log } from './log.js';

/**
 * Fatal summarization error that should abort vectorization instead of silently
 * falling back to raw text.
 */
export class SummarizationFatalError extends Error {
    /**
     * @param {string} message
     * @param {string} provider
     * @param {string} code
     */
    constructor(message, provider, code) {
        super(message);
        this.name = 'SummarizationFatalError';
        this.provider = provider;
        this.code = code;
    }
}

/**
 * @param {unknown} err
 * @returns {err is SummarizationFatalError}
 */
export function isSummarizationFatalError(err) {
    return err instanceof SummarizationFatalError;
}

/**
 * Validate that the LLM configuration (provider, model, credentials) is filled in.
 * These settings are shared between chunk summarization (currently disabled) and the
 * EventBase extractor — so any vectorization that goes through an LLM call requires them.
 *
 * @param {object} settings - VectFox settings object
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateLLMConfig(settings = {}) {
    const provider = (settings?.summarize_provider || 'openrouter').toLowerCase();
    const model = (settings?.summarize_model || '').trim();

    if (!model) {
        return { ok: false, reason: 'Summarization / EventBase extraction model is not set.' };
    }

    if (provider === 'openrouter') {
        const key = _getOpenRouterApiKey(settings);
        if (!key) {
            return { ok: false, reason: 'OpenRouter API key is not set.' };
        }
    } else if (provider === 'vllm') {
        const url = (settings?.summarize_vllm_url || '').trim();
        if (!url) {
            return { ok: false, reason: 'vLLM Base URL is not set.' };
        }
    } else {
        return { ok: false, reason: `Unknown LLM provider: ${provider}` };
    }

    return { ok: true };
}

/**
 * Build a fingerprint of active summarization configuration.
 * Includes effective credential source so callers can detect when user fixes settings.
 * @param {object} settings
 * @returns {string}
 */
export function getSummarizationConfigFingerprint(settings = {}) {
    const provider = settings?.summarize_provider || 'openrouter';

    if (provider === 'openrouter') {
        const key = _getOpenRouterApiKey(settings);
        // Avoid logging key material: only include deterministic length + boundary chars.
        const keySig = key ? `${key.length}:${key.slice(0, 2)}:${key.slice(-2)}` : 'missing';
        return `openrouter|${keySig}`;
    }

    if (provider === 'vllm') {
        const url = (settings?.summarize_vllm_url || '').trim();
        // Key now lives in SECRET_KEYS.CUSTOM (masked client-side). Fingerprint
        // uses the masked-value length + boundary chars — still deterministic for
        // detecting key-rotation, never logs the secret.
        const key = getCustomApiKey(settings);
        const keySig = key ? `${key.length}:${key.slice(0, 2)}:${key.slice(-2)}` : 'missing';
        return `vllm|${url}|${keySig}`;
    }

    return `other|${provider}`;
}

/** @deprecated Use getDefaultSummarizePrompt(mode) from prompts-i18n.js instead. */
export const DEFAULT_SUMMARIZE_PROMPT = getDefaultSummarizePrompt('intl');

/** Default output token budget for a single summary (Latin/other scripts). */
const DEFAULT_MAX_TOKENS = 768;
/** Default output token budget for a single summary (CJK-dominant input). */
const CJK_MAX_TOKENS = 1536;
/** Default request timeout in ms for a single-item summarization call. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Summarize a chunk of text using the configured provider.
 *
 * Failures throw — they are never swallowed into raw text. A raw chunk in the
 * vector store is useless for EventBase retrieval, and the chunk path (lorebook /
 * document / etc.) no longer routes through the summarizer, so there is no caller
 * that wants the un-summarized text back.
 *
 * @param {string} text - Raw message/chunk text to summarize
 * @param {object} settings - VectFox settings object
 * @returns {Promise<string>} Summary text
 * @throws {SummarizationFatalError} on config/auth/invalid-model failures
 * @throws {Error} on transient provider failures (HTTP 5xx, empty response)
 */
export async function summarizeText(text, settings) {
    if (!text || typeof text !== 'string') return text;

    const provider = settings?.summarize_provider || 'openrouter';
    // don't remove
    //log.verbose(`[VectFox Summarizer] summarizeText called — provider=${provider}, textLen=${text.length}`);
    const model = (settings?.summarize_model || '').trim();
    if (!model) {
        throw new SummarizationFatalError(
            'No summarization model configured. Set a model in Summarize Before Store settings.',
            provider,
            'missing_model'
        );
    }
    const promptTemplate = settings?.summarize_prompt || getDefaultSummarizePrompt(settings?.cjk_tokenizer_mode);
    const prompt = promptTemplate.replace('{{text}}', text);

    if (provider === 'openrouter') {
        return await _callOpenRouter(prompt, model, settings, text.length, _estimateSummaryTokenBudget(text));
    }
    if (provider === 'vllm') {
        return await _callVLLM(prompt, model, settings, _estimateSummaryTokenBudget(text));
    }
    throw new SummarizationFatalError(
        `Unsupported summarization provider: ${provider}`,
        provider,
        'unknown_provider'
    );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimate a safe output token budget for a summary of the given text.
 * CJK scripts tokenize at ~2-3 tokens/char vs ~0.75 tokens/word for Latin,
 * so the same "10 sentence" output costs 4-6x more tokens in Chinese/Japanese.
 * @param {string} text
 * @returns {number}
 */
function _estimateSummaryTokenBudget(text) {
    const CJK_RATIO = (text.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length / Math.max(1, text.length);
    // >10% CJK characters → assume CJK-dominant output → use CJK_MAX_TOKENS
    // Otherwise standard Latin/etc → DEFAULT_MAX_TOKENS (safe headroom for 10 sentences)
    return CJK_RATIO > 0.1 ? CJK_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}

/** Summaries run cooler than the default but not deterministic. */
const SUMMARIZE_TEMPERATURE = 0.3;

// _getOpenRouterApiKey was inlined here pre-H-1; now an alias for the
// canonical single-key helper. ONE OpenRouter key shared across
// embedding/summarize/agentic — see core/api-keys.js docstring for the
// architecture pivot rationale (custom secret_state slots don't round-trip).
const _getOpenRouterApiKey = getOpenRouterApiKey;

async function _callOpenRouter(prompt, model, settings, originalLength, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // Presence-only check: getOpenRouterApiKey() returns the MASKED value from
    // secret_state (e.g. "*******abcd"), not the real key — ST's getSecretState
    // masks all non-EXPORTABLE_KEYS. We can't send a masked value as a Bearer
    // token, so we route through ST's own /api/backends/chat-completions/generate
    // proxy, which reads the real key server-side via readSecret(SECRET_KEYS.OPENROUTER)
    // and forwards to OpenRouter. Same pattern the embedding flow already uses
    // via /api/vector/insert.
    const apiKey = _getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new SummarizationFatalError(
            'OpenRouter API key not found. Add it in Summarize Before Store settings.',
            'openrouter',
            'missing_api_key'
        );
    }

    const result = await callChatCompletion({
        provider: 'openrouter',
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature: SUMMARIZE_TEMPERATURE,
        timeoutMs,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new SummarizationFatalError(
                `OpenRouter authentication failed (${status}). Check your API key.`,
                'openrouter',
                'invalid_api_key'
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Summarizer',
            provider: 'OpenRouter',
            model,
            status,
            responseText: errText,
        });
        if (modelConfigError) {
            throw new SummarizationFatalError(modelConfigError, 'openrouter', 'invalid_model_config');
        }
        throw new Error(`OpenRouter HTTP ${status}: ${errText}`);
    }

    const summary = extractReply(result.data);
    if (!summary) {
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Summarizer',
            provider: 'OpenRouter',
            model,
            status: result.status,
            responseText: errorBodyText(result.data),
            enforceStatusGate: false,
        });
        if (modelConfigError) throw new SummarizationFatalError(modelConfigError, 'openrouter', 'invalid_model_config');
        throw new Error('OpenRouter returned empty summary');
    }
    // don't remove 
    //log.verbose(`[VectFox Summarizer] OpenRouter: ${originalLength} chars → ${summary.length} chars`);
    return summary;
}

/**
 * Build the `/v1/chat/completions` endpoint URL from a user-supplied vLLM base URL.
 *
 * Tolerates whether the user pasted `http://localhost:8000` (no /v1 suffix) or
 * `https://openrouter.ai/api/v1` (with /v1 suffix) — strips the trailing `/v1`
 * if present, then re-appends `/v1/chat/completions` so we always hit the same
 * canonical OpenAI-compatible path. Mirrors the suffix-normalization pattern
 * core-vector-api.js already uses for the embeddings URL.
 *
 * Exported so eventbase-extractor.js and agentic-retrieval.js share the same
 * normalization — the vLLM-style base URL flows through three call sites and
 * inline regex drift was the bug that surfaced this helper.
 *
 * @param {string} baseUrl raw user input from settings.summarize_vllm_url etc.
 * @returns {string} fully-qualified chat-completions URL
 */
export function buildVllmChatCompletionsUrl(baseUrl) {
    return String(baseUrl || '')
        .trim()
        .replace(/\/+$/, '')        // trailing slashes
        .replace(/\/v1$/, '')       // trailing /v1 (e.g. openrouter.ai/api/v1)
        + '/v1/chat/completions';
}

async function _callVLLM(prompt, model, settings, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // Routes through ST's chat-completions proxy with `chat_completion_source:
    // 'custom'` — ST's server reads the real key from SECRET_KEYS.CUSTOM and
    // forwards to settings.summarize_vllm_url. Same pattern as _callOpenRouter
    // above. The function name is kept for compat with the provider-dispatch
    // switch; the wire is no longer a direct fetch to vLLM.
    const baseUrl = (settings?.summarize_vllm_url || '').trim();
    if (!baseUrl) {
        throw new SummarizationFatalError(
            'vLLM URL not configured.',
            'vllm',
            'missing_url'
        );
    }

    // Presence-only check on the masked key (same caveat as _callOpenRouter:
    // _readSecretValue returns the masked form). Real key lives server-side.
    const apiKey = getCustomApiKey(settings);
    if (!apiKey) {
        throw new SummarizationFatalError(
            'vLLM / Custom OpenAI-compatible API key not configured. Enter it in Summarize Before Store settings.',
            'vllm',
            'missing_api_key'
        );
    }

    const result = await callChatCompletion({
        provider: 'vllm',
        model,
        vllmUrl: baseUrl,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature: SUMMARIZE_TEMPERATURE,
        timeoutMs,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new SummarizationFatalError(
                `vLLM authentication failed (${status}). Check your API key in Summarize Before Store settings.`,
                'vllm',
                'invalid_api_key'
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Summarizer',
            provider: 'vLLM',
            model,
            status,
            responseText: errText,
        });
        if (modelConfigError) {
            throw new SummarizationFatalError(modelConfigError, 'vllm', 'invalid_model_config');
        }
        throw new Error(`vLLM HTTP ${status}: ${errText}`);
    }

    const summary = extractReply(result.data);
    if (!summary) {
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Summarizer',
            provider: 'vLLM',
            model,
            status: result.status,
            responseText: errorBodyText(result.data),
            enforceStatusGate: false,
        });
        if (modelConfigError) throw new SummarizationFatalError(modelConfigError, 'vllm', 'invalid_model_config');
        throw new Error('vLLM returned empty summary');
    }

    return summary;
}

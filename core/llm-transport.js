/**
 * ============================================================================
 * LLM TRANSPORT
 * ============================================================================
 * The wire-level half of every VectFox LLM call: build the OpenAI-compatible
 * envelope, POST it through SillyTavern's chat-completions proxy, and hand the
 * caller back either the parsed body or the failure status + text.
 *
 * Shared by summarizer.js, eventbase-extractor.js, reformat-extractor.js and
 * agentic-retrieval.js, which previously carried four near-verbatim copies of
 * this fetch.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It never throws a domain error and never classifies a failure. Each feature
 * owns its own error class (SummarizationFatalError / EventBaseFatalError /
 * ReformatFatalError / a plain Error tagged `invalid_model_config`), its own
 * message wording, and its own policy on what counts as fatal vs. skippable —
 * agentic-retrieval, for instance, intentionally has no 401/403 branch at all.
 * Returning a result object keeps every `throw` at its original call site.
 *
 * That split is what lets this module exist without violating the independence
 * requirement documented in reformat-schema.js: transport is shared, but
 * schemas, prompts, parsers and error taxonomies stay per-feature, so a change
 * to one feature's record shape still cannot reach another's.
 *
 * Dependency note: imports `getRequestHeaders` and nothing else from ST. Every
 * consumer's test suite mocks `script.js` with exactly that export, so adding
 * this import edge does not break module loading under Vitest.
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';

/** ST's proxy endpoint. It reads the real API key server-side. */
const CHAT_COMPLETIONS_ENDPOINT = '/api/backends/chat-completions/generate';

/**
 * POST a chat-completion request through ST's proxy.
 *
 * On a non-OK response the body is read with the same
 * `.text().catch(() => statusText)` fallback all four callers used, so a
 * failure to read the error stream still yields a usable message.
 *
 * @param {object}   params
 * @param {string}   params.provider    - 'vllm' routes as `custom`; anything else as `openrouter`.
 * @param {string}   params.model
 * @param {object[]} params.messages    - OpenAI-style message array.
 * @param {number}   params.maxTokens
 * @param {number}   params.temperature
 * @param {number}   params.timeoutMs
 * @param {string}   [params.vllmUrl]        - Required when provider is 'vllm'.
 * @param {object}   [params.responseFormat] - Omitted from the body when absent.
 * @returns {Promise<{ok: true, status: number, data: any} | {ok: false, status: number, errText: string}>}
 */
export async function callChatCompletion({
    provider,
    model,
    messages,
    maxTokens,
    temperature,
    timeoutMs,
    vllmUrl,
    responseFormat,
}) {
    const isVllm = provider === 'vllm';

    const response = await fetch(CHAT_COMPLETIONS_ENDPOINT, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: isVllm ? 'custom' : 'openrouter',
            ...(isVllm ? { custom_url: vllmUrl } : {}),
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { ok: false, status: response.status, errText };
    }

    return { ok: true, status: response.status, data: await response.json() };
}

/**
 * Pull the assistant reply out of an OpenAI-compatible response body.
 * @param {any} data
 * @returns {string|null} Trimmed content, or null when absent/blank.
 */
export function extractReply(data) {
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

/**
 * Render a 200-with-no-content body as text for the model-config classifier.
 * OpenRouter via ST's proxy can answer HTTP 200 with `{"error": {...}}` (or
 * `{"message":"Not Found"}`) for a retired model instead of a 4xx, so callers
 * re-run classification on the body with `enforceStatusGate: false`.
 * @param {any} data
 * @returns {string}
 */
export function errorBodyText(data) {
    return data?.error ? JSON.stringify(data.error) : JSON.stringify(data || {});
}

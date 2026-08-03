/**
 * ============================================================================
 * EVENTBASE EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to extract structured EventRecord objects
 * from a window of chat messages.
 *
 * Returns an array of validated EventRecord objects (may be empty).
 * Throws EventBaseFatalError for config/auth failures.
 * Throws EventBaseExtractionError for parse/validation failures (non-fatal per-window).
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { callChatCompletion, extractReply, errorBodyText } from './llm-transport.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import {
    EVENT_TYPES,
    EventBaseExtractionError,
    EventBaseFatalError,
    validateEvent,
    buildEmbedText,
    buildExtractionPrompt,
    EVENTBASE_SCHEMA_VERSION,
} from './eventbase-schema.js';
import { cleanText } from './text-cleaning.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Key resolution (mirrors summarizer.js pattern)
// ---------------------------------------------------------------------------

/**
 * Get the OpenRouter API key from Core summarization settings or ST secrets.
 * @param {object} settings
 * @returns {string}
 */
// _getOpenRouterApiKey lived inline here pre-H-1; now an alias for the
// canonical single-key helper. ONE OpenRouter key shared across
// embedding/summarize/agentic — see core/api-keys.js docstring.
const _getOpenRouterApiKey = getOpenRouterApiKey;

// ---------------------------------------------------------------------------
// Response body builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reply extraction
// ---------------------------------------------------------------------------
//
// Note: the EventBase prompt requires a top-level JSON array, so no
// `responseFormat` is passed to callChatCompletion — forcing
// response_format=json_object makes providers coerce output to an object and
// suppress valid array responses.

/**
 * OpenRouter (and ST's proxy) sometimes returns HTTP 200 with an error in the
 * BODY instead of a 4xx — e.g. a retired/unknown model comes back as
 * `{ "error": { "message": "…deprecated…" } }` with no `choices`. _extractReply
 * then yields null and we'd throw a per-window "empty response" skip, silently
 * dropping the real cause. This re-runs the model-config classifier on the body
 * so that case surfaces as a fatal error. Throws EventBaseFatalError if matched;
 * otherwise returns (logs the raw body under debug for diagnosis).
 *
 * @param {{ provider: string, model: string, status: number, data: any, settings: object }} ctx
 */
function _classifyEmptyReplyBody({ provider, model, status, data, settings }) {
    const bodyText = errorBodyText(data);
    const modelConfigError = getModelConfigErrorMessage({
        contextLabel: 'EventBase',
        provider,
        model,
        status,
        responseText: bodyText,
        enforceStatusGate: false,
    });
    if (modelConfigError) {
        throw new EventBaseFatalError(modelConfigError, 'invalid_model_config');
    }
    // Empty reply that isn't a fatal model-config error — unexpected but the
    // window is skipped, not failed. Always-on warning.
    log.warn(`[EventBase] ${provider} returned empty reply (HTTP ${status}) — raw body: ${bodyText.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// JSON parse + repair
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a JSON array from raw LLM output.
 * Strips code fences and locates the outermost [ ... ] block.
 * @param {string} raw
 * @returns {unknown[]}
 */
function _parseJsonArray(raw, windowIndex = -1, msgRange = '') {
    let text = (raw || '').trim();
    const rangeStr = msgRange ? ` ${msgRange}` : '';

    log.domain('raw_llm', 'trace', `[EventBase] Parser window=${windowIndex}${rangeStr}: raw length=${text.length}, preview:`, text.slice(0, 150));

    // Strip code fences
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new EventBaseExtractionError('Empty LLM response');
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse first (covers valid array JSON immediately).
    try {
        const direct = JSON.parse(text);
        if (Array.isArray(direct)) candidates.push(direct);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            // Some providers under json_object mode emit {} when the correct
            // semantic answer is "no events". Treat that as an empty result
            // instead of failing the whole window.
            if (Object.keys(direct).length === 0) {
                candidates.push([]);
            }
            const wrappedArr = Object.values(direct).find(v => Array.isArray(v));
            if (Array.isArray(wrappedArr)) candidates.push(wrappedArr);
        }
    } catch {
        // Continue with extraction-based parsing.
    }

    // 2) NDJSON / object-stream: one JSON object per line.
    if (text.includes('\n')) {
        const lines = text
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && l.startsWith('{') && l.endsWith('}'));
        if (lines.length > 0) {
            try {
                const arr = lines.map(line => JSON.parse(line));
                candidates.push(arr);
            } catch {
                // Ignore and continue.
            }
        }
    }

    // 3) Try every balanced array slice and keep parseable ones.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '[') depth++;
            else if (text[j] === ']') {
                depth--;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end === -1) continue;

        const slice = text.slice(i, end + 1);
        try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) candidates.push(parsed);
        } catch {
            // Keep scanning for other candidates.
        }
    }

    // 4) Extract top-level object stream from first '{' to last '}' as a fallback.
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const objectRegion = text.slice(firstBrace, lastBrace + 1);
        const stream = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < objectRegion.length; i++) {
            if (objectRegion[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (objectRegion[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    const part = objectRegion.slice(start, i + 1);
                    try {
                        const obj = JSON.parse(part);
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                            stream.push(obj);
                        }
                    } catch {
                        // Skip malformed object parts.
                    }
                    start = -1;
                }
            }
        }
        if (stream.length > 0) {
            candidates.push(stream);
        }
    }

    // Pick the first candidate that looks like event objects.
    if (log.domainEnabled('raw_llm')) {
        log.domain('raw_llm', 'trace', `[EventBase] Parser window=${windowIndex}${rangeStr}: ${candidates.length} candidate array(s) found:`,
            candidates.map((c, i) => {
                const first = c[0];
                const type = Array.isArray(first) ? 'array' : typeof first;
                const keys = (first && typeof first === 'object' && !Array.isArray(first))
                    ? Object.keys(first).slice(0, 5).join(',')
                    : JSON.stringify(first)?.slice(0, 40);
                return `[${i}] len=${c.length} firstType=${type} keys/val=${keys}`;
            })
        );
    }

    // Prefer a non-empty array whose first item looks like an event object.
    // Only fall back to an empty array [] if no event-object array is found
    // (handles a legit "no events" response without mistaking property arrays
    // like "items":[], "factions":[] for the top-level event array).
    const isEventArray = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const first = arr[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
        return Object.prototype.hasOwnProperty.call(first, 'event_type')
            || Object.prototype.hasOwnProperty.call(first, 'summary')
            || Object.prototype.hasOwnProperty.call(first, 'importance');
    };
    const chosen = candidates.find(isEventArray)
        ?? candidates.find(arr => Array.isArray(arr) && arr.length === 0);

    if (!chosen) {
        const sample = candidates[0];
        const sampleType = Array.isArray(sample) && sample.length > 0 ? typeof sample[0] : 'none';
        throw new EventBaseExtractionError(
            `Unable to find event-object array in LLM response. ` +
            `candidateCount=${candidates.length}, firstCandidateItemType=${sampleType}, ` +
            `rawPreview=${text.slice(0, 200)}`
        );
    }

    if (log.domainEnabled('raw_llm')) {
        const chosenIdx = candidates.indexOf(chosen);
        log.domain('raw_llm', 'trace', `[EventBase] Parser window=${windowIndex}${rangeStr}: chose candidate[${chosenIdx}] len=${chosen.length}`);
    }

    if (chosen.length > 0 && (typeof chosen[0] !== 'object' || Array.isArray(chosen[0]))) {
        throw new EventBaseExtractionError(
            `Parsed array contains non-object items (first type: ${typeof chosen[0]}). ` +
            `Raw: ${JSON.stringify(chosen).slice(0, 120)}`
        );
    }

    return chosen;
}

// ---------------------------------------------------------------------------
// Script detection (lightweight)
// ---------------------------------------------------------------------------

/**
 * Returns the dominant script class of a string.
 * Used as a post-parse sanity check to catch language-rule violations.
 * @param {string} text
 * @returns {'cjk'|'latin'|'mixed'|'empty'}
 */
function _detectScript(text) {
    if (!text) return 'empty';
    const cjk = (text.match(/[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const total = cjk + latin;
    if (total === 0) return 'empty';
    const cjkRatio = cjk / total;
    if (cjkRatio > 0.6) return 'cjk';
    if (cjkRatio < 0.2) return 'latin';
    return 'mixed';
}

/**
 * Infers the human language for the LLM hint, even for mixed-script excerpts.
 * Returns null when the excerpt is clearly Latin-only.
 */
function _inferLanguageHint(text) {
    if (!text) return null;
    const hangul = (text.match(/[\uAC00-\uD7AF]/g) || []).length;
    const hiragana = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const cjk = (text.match(/[\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length + hangul + hiragana;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const total = cjk + latin;
    if (total === 0 || cjk / total < 0.15) return null; // too little CJK to guess
    if (hangul > hiragana && hangul > cjk * 0.3) return '\uD55C\uAD6D\uC5B4 (Korean)';
    if (hiragana > 5) return '\u65E5\u672C\u8A9E (Japanese)';
    return '\u4E2D\u6587 (Chinese)';
}

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

async function _callOpenRouter(prompt, settings, windowIndex) {
    // Presence-only check: see summarizer._callOpenRouter for the full rationale.
    // Short version: getOpenRouterApiKey() returns ST's MASKED value, so we route
    // through /api/backends/chat-completions/generate which reads the real key
    // server-side via readSecret(SECRET_KEYS.OPENROUTER).
    const apiKey = _getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new EventBaseFatalError(
            'EventBase: OpenRouter API key not found. Add it in EventBase settings (or Summarize Before Store settings uses the same key).',
            'missing_api_key',
        );
    }

    const model = (settings.summarize_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set the Summarization Model in Core → LLM Summarization settings.',
            'missing_model',
        );
    }

    const maxTokens = settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.eventbase_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS;

    const result = await callChatCompletion({
        provider: 'openrouter',
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature,
        timeoutMs,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new EventBaseFatalError(
                `EventBase: OpenRouter authentication failed (${status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'OpenRouter',
            model,
            status,
            responseText: errText,
        });
        if (modelConfigError) {
            throw new EventBaseFatalError(modelConfigError, 'invalid_model_config');
        }
        throw new EventBaseExtractionError(
            `EventBase: OpenRouter HTTP ${status}: ${errText}`,
            windowIndex,
        );
    }

    const reply = extractReply(result.data);
    if (!reply) {
        _classifyEmptyReplyBody({ provider: 'OpenRouter', model, status: result.status, data: result.data, settings });
        throw new EventBaseExtractionError('EventBase: OpenRouter returned empty response', windowIndex);
    }
    return reply;
}

async function _callVLLM(prompt, settings, windowIndex) {
    // Routes through ST's chat-completions proxy with `chat_completion_source:
    // 'custom'` — server reads key from SECRET_KEYS.CUSTOM, forwards to
    // settings.summarize_vllm_url. Same pattern as summarizer.js::_callVLLM.
    const baseUrl = (settings.summarize_vllm_url || '').trim();
    if (!baseUrl) {
        throw new EventBaseFatalError(
            'EventBase: vLLM URL not configured. Set the vLLM URL in Core → LLM Summarization settings.',
            'missing_url',
        );
    }

    const model = (settings.summarize_model || '').trim();
    if (!model) {
        throw new EventBaseFatalError(
            'EventBase: No model configured. Set the Summarization Model in Core → LLM Summarization settings.',
            'missing_model',
        );
    }

    const apiKey = getCustomApiKey(settings);
    if (!apiKey) {
        throw new EventBaseFatalError(
            'EventBase: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → LLM Summarization settings.',
            'missing_api_key',
        );
    }

    const maxTokens = settings.eventbase_max_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.eventbase_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.eventbase_timeout_ms || DEFAULT_TIMEOUT_MS;

    const result = await callChatCompletion({
        provider: 'vllm',
        model,
        vllmUrl: baseUrl,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature,
        timeoutMs,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new EventBaseFatalError(
                `EventBase: vLLM authentication failed (${status}). Check your API key in Core → LLM Summarization settings.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'EventBase',
            provider: 'vLLM',
            model,
            status,
            responseText: errText,
        });
        if (modelConfigError) {
            throw new EventBaseFatalError(modelConfigError, 'invalid_model_config');
        }
        throw new EventBaseExtractionError(
            `EventBase: vLLM HTTP ${status}: ${errText}`,
            windowIndex,
        );
    }

    const reply = extractReply(result.data);
    if (!reply) {
        _classifyEmptyReplyBody({ provider: 'vLLM', model, status: result.status, data: result.data, settings });
        throw new EventBaseExtractionError('EventBase: vLLM returned empty response', windowIndex);
    }
    return reply;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract structured event records from a window of chat messages.
 *
 * @param {object} params
 * @param {object[]} params.messages  - Array of chat message objects with .mes and .name
 * @param {number} params.windowStart - 0-based start index in the full chat
 * @param {number} params.windowEnd   - 0-based end index (inclusive)
 * @param {object} params.settings    - VectFox settings
 * @param {number} [params.windowIndex] - Window index for error reporting
 * @returns {Promise<object[]>} Array of full EventRecord objects (ingestion fields attached)
 */
export async function extractEvents({ messages, windowStart, windowEnd, settings, windowIndex = 0 }) {
    // Logging routes through core/log.js. Per-window flow → Verbose; per-item
    // parse detail → Trace; raw LLM/parser dumps → 'raw_llm' domain deep-dive.

    // Compact message-range tag appended to every log line so chunks in the DB browser
    // (which display "from Message #<windowEnd>") are searchable directly from the log.
    const msgRange = `msgs=${windowStart}-${windowEnd}`;

    // Build excerpt text from messages
    const excerptLines = messages.map(m => {
        const speaker = m.name || (m.is_user ? 'User' : 'Assistant');
        const text = cleanText(String(m.mes || '')).trim();
        return `${speaker}: ${text}`;
    });
    const excerptText = excerptLines.join('\n\n');

    if (!excerptText.trim()) {
        log.verbose('[EventBase] Skipping empty window');
        return [];
    }

    const maxCount = settings.eventbase_max_events_per_window || 5;

    // Detect dominant script BEFORE building prompt so we can inject an explicit language hint
    const excerptScript = _detectScript(excerptText);
    const languageHint = _inferLanguageHint(excerptText);
    let basePrompt = buildExtractionPrompt(
        excerptText,
        maxCount,
        settings.eventbase_custom_prompt || '',
        settings.cjk_tokenizer_mode || 'intl',
    );
    if (languageHint) {
        basePrompt = `DETECTED EXCERPT LANGUAGE: ${languageHint}. You MUST write ALL string fields in that language — no exceptions.\n\n${basePrompt}`;
    }
    const prompt = basePrompt;
    const provider = (settings.summarize_provider || 'openrouter').toLowerCase();

    log.verbose(`[EventBase] Extracting events — window=${windowIndex} ${msgRange}, provider=${provider}, messages=${messages.length}`);

    // Call provider
    let rawReply;
    if (provider === 'vllm') {
        rawReply = await _callVLLM(prompt, settings, windowIndex);
    } else {
        rawReply = await _callOpenRouter(prompt, settings, windowIndex);
    }

    log.domain('raw_llm', 'trace', `[EventBase] Raw LLM reply (window=${windowIndex} ${msgRange}):`, rawReply.slice(0, 500));

    // Parse JSON
    let rawArray;
    try {
        rawArray = _parseJsonArray(rawReply, windowIndex, msgRange);
    } catch (parseErr) {
        // Always log full raw reply on parse failure — this is a real failure.
        log.warn(`[EventBase] Window ${windowIndex} ${msgRange}: parse failed. Full raw reply:\n${rawReply}`);
        throw new EventBaseExtractionError(
            `EventBase: JSON parse failed for window ${windowIndex} (${msgRange}): ${parseErr.message}`,
            windowIndex,
        );
    }

    log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: parsed ${rawArray.length} event candidate(s)`);

    // Empty array is valid (no events extracted)
    if (rawArray.length === 0) {
        log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: LLM returned no events (valid skip)`);
        return [];
    }

    if (log.enabled('trace')) {
        log.trace(`[EventBase] Parsed array (window=${windowIndex} ${msgRange}): ${rawArray.length} items, types: [${rawArray.map(item => typeof item).join(', ')}]`);
        if (rawArray.length > 0 && typeof rawArray[0] !== 'object') {
            log.trace(`[EventBase] First item (non-object): ${JSON.stringify(rawArray[0]).slice(0, 100)}`);
        }
    }

    // Enforce hard cap — sort by importance desc, then truncate
    if (rawArray.length > maxCount) {
        log.warn(`[EventBase] Window ${windowIndex} ${msgRange}: LLM returned ${rawArray.length} events (> cap ${maxCount}), truncating by importance`);
        rawArray = rawArray
            .slice()
            .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
            .slice(0, maxCount);
    }

    // Validate + coerce each event
    const validatedEvents = [];
    const now = Date.now();
    for (let i = 0; i < rawArray.length; i++) {
        const { ok, errors, event } = validateEvent(rawArray[i]);
        if (!ok) {
            log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: validation failed — ${errors.join('; ')} — skipped`);
            continue;
        }
        if (errors.length > 0) {
            log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: coercion warnings — ${errors.join('; ')}`);
        }

        // Post-parse language sanity check (warn only — retained for visibility,
        // does not drop the event; retrieval quality may suffer if the summary
        // language doesn't match the collection's tokenizer mode)
        const summaryScript = _detectScript(event.summary);
        if (excerptScript !== 'empty' && excerptScript !== 'mixed' && summaryScript !== 'empty' && summaryScript !== 'mixed') {
            if (excerptScript !== summaryScript) {
                log.warn(`[EventBase] Window ${windowIndex} ${msgRange}, item ${i}: language mismatch (excerpt=${excerptScript}, summary=${summaryScript}) — kept`);
            }
        }

        // Attach ingestion metadata (event_id, source info, timestamps)
        const eventId = `eb_${Date.now()}_${windowStart}_${i}_${Math.random().toString(36).slice(2, 7)}`;
        const sourceHashes = messages.map(m => {
            // Use the message's hash if stored, otherwise hash the text
            const text = (m.mes || '').trim();
            return m.hash ?? _simpleHash(`${m.name || ''}:${text}`);
        });

        validatedEvents.push({
            ...event,
            event_id: eventId,
            source_message_ids: messages.map((_, idx) => windowStart + idx),
            source_message_hashes: sourceHashes,
            source_window_start: windowStart,
            source_window_end: windowEnd,
            created_at: now,
            schema_version: EVENTBASE_SCHEMA_VERSION,
        });
    }

    log.verbose(`[EventBase] Window ${windowIndex} ${msgRange}: extracted ${validatedEvents.length} valid events`);

    return validatedEvents;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Minimal djb2-style hash for message dedup (used when m.hash is not present).
 * @param {string} str
 * @returns {number}
 */
function _simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
        h >>>= 0;
    }
    return h;
}

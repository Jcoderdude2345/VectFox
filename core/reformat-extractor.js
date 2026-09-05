/**
 * ============================================================================
 * AUTO-REFORMAT EXTRACTOR
 * ============================================================================
 * Calls an LLM (OpenRouter or vLLM) to restructure Document/URL/Wiki source
 * text into structured, entity-tagged reformatted chunks (see
 * core/reformat-schema.js for the record shape).
 *
 * Mirrors core/eventbase-extractor.js's shape (provider calling, JSON parse
 * + repair) but is a fully independent implementation — no imports from
 * EventBase's files. The one deliberate improvement over that precedent:
 * provider calls are wrapped in AsyncUtils.retry() (transient-failure retry),
 * since losing a large single-shot batch call here is costlier than losing
 * one small EventBase chat window.
 *
 * Returns { chunks, warnings, batchesProcessed, batchesFailed, totalBatches }.
 * Throws ReformatFatalError for config/auth failures (aborts the whole run).
 * Individual batch parse/validation failures are non-fatal — logged as
 * warnings, the rest of the document still gets processed.
 * ============================================================================
 */

import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { callChatCompletion, extractReply, errorBodyText } from './llm-transport.js';
import { getModelConfigErrorMessage } from './model-http-errors.js';
import { chunkText } from './chunking.js';
import { createReformatExecution } from './reformat-run.js';
import {
    ReformatExtractionError,
    ReformatFatalError,
    validateReformattedChunk,
    buildReformatPrompt,
    buildLinkingPrompt,
    buildRepairPrompt,
    computeBatchCoverage,
    computeNameVerification,
    computeKeywordVerification,
    normalizeForMatch,
} from './reformat-schema.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_BATCH_CHARS = 6000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_NAME_FUZZY_THRESHOLD = 0.8;
const DEFAULT_COVERAGE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Config resolution (independent copy of agentic-retrieval.js's
// _resolveAgenticLLMConfig pattern — each VectFox LLM feature keeps its own
// copy rather than sharing one resolver; see reformat-schema.js docstring)
// ---------------------------------------------------------------------------

function _resolveProvider(settings) {
    return (settings.reformat_provider || settings.summarize_provider || 'openrouter').toLowerCase();
}

function _resolveModel(settings) {
    return (settings.reformat_model || settings.summarize_model || '').trim();
}

function _resolveVllmUrl(settings) {
    return (settings.reformat_vllm_url || settings.summarize_vllm_url || '').trim();
}

// ---------------------------------------------------------------------------
// HTTP callers
// ---------------------------------------------------------------------------

/**
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @returns {Promise<{reply: string, finishReason: string|null}>}
 */
async function _callOpenRouter(prompt, settings, batchIndex, signal) {
    const apiKey = getOpenRouterApiKey(settings);
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: OpenRouter API key not found. Add it in Core → LLM Summarization settings (Auto-Reformat inherits it unless overridden in ChunkBase settings).',
            'missing_api_key',
        );
    }

    const model = _resolveModel(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization Model.',
            'missing_model',
        );
    }

    const maxTokens = settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.reformat_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS;

    const result = await callChatCompletion({
        provider: 'openrouter',
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature,
        timeoutMs,
        signal,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new ReformatFatalError(
                `Auto-Reformat: OpenRouter authentication failed (${status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'OpenRouter', model, status, responseText: errText,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: OpenRouter HTTP ${status}: ${errText}`, batchIndex);
    }

    const reply = extractReply(result.data);
    const finishReason = result.data?.choices?.[0]?.finish_reason || null;
    if (!reply) {
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'OpenRouter', model, status: result.status, responseText: errorBodyText(result.data), enforceStatusGate: false,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError('Auto-Reformat: OpenRouter returned empty response', batchIndex);
    }
    return { reply, finishReason };
}

/**
 * @param {string} prompt
 * @param {object} settings
 * @param {number} batchIndex
 * @returns {Promise<{reply: string, finishReason: string|null}>}
 */
async function _callVLLM(prompt, settings, batchIndex, signal) {
    const baseUrl = _resolveVllmUrl(settings);
    if (!baseUrl) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM URL not configured. Set it in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization vLLM URL.',
            'missing_url',
        );
    }

    const model = _resolveModel(settings);
    if (!model) {
        throw new ReformatFatalError(
            'Auto-Reformat: No model configured. Set a model in ChunkBase → Auto-Reformat, or leave it blank to inherit the Summarization Model.',
            'missing_model',
        );
    }

    const apiKey = getCustomApiKey(settings);
    if (!apiKey) {
        throw new ReformatFatalError(
            'Auto-Reformat: vLLM / Custom OpenAI-compatible API key not configured. Enter it in Core → LLM Summarization settings.',
            'missing_api_key',
        );
    }

    const maxTokens = settings.reformat_max_output_tokens || DEFAULT_MAX_TOKENS;
    const temperature = settings.reformat_temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = settings.reformat_timeout_ms || DEFAULT_TIMEOUT_MS;

    const result = await callChatCompletion({
        provider: 'vllm',
        model,
        vllmUrl: baseUrl,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature,
        timeoutMs,
        signal,
    });

    if (!result.ok) {
        const { status, errText } = result;
        if (status === 401 || status === 403) {
            throw new ReformatFatalError(
                `Auto-Reformat: vLLM authentication failed (${status}). Check your API key.`,
                'invalid_api_key',
            );
        }
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'vLLM', model, status, responseText: errText,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError(`Auto-Reformat: vLLM HTTP ${status}: ${errText}`, batchIndex);
    }

    const reply = extractReply(result.data);
    const finishReason = result.data?.choices?.[0]?.finish_reason || null;
    if (!reply) {
        const modelConfigError = getModelConfigErrorMessage({
            contextLabel: 'Auto-Reformat', provider: 'vLLM', model, status: result.status, responseText: errorBodyText(result.data), enforceStatusGate: false,
        });
        if (modelConfigError) throw new ReformatFatalError(modelConfigError, 'invalid_model_config');
        throw new ReformatExtractionError('Auto-Reformat: vLLM returned empty response', batchIndex);
    }
    return { reply, finishReason };
}

/**
 * Calls the configured provider, retrying transient failures (network hiccups,
 * 5xx, timeouts) but never retrying ReformatFatalError (auth/config problems
 * a retry can't fix).
 */
async function _callProviderWithRetry(prompt, settings, batchIndex, execution) {
    const provider = _resolveProvider(settings);
    const callFn = provider === 'vllm' ? _callVLLM : _callOpenRouter;
    return execution.retry(signal => callFn(prompt, settings, batchIndex, signal), {
        shouldRetry: (err) => !(err instanceof ReformatFatalError),
        onRetry: (attempt, err) => log.warn(`[Auto-Reformat] Batch ${batchIndex}: attempt ${attempt} failed (${err?.message || err}), retrying...`),
    });
}

// ---------------------------------------------------------------------------
// JSON parse + repair — schema-adapted duplicate of eventbase-extractor.js's
// _parseJsonArray, keyed on entry_type/name/body instead of
// event_type/summary/importance. Not imported, per independence requirement.
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @param {number} [batchIndex]
 * @param {string[]} [keyFields] - An array candidate is accepted when its first
 *        item has ANY of these keys. Defaults to the entry-record shape; the
 *        linking pass passes ['source', 'target'] for its triple shape.
 * @returns {unknown[]}
 */
function _parseReformatArray(raw, batchIndex = -1, keyFields = ['entry_type', 'name', 'body']) {
    let text = (raw || '').trim();

    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    if (!text) {
        throw new ReformatExtractionError('Empty LLM response', batchIndex);
    }

    /** @type {unknown[][]} */
    const candidates = [];

    // 1) Direct parse first.
    try {
        const direct = JSON.parse(text);
        if (Array.isArray(direct)) candidates.push(direct);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            if (Object.keys(direct).length === 0) candidates.push([]);
            const wrappedArr = Object.values(direct).find(v => Array.isArray(v));
            if (Array.isArray(wrappedArr)) candidates.push(wrappedArr);
        }
    } catch {
        // Continue with extraction-based parsing.
    }

    // 2) NDJSON / object-stream: one JSON object per line.
    if (text.includes('\n')) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.startsWith('{') && l.endsWith('}'));
        if (lines.length > 0) {
            try {
                candidates.push(lines.map(line => JSON.parse(line)));
            } catch {
                // Ignore and continue.
            }
        }
    }

    // 3) Every balanced array slice.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (text[j] === '[') depth++;
            else if (text[j] === ']') {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }
        if (end === -1) continue;
        const slice = text.slice(i, end + 1);
        try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) candidates.push(parsed);
        } catch {
            // Keep scanning.
        }
    }

    // 4) Top-level object stream fallback.
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
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) stream.push(obj);
                    } catch {
                        // Skip malformed object parts.
                    }
                    start = -1;
                }
            }
        }
        if (stream.length > 0) candidates.push(stream);
    }

    const isReformatArray = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const first = arr[0];
        if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
        return keyFields.some(key => Object.prototype.hasOwnProperty.call(first, key));
    };
    const chosen = candidates.find(isReformatArray) ?? candidates.find(arr => Array.isArray(arr) && arr.length === 0);

    if (!chosen) {
        const sample = candidates[0];
        const sampleType = Array.isArray(sample) && sample.length > 0 ? typeof sample[0] : 'none';
        throw new ReformatExtractionError(
            `Unable to find entry-object array in LLM response. candidateCount=${candidates.length}, firstCandidateItemType=${sampleType}, rawPreview=${text.slice(0, 200)}`,
            batchIndex,
        );
    }

    if (chosen.length > 0 && (typeof chosen[0] !== 'object' || Array.isArray(chosen[0]))) {
        throw new ReformatExtractionError(
            `Parsed array contains non-object items (first type: ${typeof chosen[0]}). Raw: ${JSON.stringify(chosen).slice(0, 120)}`,
            batchIndex,
        );
    }

    return chosen;
}

// ---------------------------------------------------------------------------
// Batching packer
// ---------------------------------------------------------------------------

/** First non-empty line of a section, used as its title for continuation notes. */
function _firstLine(text) {
    return (text || '').split('\n').map(l => l.trim()).find(Boolean) || 'section';
}

/**
 * Splits source text into LLM-call-sized batches, respecting header
 * boundaries via the existing `section` chunking strategy wherever possible.
 * NOT a final chunk boundary — purely an internal batching mechanism so a
 * long document doesn't blow one call's output budget. If a single section
 * itself exceeds the budget (e.g. one header covering seven character
 * profiles — the exact reported bug), that section alone gets sub-split via
 * `paragraph` strategy into ordered continuation batches.
 *
 * @param {string} text
 * @param {number} targetChars
 * @returns {Promise<Array<{text: string, continuation: {sectionTitle: string}|null}>>}
 */
async function _buildBatches(text, targetChars) {
    const sectionChunks = await chunkText(text, { strategy: 'section' });
    const sections = sectionChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

    const batches = [];
    let current = '';

    const flush = () => {
        if (current.trim()) batches.push({ text: current.trim(), continuation: null });
        current = '';
    };

    for (const section of sections) {
        if (section.length > targetChars) {
            flush();
            const title = _firstLine(section);
            const paraChunks = await chunkText(section, { strategy: 'paragraph' });
            const paragraphs = paraChunks.map(c => (typeof c === 'string' ? c : c.text)).filter(Boolean);

            let sub = '';
            let isFirstSubBatch = true;
            const flushSub = () => {
                if (!sub.trim()) return;
                batches.push({ text: sub.trim(), continuation: isFirstSubBatch ? null : { sectionTitle: title } });
                isFirstSubBatch = false;
                sub = '';
            };
            for (const p of paragraphs) {
                if (sub && (sub.length + p.length + 2) > targetChars) {
                    flushSub();
                    sub = p;
                } else {
                    sub += (sub ? '\n\n' : '') + p;
                }
            }
            flushSub();
        } else if (current && (current.length + section.length + 2) > targetChars) {
            flush();
            current = section;
        } else {
            current += (current ? '\n\n' : '') + section;
        }
    }
    flush();

    return batches;
}

/**
 * Groups packed batches into ordered "chains" — a continuation batch must be
 * processed after the batch it continues (so it can be told which names were
 * already extracted), but independent chains can run concurrently.
 * @param {Array<{text: string, continuation: object|null}>} batches
 * @returns {Array<Array<object>>}
 */
function _groupIntoChains(batches) {
    const chains = [];
    let current = null;
    for (const b of batches) {
        if (b.continuation && current) {
            current.push(b);
        } else {
            current = [b];
            chains.push(current);
        }
    }
    return chains;
}

// ---------------------------------------------------------------------------
// Chain processing
// ---------------------------------------------------------------------------

/**
 * Parses, validates, and grounding-verifies one LLM reply, appending the
 * surviving records to `results` and their names to `alreadyExtractedNames`.
 * Shared by the main extraction call and the coverage repair call — both
 * replies carry the exact same record shape and guardrails.
 * @returns {number} How many records were appended
 */
function _ingestReply(reply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel }) {
    const threshold = settings.reformat_name_fuzzy_threshold ?? DEFAULT_NAME_FUZZY_THRESHOLD;

    const rawArray = _parseReformatArray(reply, chainIndex);
    const validatedForBatch = [];
    for (let j = 0; j < rawArray.length; j++) {
        const { ok, errors, chunk } = validateReformattedChunk(rawArray[j]);
        if (!ok) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: validation failed — ${errors.join('; ')} — skipped`);
            continue;
        }
        if (errors.length > 0) {
            log.warn(`[Auto-Reformat] ${batchLabel}, item ${j}: coercion warnings — ${errors.join('; ')}`);
        }
        validatedForBatch.push(chunk);
    }

    const verification = computeNameVerification(validatedForBatch, batch.text, threshold);
    const keywordVerification = computeKeywordVerification(validatedForBatch, batch.text);
    validatedForBatch.forEach((chunk, j) => {
        results.push({
            ...chunk,
            _nameGrounded: verification[j]?.nameGrounded ?? true,
            _ungroundedAliases: verification[j]?.ungroundedAliases ?? [],
            _ungroundedKeywords: keywordVerification[j]?.ungroundedKeywords ?? [],
        });
        alreadyExtractedNames.push(chunk.name);
    });
    return validatedForBatch.length;
}

/**
 * Processes one chain (a normal batch, or an ordered run of continuation
 * batches for one oversized section) sequentially, threading the running
 * "already extracted" name list into each continuation's prompt.
 *
 * After each batch, an under-extraction guardrail (computeBatchCoverage)
 * checks that the batch's distinctive facts actually landed in the extracted
 * records; flagged sections get ONE repair call (no loop) asking the model to
 * cover specifically what it dropped. Repair failures are non-fatal, same
 * policy as batch failures.
 */
async function _processChain(chain, settings, chainIndex, warnings, execution) {
    const results = [];
    let failedCount = 0;
    let repairCalls = 0;
    const alreadyExtractedNames = [];
    const repairEnabled = settings.reformat_enable_repair_pass !== false;
    const coverageThreshold = settings.reformat_coverage_threshold ?? DEFAULT_COVERAGE_THRESHOLD;

    for (let i = 0; i < chain.length; i++) {
        execution.check();
        const batch = chain[i];
        const batchLabel = chain.length > 1 ? `chain ${chainIndex} part ${i + 1}/${chain.length}` : `batch ${chainIndex}`;
        const batchContext = batch.continuation
            ? { sectionTitle: batch.continuation.sectionTitle, alreadyExtractedNames: [...alreadyExtractedNames] }
            : null;
        const prompt = buildReformatPrompt(batch.text, { customPrompt: settings.reformat_custom_prompt, batchContext });

        try {
            const { reply, finishReason } = await _callProviderWithRetry(prompt, settings, chainIndex, execution);
            if (finishReason === 'length') {
                warnings.push(`${batchLabel}: response was truncated by the model's output limit — some entries from this section may be missing. Consider lowering "Batch size (chars)" in Auto-Reformat settings.`);
            }

            _ingestReply(reply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel });
        } catch (err) {
            execution.check();
            if (err instanceof ReformatFatalError) throw err;
            failedCount++;
            warnings.push(`${batchLabel} failed: ${err?.message || err} — skipped, other batches continue.`);
            log.warn(`[Auto-Reformat] ${batchLabel} failed:`, err?.message || err);
            continue;
        }

        if (!repairEnabled) continue;
        const flagged = computeBatchCoverage(batch.text, results, coverageThreshold);
        if (flagged.length === 0) continue;

        const flaggedTitles = flagged.map(s => `"${s.title}"`).join(', ');
        log.lifecycle(`[Auto-Reformat] ${batchLabel}: ${flagged.length} under-captured section(s) (${flaggedTitles}) — issuing repair call`);
        try {
            const repairPrompt = buildRepairPrompt(flagged, {
                customPrompt: settings.reformat_custom_prompt,
                alreadyExtractedNames: [...alreadyExtractedNames],
            });
            const { reply: repairReply } = await _callProviderWithRetry(repairPrompt, settings, chainIndex, execution);
            repairCalls++;
            const added = _ingestReply(repairReply, batch, { results, alreadyExtractedNames, settings, chainIndex, batchLabel: `${batchLabel} (repair)` });
            log.lifecycle(`[Auto-Reformat] ${batchLabel}: repair call added ${added} record(s)`);

            const stillFlagged = computeBatchCoverage(batch.text, results, coverageThreshold);
            if (stillFlagged.length > 0) {
                warnings.push(`${batchLabel}: section(s) still under-captured after a repair pass: ${stillFlagged.map(s => `"${s.title}"`).join(', ')} — review these entries for missing detail.`);
            }
        } catch (err) {
            execution.check();
            if (err instanceof ReformatFatalError) throw err;
            warnings.push(`${batchLabel}: repair call for under-captured section(s) ${flaggedTitles} failed: ${err?.message || err} — the original extraction is kept.`);
            log.warn(`[Auto-Reformat] ${batchLabel} repair call failed:`, err?.message || err);
        }
    }

    return { results, failedCount, repairCalls };
}

// ---------------------------------------------------------------------------
// Duplicate-entity merge
// ---------------------------------------------------------------------------

/** Lowercased, trimmed match keys for one record: its name plus all aliases. */
function _entityKeys(record) {
    return [record?.name, ...(Array.isArray(record?.aliases) ? record.aliases : [])]
        .map(s => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
        .filter(Boolean);
}

/** Dedup key for a relationship; tolerates legacy plain-string entries. */
function _relationshipKey(rel) {
    if (typeof rel === 'string') return rel.trim().toLowerCase();
    return `${(rel?.target || '').trim().toLowerCase()}|${(rel?.type || '').trim().toLowerCase()}`;
}

/**
 * Lossless body merge: keeps the longer body as the primary prose, then
 * appends the other body's paragraphs (falling back to sentences for
 * single-paragraph bodies) whose normalized text isn't already contained in
 * the merged result. Complementary facts from two extractions of the same
 * entity both survive; near-duplicate prose is still dropped. Replaces the
 * old longest-body-wins policy, which silently discarded every fact that
 * only the shorter body carried.
 * @param {string} bodyA
 * @param {string} bodyB
 * @returns {string}
 */
function _mergeBodies(bodyA, bodyB) {
    const a = (bodyA || '').trim();
    const b = (bodyB || '').trim();
    if (!a) return b;
    if (!b) return a;

    const [primary, secondary] = b.length > a.length ? [b, a] : [a, b];

    let merged = primary;
    let mergedNorm = normalizeForMatch(merged);

    const paragraphs = secondary.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
        const fragments = paragraphs.length > 1
            ? [para]
            : para.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);
        const novel = fragments.filter(f => {
            const norm = normalizeForMatch(f);
            return norm && !mergedNorm.includes(norm);
        });
        if (novel.length === 0) continue;
        const addition = novel.join(' ');
        merged += '\n\n' + addition;
        mergedNorm += ' ' + normalizeForMatch(addition);
    }
    return merged;
}

/** Case-insensitive union of two string arrays, keeping first-seen casing. */
function _unionStrings(a, b) {
    const seen = new Set();
    const out = [];
    for (const s of [...a, ...b]) {
        const key = (typeof s === 'string' ? s : '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(s.trim());
    }
    return out;
}

/**
 * Merges duplicate entity records produced by independent parallel chains.
 * The per-chain "already extracted names" mechanism (_processChain) can't see
 * across chains, so an entity discussed in two document sections gets
 * extracted twice — e.g. one Fur Reich run produced IG Tatzen ×2 and Gestapo
 * ×3, each copy carrying a different (often empty) relationships list.
 *
 * Detection is deliberately conservative: exact case-insensitive match on
 * name/aliases, and only within the same entry_type (a location and a
 * character sharing a name must not merge). No fuzzy matching — a
 * false-positive merge silently destroys a record, while a false negative
 * just leaves today's status quo.
 *
 * Merge policy: union aliases/traits (case-insensitive), union keywords by
 * text keeping max importance, union relationships by target+type, first
 * non-empty affiliation. Bodies merge LOSSLESSLY via _mergeBodies — longer
 * body is primary, the other body's non-duplicate paragraphs/sentences are
 * appended (the old longest-wins policy silently discarded complementary
 * facts when two sections described the same entity from different angles).
 * Grounding flags: _nameGrounded ORs; _ungrounded* lists union.
 *
 * @param {object[]} chunks - Validated records (post _processChain), document order
 * @returns {object[]} Merged records, first-occurrence order
 */
export function mergeDuplicateEntities(chunks) {
    if (!Array.isArray(chunks) || chunks.length < 2) return Array.isArray(chunks) ? chunks : [];

    /** @type {Map<string, object>} `${entry_type}::${nameOrAlias}` → merged record */
    const byKey = new Map();
    const merged = [];

    for (const record of chunks) {
        const keys = _entityKeys(record).map(k => `${record?.entry_type || 'other'}::${k}`);
        const existing = keys.map(k => byKey.get(k)).find(Boolean);

        if (!existing) {
            const copy = { ...record };
            merged.push(copy);
            for (const k of keys) byKey.set(k, copy);
            continue;
        }

        // Absorb `record` into `existing` (first occurrence wins name/order).
        const incomingNames = record.name && record.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()
            ? [record.name]
            : [];
        existing.aliases = _unionStrings(existing.aliases || [], [...incomingNames, ...(record.aliases || [])])
            .filter(a => a.toLowerCase() !== existing.name.trim().toLowerCase());
        existing.traits = _unionStrings(existing.traits || [], record.traits || []);

        if (!existing.affiliation && record.affiliation) existing.affiliation = record.affiliation;
        existing.body = _mergeBodies(existing.body, record.body);

        const relSeen = new Set((existing.relationships || []).map(_relationshipKey));
        for (const rel of record.relationships || []) {
            const key = _relationshipKey(rel);
            if (!key || relSeen.has(key)) continue;
            relSeen.add(key);
            existing.relationships = [...(existing.relationships || []), rel];
        }

        const kwByText = new Map();
        for (const kw of [...(existing.keywords || []), ...(record.keywords || [])]) {
            const text = typeof kw === 'string' ? kw : kw?.text;
            if (!text) continue;
            const key = text.toLowerCase();
            const importance = typeof kw === 'object' ? kw?.importance ?? 5 : 5;
            const prev = kwByText.get(key);
            if (!prev || importance > (prev.importance ?? 5)) kwByText.set(key, { text, importance });
        }
        existing.keywords = [...kwByText.values()];

        existing._nameGrounded = Boolean(existing._nameGrounded) || Boolean(record._nameGrounded);
        existing._ungroundedAliases = _unionStrings(existing._ungroundedAliases || [], record._ungroundedAliases || []);
        existing._ungroundedKeywords = _unionStrings(existing._ungroundedKeywords || [], record._ungroundedKeywords || []);

        // The absorbed record's keys (incl. newly-gained aliases) now resolve here too.
        for (const k of keys) byKey.set(k, existing);
    }

    return merged;
}

// ---------------------------------------------------------------------------
// Optional cross-batch linking pass
// ---------------------------------------------------------------------------

/**
 * Second LLM pass (opt-in via settings.reformat_enable_linking_pass) that
 * backfills relationships the single-pass extraction structurally cannot see:
 * each extraction batch only knows its own text, so a connection between an
 * entity extracted in batch 2 and one extracted in batch 7 is invisible to
 * both calls. This pass re-reads each batch's text alongside a catalog of
 * EVERY merged entity in the document and asks only for {source, target, type}
 * triples between catalog entries.
 *
 * Hallucination guard: a triple is applied only when BOTH source and target
 * resolve (case-insensitive, name or alias) to a merged record — the model
 * cannot introduce entities, only connect existing ones. Mutates the records'
 * `relationships` in place (deduped by target+type). Per-batch failures are
 * non-fatal warnings, same policy as _processChain.
 *
 * @param {object} params
 * @param {Array<{text: string}>} params.batches - The SAME batches used for extraction
 * @param {object[]} params.records - Merged records (post mergeDuplicateEntities)
 * @param {object} params.settings
 * @param {string[]} params.warnings - Mutated: per-batch failure notes appended
 * @param {number} params.concurrency
 * @param {AbortSignal|null} params.abortSignal
 * @param {(() => void)|null} params.onTick - Called once per finished link batch (progress)
 * @returns {Promise<{applied: number, dropped: number}>}
 */
async function _runLinkingPass({ batches, records, settings, warnings, concurrency, execution, abortSignal = null, onTick = null }) {
    const catalog = records.map(r => ({ name: r.name, entry_type: r.entry_type, aliases: r.aliases || [] }));

    /** @type {Map<string, object>} lowercased name/alias → record (first registration wins) */
    const resolver = new Map();
    for (const r of records) {
        for (const key of _entityKeys(r)) {
            if (!resolver.has(key)) resolver.set(key, r);
        }
    }

    let applied = 0;
    let dropped = 0;

    const linkFns = batches.map((batch, i) => async () => {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        try {
            const prompt = buildLinkingPrompt(batch.text, catalog);
            const { reply } = await _callProviderWithRetry(prompt, settings, i, execution);
            const triples = _parseReformatArray(reply, i, ['source', 'target']);

            for (const t of triples) {
                const source = resolver.get(String((/** @type {any} */ (t))?.source || '').trim().toLowerCase());
                const target = resolver.get(String((/** @type {any} */ (t))?.target || '').trim().toLowerCase());
                if (!source || !target || source === target) {
                    dropped++;
                    continue;
                }
                // Canonicalize target to the resolved record's name so alias-form
                // triples don't create near-duplicate relationship entries.
                const rel = { target: target.name, type: String((/** @type {any} */ (t))?.type || '').trim() };
                const existingKeys = new Set((source.relationships || []).map(_relationshipKey));
                if (existingKeys.has(_relationshipKey(rel))) continue;
                source.relationships = [...(source.relationships || []), rel];
                applied++;
            }
        } catch (err) {
            execution.check();
            if (err instanceof ReformatFatalError || err?.name === 'AbortError') throw err;
            warnings.push(`Linking pass, batch ${i}: ${err?.message || err} — skipped, extraction results are unaffected.`);
            log.warn(`[Auto-Reformat] Linking pass batch ${i} failed:`, err?.message || err);
        }
        execution.check();
        onTick?.();
    });

    await execution.parallel(linkFns, concurrency);
    log.lifecycle(`[Auto-Reformat] Linking pass: ${applied} relationship(s) added, ${dropped} unresolvable triple(s) dropped`);
    return { applied, dropped };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Restructures source text into structured reformatted chunks.
 *
 * @param {object} params
 * @param {string} params.text - Full prepared source text (document/url, or
 *        wiki text with per_page strategy overridden away — see caller)
 * @param {string} params.contentType - 'document' | 'url' | 'wiki'
 * @param {object} params.settings - VectFox settings
 * @param {(processed: number, total: number, phase?: 'extract'|'link') => void} [params.onProgress]
 *        `total` is the count for the CURRENT phase — the linking pass (when
 *        enabled) re-visits every batch and reports its own 1..total sequence
 *        tagged 'link', rather than doubling a shared denominator.
 * @param {AbortSignal} [params.abortSignal]
 * @returns {Promise<{chunks: object[], warnings: string[], batchesProcessed: number, batchesFailed: number, totalBatches: number}>}
 */
export async function reformatDocument({ text, contentType, settings, onProgress = null, abortSignal = null } = {}) {
    const execution = createReformatExecution(abortSignal);
    execution.check();
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { chunks: [], warnings: ['No text to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const targetChars = settings.reformat_batch_chars || DEFAULT_BATCH_CHARS;
    const batches = await _buildBatches(text, targetChars);
    if (batches.length === 0) {
        return { chunks: [], warnings: ['No content found to reformat.'], batchesProcessed: 0, batchesFailed: 0, totalBatches: 0 };
    }

    const chains = _groupIntoChains(batches);
    const totalBatches = batches.length;
    const warnings = [];
    let batchesProcessed = 0;
    let batchesFailed = 0;
    let totalRepairCalls = 0;

    const concurrency = Math.max(1, Math.min(8, settings.reformat_concurrency || DEFAULT_CONCURRENCY));
    const linkingEnabled = Boolean(settings.reformat_enable_linking_pass);

    log.lifecycle(`[Auto-Reformat] Starting: ${contentType}, ${totalBatches} batch(es) in ${chains.length} chain(s), concurrency=${concurrency}${linkingEnabled ? ', linking pass enabled' : ''}`);

    const chainFns = chains.map((chain, chainIndex) => async () => {
        if (abortSignal?.aborted) {
            const err = new Error('Auto-Reformat stopped by user');
            err.name = 'AbortError';
            throw err;
        }
        const { results, failedCount, repairCalls } = await _processChain(chain, settings, chainIndex, warnings, execution);
        execution.check();
        batchesProcessed += chain.length;
        batchesFailed += failedCount;
        totalRepairCalls += repairCalls;
        onProgress?.(batchesProcessed, totalBatches, 'extract');
        return results;
    });

    const chainResultsArrays = await execution.parallel(chainFns, concurrency);
    const rawChunks = chainResultsArrays.flat();

    // Chains run in parallel with no cross-chain visibility, so the same entity
    // can be extracted once per section that discusses it — merge those here so
    // the review UI (and the linking pass below) see one record per entity.
    const chunks = mergeDuplicateEntities(rawChunks);
    if (chunks.length < rawChunks.length) {
        warnings.push(`Merged ${rawChunks.length - chunks.length} duplicate entries (${rawChunks.length} → ${chunks.length} records) — the same entity was extracted from multiple document sections.`);
    }

    if (linkingEnabled && chunks.length > 0) {
        let linkBatchesDone = 0;
        await _runLinkingPass({
            batches,
            records: chunks,
            settings,
            warnings,
            concurrency,
            abortSignal,
            execution,
            onTick: () => {
                linkBatchesDone++;
                onProgress?.(linkBatchesDone, totalBatches, 'link');
            },
        });
    }

    log.lifecycle(`[Auto-Reformat] Complete: ${chunks.length} entries extracted from ${totalBatches} batch(es), ${totalRepairCalls} coverage repair call(s), ${batchesFailed} batch failure(s), ${warnings.length} warning(s)`);

    execution.check();
    return { chunks, warnings, batchesProcessed, batchesFailed, totalBatches };
}

// ---------------------------------------------------------------------------
// Oversized-entity fallback (used at Accept time by ui/reformat-review.js)
// ---------------------------------------------------------------------------

/**
 * If an accepted record's body exceeds maxBodyChars, sub-chunks it with the
 * EXISTING adaptive splitter (no new splitting logic) into N physical chunks
 * that all carry the parent record's metadata plus subChunkIndex/subChunkTotal.
 * Returns [chunk] unchanged when no expansion is needed.
 *
 * @param {object} chunk - A validated reformatted chunk (post-review, accepted)
 * @param {number} maxBodyChars
 * @returns {Promise<object[]>}
 */
export async function expandOversizedChunk(chunk, maxBodyChars) {
    if (!chunk?.body || chunk.body.length <= maxBodyChars) {
        return [chunk];
    }
    const subChunks = await chunkText(chunk.body, { strategy: 'adaptive', chunkSize: maxBodyChars });
    const total = subChunks.length;
    return subChunks.map((sc, i) => ({
        ...chunk,
        body: typeof sc === 'string' ? sc : sc.text,
        subChunkIndex: i,
        subChunkTotal: total,
    }));
}

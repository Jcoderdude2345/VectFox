/**
 * Characterization tests for core/prompts-i18n.js
 *
 * Locks in the prompt-selection contract (six language modes, intl fallback,
 * placeholder survival) and the planner user-message builder's exact layout.
 * Assertions deliberately target structure and invariants rather than whole
 * prompt bodies, so ordinary copy edits don't break the suite but a change in
 * WHICH prompt is served, or in the builder's format, does.
 *
 * Pure module — no mocking required.
 */

import { describe, it, expect } from 'vitest';
import {
    getAgenticPlannerPrompt,
    getDefaultSummarizePrompt,
    getEventBaseExtractionPrompt,
    buildPlannerUserMessage,
} from '../core/prompts-i18n.js';

const MODES = ['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'];
const GETTERS = {
    planner: getAgenticPlannerPrompt,
    summarize: getDefaultSummarizePrompt,
    extraction: getEventBaseExtractionPrompt,
};

// ---------------------------------------------------------------------------
// Mode resolution — shared across all three prompt families
// ---------------------------------------------------------------------------

describe('prompt mode resolution', () => {
    for (const [name, getter] of Object.entries(GETTERS)) {
        describe(`${name} prompts`, () => {
            it('serves a distinct non-empty prompt for each of the six modes', () => {
                const seen = MODES.map(m => getter(m));
                expect(seen.every(p => typeof p === 'string' && p.length > 0)).toBe(true);
                expect(new Set(seen).size).toBe(MODES.length);
            });

            it('falls back to intl for unknown, empty, null and undefined modes', () => {
                const intl = getter('intl');
                expect(getter('klingon')).toBe(intl);
                expect(getter('')).toBe(intl);
                expect(getter(null)).toBe(intl);
                expect(getter(undefined)).toBe(intl);
                expect(getter()).toBe(intl);
            });

            it('does NOT fall back for prototype-chain keys — they resolve to undefined... no, ?? keeps intl', () => {
                // `_PROMPTS[mode] ?? _PROMPTS.intl` — 'toString' resolves to
                // Object.prototype.toString (a function, not nullish), so the
                // fallback is skipped and a FUNCTION is returned instead of a
                // prompt string. Latent bug; unreachable from the settings UI.
                expect(typeof getter('toString')).toBe('function');
                expect(typeof getter('constructor')).toBe('function');
            });

            it('returns the identical string instance on repeated calls (module constants, not rebuilt)', () => {
                expect(getter('jieba')).toBe(getter('jieba'));
            });
        });
    }
});

// ---------------------------------------------------------------------------
// Planner prompts
// ---------------------------------------------------------------------------

describe('getAgenticPlannerPrompt', () => {
    it('shares the same structural header and footer across every language', () => {
        for (const mode of MODES) {
            const p = getAgenticPlannerPrompt(mode);
            expect(p).toContain('You are a retrieval planner for a roleplay memory system.');
            expect(p).toContain('══ FILTER RULES ═');
            expect(p).toContain('══ QUESTION TYPE GUIDE ═');
            expect(p.endsWith('Return ONLY the JSON object. No commentary, no markdown fences, no preamble.')).toBe(true);
        }
    });

    it('documents exactly the filter keys the validator accepts', () => {
        const p = getAgenticPlannerPrompt('intl');
        for (const key of ['characters_any', 'locations_any', 'factions_any',
            'items_any', 'concepts_any', 'event_type_any', 'importance_gte']) {
            expect(p).toContain(key);
        }
    });

    it('carries language-specific example blocks in the target script', () => {
        expect(getAgenticPlannerPrompt('jieba')).toContain('语言规则');
        expect(getAgenticPlannerPrompt('jieba_tw')).toContain('語言規則');
        expect(getAgenticPlannerPrompt('tiny_segmenter')).toContain('言語ルール');
        expect(getAgenticPlannerPrompt('korean')).toContain('언어 규칙');
        expect(getAgenticPlannerPrompt('others')).toContain('Detect the story language from the chat.');
    });

    it('contains no {{text}} placeholder — it is a system prompt, sent verbatim', () => {
        for (const mode of MODES) {
            expect(getAgenticPlannerPrompt(mode)).not.toContain('{{text}}');
        }
    });
});

// ---------------------------------------------------------------------------
// Summarize prompts
// ---------------------------------------------------------------------------

describe('getDefaultSummarizePrompt', () => {
    it('ends with the {{text}} slot that summarizeText() substitutes', () => {
        for (const mode of MODES) {
            const p = getDefaultSummarizePrompt(mode);
            expect(p).toContain('{{text}}');
            expect(p.endsWith('{{text}}')).toBe(true);
        }
    });

    it('exposes exactly one {{text}} slot (String.replace only swaps the first)', () => {
        for (const mode of MODES) {
            expect(getDefaultSummarizePrompt(mode).match(/\{\{text\}\}/g)).toHaveLength(1);
        }
    });

    it('pins each variant to its output language', () => {
        expect(getDefaultSummarizePrompt('intl')).toContain('Write in English');
        expect(getDefaultSummarizePrompt('jieba')).toContain('以简体中文撰写');
        expect(getDefaultSummarizePrompt('jieba_tw')).toContain('以繁體中文撰寫');
        expect(getDefaultSummarizePrompt('tiny_segmenter')).toContain('日本語で記述する');
        expect(getDefaultSummarizePrompt('korean')).toContain('한국어로 작성하세요');
        // 'others' is English-bodied but instructs language mirroring.
        expect(getDefaultSummarizePrompt('others')).toContain('Write in the same language as the story excerpt');
    });
});

// ---------------------------------------------------------------------------
// EventBase extraction prompts
// ---------------------------------------------------------------------------

describe('getEventBaseExtractionPrompt', () => {
    it('leaves BOTH {{text}} and {{maxCount}} unsubstituted for buildExtractionPrompt()', () => {
        for (const mode of MODES) {
            const p = getEventBaseExtractionPrompt(mode);
            expect(p).toContain('{{text}}');
            expect(p).toContain('{{maxCount}}');
        }
    });

    it('ends with the EXCERPT block so the chat text lands last in the prompt', () => {
        for (const mode of MODES) {
            expect(getEventBaseExtractionPrompt(mode).endsWith('EXCERPT\n=========================\n{{text}}')).toBe(true);
        }
    });

    it('shares the schema body (event types, importance guide) across all languages', () => {
        for (const mode of MODES) {
            const p = getEventBaseExtractionPrompt(mode);
            expect(p).toContain('OUTPUT SCHEMA');
            expect(p).toContain('promise_or_oath');
            expect(p).toContain('should_persist');
            expect(p).toContain('THE ONE-WEEK TEST');
        }
    });

    it('embeds a worked JSON example that itself parses as a one-event array', () => {
        for (const mode of MODES) {
            const p = getEventBaseExtractionPrompt(mode);
            const match = p.match(/^\[\{"event_type".*\}\]$/m);
            expect(match, `no example array found for mode ${mode}`).not.toBeNull();
            const parsed = JSON.parse(match[0]);
            expect(parsed).toHaveLength(1);
            expect(parsed[0]).toHaveProperty('event_type');
            expect(parsed[0]).toHaveProperty('should_persist');
        }
    });

    it('reuses the English example verbatim for the "others" variant', () => {
        const intlExample = getEventBaseExtractionPrompt('intl').match(/^\[\{"event_type".*\}\]$/m)[0];
        const othersExample = getEventBaseExtractionPrompt('others').match(/^\[\{"event_type".*\}\]$/m)[0];
        expect(othersExample).toBe(intlExample);
    });
});

// ---------------------------------------------------------------------------
// buildPlannerUserMessage
// ---------------------------------------------------------------------------

describe('buildPlannerUserMessage', () => {
    it('renders recent turns newest-last with negative-depth labels', () => {
        const out = buildPlannerUserMessage({
            recentTurns: [
                { speaker: '{{user}}', text: 'first' },
                { speaker: 'Aria', text: 'second' },
                { speaker: '{{user}}', text: 'third' },
            ],
            userMessage: 'what happened at the docks?',
            candidates: [],
        });

        expect(out).toContain('  [-3] {{user}}: first');
        expect(out).toContain('  [-2] Aria: second');
        expect(out).toContain('  [-1] {{user}}: third');
        expect(out).toContain('Current user message:\n  what happened at the docks?');
        expect(out.endsWith('Plan retrieval. Return strict JSON only.')).toBe(true);
    });

    it('emits placeholder lines for empty chat and empty candidates', () => {
        const out = buildPlannerUserMessage({ recentTurns: [], userMessage: 'hi', candidates: [] });
        expect(out).toContain('  (no recent context — start of conversation)');
        expect(out).toContain('  (none — DB returned no semantic matches)');
    });

    it('treats missing/undefined arguments the same as empty ones', () => {
        const out = buildPlannerUserMessage({});
        expect(out).toContain('  (no recent context — start of conversation)');
        expect(out).toContain('Current user message:\n  (empty)');
        expect(out).toContain('  (none — DB returned no semantic matches)');
    });

    it('renders an empty-string user message as "(empty)"', () => {
        expect(buildPlannerUserMessage({ userMessage: '' })).toContain('  (empty)');
    });

    it('derives a speaker from is_user when turn.speaker is absent', () => {
        const out = buildPlannerUserMessage({
            recentTurns: [{ is_user: true, text: 'u' }, { is_user: false, text: 'c' }],
            userMessage: 'q',
            candidates: [],
        });
        expect(out).toContain('[-2] {{user}}: u');
        expect(out).toContain('[-1] {{character}}: c');
    });

    it('soft-trims each turn to 600 chars and appends an ellipsis', () => {
        const long = 'x'.repeat(700);
        const out = buildPlannerUserMessage({
            recentTurns: [{ speaker: 'A', text: long }],
            userMessage: 'q',
            candidates: [],
        });
        expect(out).toContain(`[-1] A: ${'x'.repeat(600)}...`);
        expect(out).not.toContain('x'.repeat(601));
    });

    it('does NOT trim the current user message — it goes in verbatim', () => {
        const long = 'y'.repeat(5000);
        const out = buildPlannerUserMessage({ recentTurns: [], userMessage: long, candidates: [] });
        expect(out).toContain(long);
    });

    it('formats candidates as E<n> lines with score, type, collapsed text and metadata', () => {
        const out = buildPlannerUserMessage({
            recentTurns: [],
            userMessage: 'q',
            candidates: [{
                score: 0.87654,
                event_type: 'betrayal',
                text: 'The   captain\n\nturned on the crew.',
                characters: ['Aria', 'Leon'],
                concepts: ['trust', 'betrayal'],
                importance: 9,
            }],
        });
        expect(out).toContain('  E1 [0.88] betrayal — The captain turned on the crew.');
        expect(out).toContain('      chars: [Aria, Leon] | concepts: [trust, betrayal] | importance: 9');
    });

    it('falls back to vectorScore, then an em-dash, for the score column', () => {
        const out = buildPlannerUserMessage({
            candidates: [
                { vectorScore: 0.5, text: 'a' },
                { text: 'b' },
            ],
        });
        expect(out).toContain('E1 [0.50] event — a');
        expect(out).toContain('E2 [—] event — b');
    });

    it('reads candidate fields from .metadata when the top level lacks them', () => {
        const out = buildPlannerUserMessage({
            candidates: [{
                metadata: {
                    event_type: 'revelation',
                    text: 'hidden truth',
                    characters: ['Voss'],
                    concepts: ['secrecy'],
                    importance: 8,
                },
            }],
        });
        expect(out).toContain('E1 [—] revelation — hidden truth');
        expect(out).toContain('chars: [Voss] | concepts: [secrecy] | importance: 8');
    });

    it('truncates candidate text at 90 chars WITHOUT an ellipsis', () => {
        // Asymmetric with the recent-turn trim above, which does add "...".
        const out = buildPlannerUserMessage({ candidates: [{ text: 'z'.repeat(200) }] });
        expect(out).toContain(`event — ${'z'.repeat(90)}\n`);
        expect(out).not.toContain('z'.repeat(91));
    });

    it('caps characters and concepts at 4 entries each, silently dropping the rest', () => {
        const out = buildPlannerUserMessage({
            candidates: [{
                text: 't',
                characters: ['c1', 'c2', 'c3', 'c4', 'c5'],
                concepts: ['k1', 'k2', 'k3', 'k4', 'k5'],
            }],
        });
        expect(out).toContain('chars: [c1, c2, c3, c4]');
        expect(out).not.toContain('c5');
        expect(out).not.toContain('k5');
    });

    it('shows "importance: ?" and omits empty chars/concepts segments', () => {
        const out = buildPlannerUserMessage({ candidates: [{ text: 'plain' }] });
        expect(out).toContain('      importance: ?');
        expect(out).not.toContain('chars: []');
        expect(out).not.toContain('concepts: []');
    });

    it('treats importance 0 as a real value (?? not ||)', () => {
        const out = buildPlannerUserMessage({ candidates: [{ text: 't', importance: 0 }] });
        expect(out).toContain('importance: 0');
    });
});

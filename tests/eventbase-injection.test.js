/**
 * Characterization tests for core/eventbase-injection.js
 *
 * formatEventsForInjectionDetailed() turns re-ranked EventRecord objects into
 * the prompt block that actually reaches the LLM, so its exact output shape is
 * load-bearing. These tests pin the three formats (densetext / summaryonly /
 * json), the summary-line extraction from the stored embed text, and the
 * internal-field stripping.
 *
 * Pure module — no mocking required.
 */

import { describe, it, expect } from 'vitest';
import { formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A realistic stored event: `text` is what buildEmbedText() produced. */
function makeEvent(overrides = {}) {
    return {
        event_type: 'promise_or_oath',
        importance: 9,
        text: '[promise_or_oath] Aria swears to find Leon\'s missing sister.\ncause: Leon broke down at the shrine.',
        cause: 'Leon broke down at the shrine.',
        result: 'Finding the sister becomes the party goal.',
        DateTime: '2024-05-01T20:30:00Z',
        characters: ['Aria', 'Leon'],
        locations: ['Moonlit Shrine'],
        factions: ['Iron Company'],
        items: [],
        concepts: ['oath', 'family'],
        keywords: ['swear', 'sister', 'missing'],
        open_threads: ['Is the sister still alive?'],
        should_persist: true,
        source_window_end: 42,
        // Internal scoring/ingestion fields that must NOT be injected:
        event_id: 'eb_1700000000000_10_0_ab12x',
        _finalScore: 0.913,
        _hash: 123456,
        source_message_hashes: [1, 2, 3],
        schema_version: 1,
        created_at: 1700000000000,
        ...overrides,
    };
}

const densetext = { eventbase_injection_format: 'densetext' };
const summaryonly = { eventbase_injection_format: 'summaryonly' };
const json = { eventbase_injection_format: 'json' };

// ---------------------------------------------------------------------------
// Empty / guard behavior
// ---------------------------------------------------------------------------

describe('empty input', () => {
    it('returns an empty result object for null, undefined and []', () => {
        const empty = { text: '', includedCount: 0, requestedCount: 0 };
        expect(formatEventsForInjectionDetailed(null, densetext)).toEqual(empty);
        expect(formatEventsForInjectionDetailed(undefined, densetext)).toEqual(empty);
        expect(formatEventsForInjectionDetailed([], densetext)).toEqual(empty);
    });

    it('short-circuits before reading settings, so settings may be missing entirely', () => {
        expect(formatEventsForInjectionDetailed([])).toEqual({ text: '', includedCount: 0, requestedCount: 0 });
    });
});

// ---------------------------------------------------------------------------
// Format selection
// ---------------------------------------------------------------------------

describe('format selection', () => {
    const events = [makeEvent()];

    it('defaults to densetext when no format is configured', () => {
        expect(formatEventsForInjectionDetailed(events, {}).text)
            .toBe(formatEventsForInjectionDetailed(events, densetext).text);
        expect(formatEventsForInjectionDetailed(events, undefined).text)
            .toBe(formatEventsForInjectionDetailed(events, densetext).text);
    });

    it('is case-insensitive about the configured format', () => {
        expect(formatEventsForInjectionDetailed(events, { eventbase_injection_format: 'DenseText' }).text)
            .toBe(formatEventsForInjectionDetailed(events, densetext).text);
        expect(formatEventsForInjectionDetailed(events, { eventbase_injection_format: 'SUMMARYONLY' }).text)
            .toBe(formatEventsForInjectionDetailed(events, summaryonly).text);
    });

    it('treats ANY unrecognised format as JSON — there is no validation or warning', () => {
        const jsonText = formatEventsForInjectionDetailed(events, json).text;
        expect(formatEventsForInjectionDetailed(events, { eventbase_injection_format: 'yaml' }).text).toBe(jsonText);
        expect(formatEventsForInjectionDetailed(events, { eventbase_injection_format: 'xml' }).text).toBe(jsonText);
        expect(formatEventsForInjectionDetailed(events, { eventbase_injection_format: '' }).text)
            .toBe(formatEventsForInjectionDetailed(events, densetext).text); // '' is falsy → default
    });

    it('always reports includedCount === requestedCount === events.length (no budget trimming)', () => {
        const many = Array.from({ length: 25 }, (_, i) => makeEvent({ importance: i }));
        for (const settings of [densetext, summaryonly, json]) {
            const out = formatEventsForInjectionDetailed(many, settings);
            expect(out.includedCount).toBe(25);
            expect(out.requestedCount).toBe(25);
        }
    });
});

// ---------------------------------------------------------------------------
// Summary extraction from embed text
// ---------------------------------------------------------------------------

describe('summary extraction from the stored embed text', () => {
    const summaryOf = (text) =>
        formatEventsForInjectionDetailed([makeEvent({ text })], summaryonly).text
            .split('\n').find(l => l.startsWith('summary: ')).slice('summary: '.length);

    it('strips the leading [event_type] tag from the first line', () => {
        expect(summaryOf('[combat] The bridge collapses.\nmore lines')).toBe('The bridge collapses.');
    });

    it('uses the whole first line when there is no bracketed prefix', () => {
        expect(summaryOf('No tag here.\nsecond line')).toBe('No tag here.');
    });

    it('ignores everything after the first newline', () => {
        expect(summaryOf('[travel] Line one.\nLine two.\nLine three.')).toBe('Line one.');
    });

    it('renders "-" when text is empty or missing', () => {
        expect(summaryOf('')).toBe('-');
        expect(summaryOf(undefined)).toBe('-');
        expect(summaryOf(null)).toBe('-');
    });

    it('strips only the FIRST bracket group, keeping later ones', () => {
        expect(summaryOf('[combat] [night] Ambush at the ford.')).toBe('[night] Ambush at the ford.');
    });

    it('yields an empty summary (rendered "-") when the line is only a tag', () => {
        expect(summaryOf('[combat]')).toBe('-');
        expect(summaryOf('[combat] ')).toBe('-');
    });

    it('does NOT read event.summary — only event.text is consulted', () => {
        // A caller-supplied `summary` field is silently ignored; the summary
        // must be embedded in `text` for injection to see it.
        const ev = makeEvent({ text: '[combat] from text', summary: 'from summary field' });
        const out = formatEventsForInjectionDetailed([ev], summaryonly).text;
        expect(out).toContain('summary: from text');
        expect(out).not.toContain('from summary field');
    });

    it('coerces a non-string text value instead of throwing', () => {
        expect(summaryOf(12345)).toBe('12345');
    });
});

// ---------------------------------------------------------------------------
// Dense text format
// ---------------------------------------------------------------------------

describe('densetext format', () => {
    it('emits the full canonical field block in a fixed order', () => {
        const out = formatEventsForInjectionDetailed([makeEvent()], densetext).text;
        expect(out).toBe([
            '# Event 1',
            'event_type: promise_or_oath',
            'importance: 9',
            'message_order: 42',
            "summary: Aria swears to find Leon's missing sister.",
            'DateTime: 2024-05-01T20:30:00Z',
            'cause: Leon broke down at the shrine.',
            'result: Finding the sister becomes the party goal.',
            'characters: Aria, Leon',
            'locations: Moonlit Shrine',
            'factions: Iron Company',
            'items: -',
            'concepts: oath, family',
            'keywords: swear, sister, missing',
            'open_threads: Is the sister still alive?',
            'should_persist: true',
        ].join('\n'));
    });

    it('numbers events from 1 and separates them with a blank line', () => {
        const out = formatEventsForInjectionDetailed(
            [makeEvent(), makeEvent({ event_type: 'combat' })],
            densetext,
        ).text;
        expect(out).toContain('# Event 1');
        expect(out).toContain('# Event 2');
        expect(out.split('\n\n')).toHaveLength(2);
    });

    it('strips internal scoring and ingestion fields', () => {
        const out = formatEventsForInjectionDetailed([makeEvent()], densetext).text;
        for (const leak of ['event_id', '_finalScore', '_hash', 'source_message_hashes',
            'schema_version', 'created_at', 'eb_1700000000000']) {
            expect(out).not.toContain(leak);
        }
    });

    it('renders empty arrays and empty strings as "-"', () => {
        const out = formatEventsForInjectionDetailed([makeEvent({
            cause: '', result: '', characters: [], locations: [], factions: [],
            items: [], concepts: [], keywords: [], open_threads: [],
        })], densetext).text;
        expect(out).toContain('cause: -');
        expect(out).toContain('characters: -');
        expect(out).toContain('open_threads: -');
    });

    it('renders a missing DateTime as "-"', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ DateTime: null })], densetext).text)
            .toContain('DateTime: -');
        expect(formatEventsForInjectionDetailed([makeEvent({ DateTime: undefined })], densetext).text)
            .toContain('DateTime: -');
    });

    it('maps message_order from source_window_end, showing "-" when absent', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ source_window_end: 0 })], densetext).text)
            .toContain('message_order: 0');
        expect(formatEventsForInjectionDetailed([makeEvent({ source_window_end: undefined })], densetext).text)
            .toContain('message_order: -');
    });

    it('renders importance 0 as 0 but a missing importance as "-"', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ importance: 0 })], densetext).text)
            .toContain('importance: 0');
        expect(formatEventsForInjectionDetailed([makeEvent({ importance: undefined })], densetext).text)
            .toContain('importance: -');
    });

    it('treats should_persist as strictly boolean-true — truthy strings become false', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ should_persist: 'true' })], densetext).text)
            .toContain('should_persist: false');
        expect(formatEventsForInjectionDetailed([makeEvent({ should_persist: 1 })], densetext).text)
            .toContain('should_persist: false');
        expect(formatEventsForInjectionDetailed([makeEvent({ should_persist: true })], densetext).text)
            .toContain('should_persist: true');
    });

    it('renders a non-array list field as "-" rather than stringifying it', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ characters: 'Aria' })], densetext).text)
            .toContain('characters: -');
    });

    it('coerces non-string list members via String()', () => {
        expect(formatEventsForInjectionDetailed([makeEvent({ items: [1, null, { a: 1 }] })], densetext).text)
            .toContain('items: 1, null, [object Object]');
    });

    it('does not escape newlines inside cause/result — they break the field-per-line layout', () => {
        // BUG-SHAPED: a multi-line cause injects raw newlines into what the
        // prompt presents as a flat key: value block.
        const out = formatEventsForInjectionDetailed([makeEvent({ cause: 'line one\nline two' })], densetext).text;
        expect(out).toContain('cause: line one\nline two');
    });
});

// ---------------------------------------------------------------------------
// Summary-only format
// ---------------------------------------------------------------------------

describe('summaryonly format', () => {
    it('emits only message_order, summary and DateTime', () => {
        const out = formatEventsForInjectionDetailed([makeEvent()], summaryonly).text;
        expect(out).toBe([
            '# Event 1',
            'message_order: 42',
            "summary: Aria swears to find Leon's missing sister.",
            'DateTime: 2024-05-01T20:30:00Z',
        ].join('\n'));
    });

    it('omits event_type, importance and all entity lists', () => {
        const out = formatEventsForInjectionDetailed([makeEvent()], summaryonly).text;
        for (const field of ['event_type:', 'importance:', 'characters:', 'concepts:',
            'keywords:', 'cause:', 'result:', 'should_persist:']) {
            expect(out).not.toContain(field);
        }
    });

    it('numbers multiple events and separates them with a blank line', () => {
        const out = formatEventsForInjectionDetailed([makeEvent(), makeEvent()], summaryonly).text;
        expect(out.split('\n\n')).toHaveLength(2);
        expect(out).toContain('# Event 2');
    });
});

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

describe('json format', () => {
    it('emits a 2-space-indented array of cleaned events', () => {
        const out = formatEventsForInjectionDetailed([makeEvent()], json).text;
        expect(out.startsWith('[\n  {\n')).toBe(true);
        expect(JSON.parse(out)).toEqual([{
            event_type: 'promise_or_oath',
            importance: 9,
            message_order: 42,
            summary: "Aria swears to find Leon's missing sister.",
            DateTime: '2024-05-01T20:30:00Z',
            cause: 'Leon broke down at the shrine.',
            result: 'Finding the sister becomes the party goal.',
            characters: ['Aria', 'Leon'],
            locations: ['Moonlit Shrine'],
            factions: ['Iron Company'],
            items: [],
            concepts: ['oath', 'family'],
            keywords: ['swear', 'sister', 'missing'],
            open_threads: ['Is the sister still alive?'],
            should_persist: true,
        }]);
    });

    it('emits exactly the 15 canonical keys, in a fixed order', () => {
        const [obj] = JSON.parse(formatEventsForInjectionDetailed([makeEvent()], json).text);
        expect(Object.keys(obj)).toEqual([
            'event_type', 'importance', 'message_order', 'summary', 'DateTime',
            'cause', 'result', 'characters', 'locations', 'factions', 'items',
            'concepts', 'keywords', 'open_threads', 'should_persist',
        ]);
    });

    it('keeps empty arrays and empty strings as-is (no "-" substitution)', () => {
        const [obj] = JSON.parse(formatEventsForInjectionDetailed(
            [makeEvent({ cause: '', characters: [] })], json,
        ).text);
        expect(obj.cause).toBe('');
        expect(obj.characters).toEqual([]);
    });

    it('preserves a non-array list field verbatim, unlike densetext', () => {
        // json passes the raw value through; densetext would print "-".
        const [obj] = JSON.parse(formatEventsForInjectionDetailed(
            [makeEvent({ characters: 'Aria' })], json,
        ).text);
        expect(obj.characters).toBe('Aria');
    });

    it('nulls message_order and DateTime when absent', () => {
        const [obj] = JSON.parse(formatEventsForInjectionDetailed(
            [makeEvent({ source_window_end: undefined, DateTime: undefined })], json,
        ).text);
        expect(obj.message_order).toBeNull();
        expect(obj.DateTime).toBeNull();
    });

    it('leaves undefined importance out of the JSON entirely (JSON.stringify drops it)', () => {
        const [obj] = JSON.parse(formatEventsForInjectionDetailed(
            [makeEvent({ importance: undefined })], json,
        ).text);
        expect('importance' in obj).toBe(false);
    });

    it('strips internal fields just like densetext', () => {
        const [obj] = JSON.parse(formatEventsForInjectionDetailed([makeEvent()], json).text);
        for (const leak of ['event_id', '_finalScore', '_hash', 'schema_version', 'created_at']) {
            expect(obj).not.toHaveProperty(leak);
        }
    });
});

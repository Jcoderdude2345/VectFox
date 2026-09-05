/**
 * Characterization tests for core/chunking.js
 *
 * These lock in what the chunking strategies do TODAY, including the rough
 * edges. Where behavior looks like a bug it is called out in a comment and
 * asserted anyway — the point is to detect change, not to bless the design.
 *
 * Pure module (only imports constants.js) — no mocking required.
 */

import { describe, it, expect } from 'vitest';
import {
    chunkText,
    getAvailableStrategies,
    isUnitStrategy,
    getChatStrategies,
} from '../core/chunking.js';
import { DEFAULT_CHUNK_SIZE } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const msg = (mes, extra = {}) => ({ mes, ...extra });

// ---------------------------------------------------------------------------
// chunkText() entry point / input guards
// ---------------------------------------------------------------------------

describe('chunkText input guards', () => {
    it('returns [] for every falsy input', async () => {
        expect(await chunkText('')).toEqual([]);
        expect(await chunkText(null)).toEqual([]);
        expect(await chunkText(undefined)).toEqual([]);
        expect(await chunkText(0)).toEqual([]);
        expect(await chunkText(false)).toEqual([]);
    });

    it('returns [] for truthy non-string/array/object input (numbers, booleans)', async () => {
        expect(await chunkText(42)).toEqual([]);
        expect(await chunkText(true)).toEqual([]);
    });

    it('falls back to the adaptive strategy for an unknown strategy id, but still reports the requested id in metadata', async () => {
        const out = await chunkText('Hello world.', { strategy: 'no_such_strategy' });
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('Hello world.');
        // The metadata records what the caller ASKED for, not what actually ran.
        expect(out[0].metadata.strategy).toBe('no_such_strategy');
    });

    it('stamps chunkIndex / totalChunks / strategy onto every chunk', async () => {
        const out = await chunkText('A'.repeat(60) + '\n\n' + 'B'.repeat(60), {
            strategy: 'paragraph',
        });
        expect(out).toHaveLength(2);
        expect(out.map(c => c.metadata.chunkIndex)).toEqual([0, 1]);
        expect(out.every(c => c.metadata.totalChunks === 2)).toBe(true);
        expect(out.every(c => c.metadata.strategy === 'paragraph')).toBe(true);
    });

    it('lets a strategy-supplied metadata.strategy overwrite the top-level one', async () => {
        // conversation_turns / message_batch both set metadata.strategy themselves,
        // and the spread in chunkText puts them AFTER the top-level assignment.
        // Harmless here (same value) but it means strategy metadata is not
        // guaranteed to be the requested id.
        const out = await chunkText([msg('hi', { is_user: true }), msg('yo', { name: 'Bot' })], {
            strategy: 'conversation_turns',
        });
        expect(out[0].metadata.strategy).toBe('conversation_turns');
    });
});

// ---------------------------------------------------------------------------
// Chat strategies
// ---------------------------------------------------------------------------

describe('per_message strategy', () => {
    it('makes one chunk per message with speaker/isUser/messageId metadata', async () => {
        const messages = [
            { mes: 'Where are we going?', is_user: true, index: 0 },
            { mes: 'North, past the ridge.', name: 'Aria', index: 1 },
        ];
        const out = await chunkText(messages, { strategy: 'per_message' });

        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({
            text: 'Where are we going?',
            metadata: { speaker: 'User', isUser: true, messageId: 0 },
        });
        expect(out[1]).toMatchObject({
            text: 'North, past the ridge.',
            metadata: { speaker: 'Aria', isUser: false, messageId: 1 },
        });
    });

    it('prefers .text over .mes and falls back to empty string', async () => {
        const out = await chunkText(
            [{ text: 'from text', mes: 'from mes' }, { name: 'Ghost' }],
            { strategy: 'per_message' },
        );
        expect(out[0].text).toBe('from text');
        expect(out[1].text).toBe('');
        expect(out[1].metadata.speaker).toBe('Ghost');
    });

    it('resolves messageId through index -> id -> send_date', async () => {
        const out = await chunkText(
            [
                { mes: 'a', index: 7, id: 99, send_date: 123 },
                { mes: 'b', id: 99, send_date: 123 },
                { mes: 'c', send_date: 123 },
                { mes: 'd' },
            ],
            { strategy: 'per_message' },
        );
        expect(out.map(c => c.metadata.messageId)).toEqual([7, 99, 123, undefined]);
    });

    it('treats index 0 as a real id (?? not ||), so message 0 keeps its index', async () => {
        const out = await chunkText([{ mes: 'first', index: 0, id: 55 }], { strategy: 'per_message' });
        expect(out[0].metadata.messageId).toBe(0);
    });

    it('labels string messages as "Character" and gives them no messageId', async () => {
        const out = await chunkText(['bare string'], { strategy: 'per_message' });
        expect(out[0].text).toBe('bare string');
        expect(out[0].metadata.speaker).toBe('Character');
        expect(out[0].metadata.messageId).toBeUndefined();
    });

    it('wraps a non-array input into a single chunk with NO speaker metadata', async () => {
        // The non-array branch returns a bare string, so the metadata spread
        // contributes nothing — such a chunk has no speaker/isUser/messageId.
        const out = await chunkText({ mes: 'lonely message' }, { strategy: 'per_message' });
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('lonely message');
        expect(out[0].metadata).toEqual({
            chunkIndex: 0,
            totalChunks: 1,
            strategy: 'per_message',
        });
    });

    it('returns one empty-text chunk for an empty message array... no — it returns []', async () => {
        expect(await chunkText([], { strategy: 'per_message' })).toEqual([]);
    });
});

describe('conversation_turns strategy', () => {
    it('pairs messages two at a time with [speaker]: labels', async () => {
        const messages = [
            { mes: 'Hello?', is_user: true, index: 0 },
            { mes: 'Hello.', name: 'Aria', index: 1 },
            { mes: 'Still there?', is_user: true, index: 2 },
        ];
        const out = await chunkText(messages, { strategy: 'conversation_turns' });

        expect(out).toHaveLength(2);
        expect(out[0].text).toBe('[User]: Hello?\n\n[Aria]: Hello.');
        expect(out[0].metadata).toMatchObject({
            messageIds: [0, 1],
            startIndex: 0,
            endIndex: 1,
        });
        // Odd message count leaves a lone trailing turn.
        expect(out[1].text).toBe('[User]: Still there?');
        expect(out[1].metadata).toMatchObject({ messageIds: [2], startIndex: 2, endIndex: 2 });
    });

    it('pairs strictly by position, so two consecutive user messages get paired together', async () => {
        // No role-awareness: "conversation turns" is really "every 2 messages".
        const out = await chunkText(
            [
                { mes: 'one', is_user: true, index: 0 },
                { mes: 'two', is_user: true, index: 1 },
            ],
            { strategy: 'conversation_turns' },
        );
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('[User]: one\n\n[User]: two');
    });

    it('returns [] for empty or non-array input', async () => {
        expect(await chunkText([], { strategy: 'conversation_turns' })).toEqual([]);
        expect(await chunkText({ mes: 'x' }, { strategy: 'conversation_turns' })).toEqual([]);
    });

    it('ignores chunkSize entirely — a huge pair stays one chunk', async () => {
        const big = 'x'.repeat(5000);
        const out = await chunkText(
            [{ mes: big, index: 0 }, { mes: big, index: 1 }],
            { strategy: 'conversation_turns', chunkSize: 100 },
        );
        expect(out).toHaveLength(1);
        expect(out[0].text.length).toBeGreaterThan(10000);
    });
});

describe('message_batch strategy', () => {
    it('groups batchSize messages per chunk and records the batch range', async () => {
        const messages = Array.from({ length: 5 }, (_, i) => ({ mes: `m${i}`, index: i, name: 'Bot' }));
        const out = await chunkText(messages, { strategy: 'message_batch', batchSize: 2 });

        expect(out).toHaveLength(3);
        expect(out[0].text).toBe('[Bot]: m0\n\n[Bot]: m1');
        expect(out[0].metadata).toMatchObject({ batchSize: 2, startIndex: 0, endIndex: 1 });
        // Final partial batch reports its ACTUAL size, not the configured one.
        expect(out[2].metadata.batchSize).toBe(1);
        expect(out[2].metadata.messageIds).toEqual([4]);
    });

    it('defaults to batches of 4 and treats batchSize 0 as 4 (|| fallback)', async () => {
        const messages = Array.from({ length: 8 }, (_, i) => ({ mes: `m${i}`, index: i }));
        expect(await chunkText(messages, { strategy: 'message_batch' })).toHaveLength(2);
        expect(await chunkText(messages, { strategy: 'message_batch', batchSize: 0 })).toHaveLength(2);
    });

    it('returns [] for empty input', async () => {
        expect(await chunkText([], { strategy: 'message_batch' })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Text strategies
// ---------------------------------------------------------------------------

describe('adaptive strategy', () => {
    it('packs whole paragraphs together until chunkSize would be exceeded', async () => {
        const p = (c) => c.repeat(40);
        const text = [p('a'), p('b'), p('c')].join('\n\n');
        const out = await chunkText(text, { strategy: 'adaptive', chunkSize: 100 });

        // 40 + 2 + 40 = 82 fits; adding a third would be 124 > 100.
        expect(out).toHaveLength(2);
        expect(out[0].text).toBe(`${p('a')}\n\n${p('b')}`);
        expect(out[1].text).toBe(p('c'));
    });

    it('splits an oversized paragraph at sentence boundaries', async () => {
        const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
        const out = await chunkText(text, { strategy: 'adaptive', chunkSize: 25 });
        expect(out.map(c => c.text)).toEqual([
            'Alpha beta gamma.',
            'Delta epsilon zeta.',
            'Eta theta iota.',
        ]);
    });

    it('emits an oversized chunk when a single WORD exceeds chunkSize (no hard split)', async () => {
        // BUG-SHAPED: splitLargeParagraph falls back to word splitting, but a
        // single word longer than maxSize is never broken up.
        const monster = 'z'.repeat(120);
        const out = await chunkText(monster, { strategy: 'adaptive', chunkSize: 20 });
        expect(out).toHaveLength(1);
        expect(out[0].text.length).toBe(120);
    });

    it('returns the raw text as one chunk when the input is only whitespace', async () => {
        // paragraphs filters to empty, so chunks is empty and the `: [text]`
        // fallback returns the untrimmed original.
        const out = await chunkText('   \n\n   ', { strategy: 'adaptive' });
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('   \n\n   ');
    });

    it('routes array input through per_message', async () => {
        const out = await chunkText([{ mes: 'a', index: 0 }], { strategy: 'adaptive' });
        expect(out[0].metadata.speaker).toBe('Character');
        expect(out[0].metadata.strategy).toBe('adaptive');
    });

    it('uses DEFAULT_CHUNK_SIZE when no chunkSize is given', async () => {
        const para = 'w'.repeat(DEFAULT_CHUNK_SIZE - 10);
        const out = await chunkText(`${para}\n\n${para}`, { strategy: 'adaptive' });
        expect(out).toHaveLength(2);
    });
});

describe('paragraph strategy', () => {
    it('splits on blank lines and trims each paragraph', async () => {
        const out = await chunkText('  first  \n\n\n  second  ', { strategy: 'paragraph' });
        expect(out.map(c => c.text)).toEqual(['first', 'second']);
    });

    it('also splits on a horizontal-rule line of dashes', async () => {
        const out = await chunkText('above\n---\nbelow', { strategy: 'paragraph' });
        expect(out.map(c => c.text)).toEqual(['above', 'below']);
    });

    it('ignores chunkSize — one giant paragraph stays one chunk', async () => {
        const out = await chunkText('y'.repeat(3000), { strategy: 'paragraph', chunkSize: 100 });
        expect(out).toHaveLength(1);
        expect(out[0].text.length).toBe(3000);
    });

    it('stringifies non-string input instead of rejecting it', async () => {
        const out = await chunkText({ a: 1 }, { strategy: 'paragraph' });
        expect(out[0].text).toBe('[object Object]');
    });
});

describe('section strategy', () => {
    it('splits at markdown headers, keeping each header with its body', async () => {
        const text = '# One\nbody one\n\n## Two\nbody two';
        const out = await chunkText(text, { strategy: 'section' });
        expect(out.map(c => c.text)).toEqual(['# One\nbody one', '## Two\nbody two']);
    });

    it('keeps a preamble before the first header as its own section', async () => {
        const text = 'intro text\n\n# Heading\nbody';
        const out = await chunkText(text, { strategy: 'section' });
        expect(out.map(c => c.text)).toEqual(['intro text', '# Heading\nbody']);
    });

    it('falls back to paragraphs when no section headers exist', async () => {
        const out = await chunkText('alpha\n\nbeta', { strategy: 'section' });
        expect(out.map(c => c.text)).toEqual(['alpha', 'beta']);
        expect(out[0].metadata.strategy).toBe('section');
    });

    it('returns [] for whitespace-only input (the one case sections ends up empty)', async () => {
        // The single pushed section trims to '' and is then removed by
        // `.filter(s => s)` — the only path where section yields nothing.
        expect(await chunkText('   \n  ', { strategy: 'section' })).toEqual([]);
    });

    it('ignores chunkSize — a very long section is never sub-split', async () => {
        const out = await chunkText(`# H\n${'q'.repeat(2000)}`, { strategy: 'section', chunkSize: 50 });
        expect(out).toHaveLength(1);
        expect(out[0].text.length).toBeGreaterThan(2000);
    });
});

describe('sentence strategy', () => {
    it('groups sentences up to chunkSize, joining them with single spaces', async () => {
        const text = 'One two. Three four. Five six. Seven eight.';
        const out = await chunkText(text, { strategy: 'sentence', chunkSize: 25 });
        expect(out.map(c => c.text)).toEqual(['One two. Three four.', 'Five six. Seven eight.']);
    });

    it('splits on CJK sentence punctuation with no trailing whitespace', async () => {
        const out = await chunkText('第一句。第二句！第三句？', { strategy: 'sentence', chunkSize: 5 });
        expect(out.map(c => c.text)).toEqual(['第一句。', '第二句！', '第三句？']);
    });

    it('emits a single over-long sentence as an oversized chunk', async () => {
        // BUG-SHAPED: unlike adaptive, the sentence strategy has no word-level
        // fallback, so one long sentence blows past chunkSize.
        const long = `${'w '.repeat(60)}end.`;
        const out = await chunkText(long, { strategy: 'sentence', chunkSize: 20 });
        expect(out).toHaveLength(1);
        expect(out[0].text.length).toBeGreaterThan(100);
    });

    it('stringifies non-string input', async () => {
        const out = await chunkText(['a', 'b'], { strategy: 'sentence' });
        expect(out[0].text).toBe('a,b');
    });
});

describe('dialogue strategy', () => {
    it('keeps quoted speech together with the surrounding narration', async () => {
        const text = 'She paused. "I know what you did," she said. He froze.';
        const out = await chunkText(text, { strategy: 'dialogue', chunkSize: 500 });
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe(text);
    });

    it('starts a new chunk when appending a quote would exceed chunkSize', async () => {
        const text = `${'n'.repeat(40)} "spoken line here" ${'m'.repeat(40)}`;
        const out = await chunkText(text, { strategy: 'dialogue', chunkSize: 50 });
        expect(out.length).toBeGreaterThan(1);
    });

    it('recognises CJK corner-bracket quotes', async () => {
        const out = await chunkText('彼は「行こう」と言った。', { strategy: 'dialogue', chunkSize: 500 });
        expect(out[0].text).toBe('彼は「行こう」と言った。');
    });

    it('is reachable via chunkText even though it is not listed in getChatStrategies()', async () => {
        expect(getChatStrategies()).not.toContain('dialogue');
        expect(getAvailableStrategies()).toContain('dialogue');
    });
});

// ---------------------------------------------------------------------------
// Content strategies
// ---------------------------------------------------------------------------

describe('per_entry strategy', () => {
    it('makes one chunk per lorebook entry with entryName + keys metadata', async () => {
        const entries = [
            { comment: 'Capital City', key: ['Vaelor', 'capital'], content: 'Vaelor is the capital.' },
            { name: 'The Order', keys: ['order'], text: 'A knightly order.' },
        ];
        const out = await chunkText(entries, { strategy: 'per_entry' });

        expect(out[0]).toMatchObject({
            text: 'Vaelor is the capital.',
            metadata: { entryName: 'Capital City', keys: ['Vaelor', 'capital'] },
        });
        expect(out[1]).toMatchObject({
            text: 'A knightly order.',
            metadata: { entryName: 'The Order', keys: ['order'] },
        });
    });

    it('falls back to the first key as the entry name', async () => {
        const out = await chunkText([{ key: ['Fallback'], content: 'body' }], { strategy: 'per_entry' });
        expect(out[0].metadata.entryName).toBe('Fallback');
    });

    it('stringifies an entry that has neither .text nor .content', async () => {
        const out = await chunkText([{ comment: 'Empty' }], { strategy: 'per_entry' });
        expect(out[0].text).toBe('[object Object]');
    });

    it('accepts plain strings, yielding undefined metadata fields', async () => {
        const out = await chunkText(['just text'], { strategy: 'per_entry' });
        expect(out[0].text).toBe('just text');
        expect(out[0].metadata.entryName).toBeUndefined();
        expect(out[0].metadata.keys).toBeUndefined();
    });

    it('wraps a non-array input into one chunk with no entry metadata', async () => {
        const out = await chunkText('single entry', { strategy: 'per_entry' });
        expect(out).toEqual([{
            text: 'single entry',
            metadata: { chunkIndex: 0, totalChunks: 1, strategy: 'per_entry' },
        }]);
    });
});

describe('per_field strategy', () => {
    it('makes one chunk per non-empty string field, tagged with the field name', async () => {
        const character = {
            description: 'A wandering knight.',
            personality: 'Stoic.',
            scenario: '',
            depth: 3,
            tags: ['a', 'b'],
            first_mes: '   ',
        };
        const out = await chunkText(character, { strategy: 'per_field' });

        expect(out.map(c => c.metadata.field)).toEqual(['description', 'personality']);
        expect(out[0].text).toBe('A wandering knight.');
    });

    it('preserves original field values verbatim (no trimming)', async () => {
        const out = await chunkText({ description: '  padded  ' }, { strategy: 'per_field' });
        expect(out[0].text).toBe('  padded  ');
    });

    it('stringifies array or primitive input instead of iterating it', async () => {
        expect((await chunkText(['a'], { strategy: 'per_field' }))[0].text).toBe('a');
        expect((await chunkText('str', { strategy: 'per_field' }))[0].text).toBe('str');
    });

    it('returns [] when every field is empty', async () => {
        expect(await chunkText({ a: '', b: '  ' }, { strategy: 'per_field' })).toEqual([]);
    });

    it('ignores chunkSize — a huge single field stays one chunk', async () => {
        const out = await chunkText({ description: 'd'.repeat(4000) }, {
            strategy: 'per_field',
            chunkSize: 100,
        });
        expect(out).toHaveLength(1);
    });
});

describe('combined strategy', () => {
    it('merges object values with blank lines then adaptively chunks', async () => {
        const out = await chunkText(
            { description: 'a'.repeat(60), personality: 'b'.repeat(60) },
            { strategy: 'combined', chunkSize: 100 },
        );
        expect(out).toHaveLength(2);
    });

    it('merges arrays by reading .text off each item, dropping items that lack it', async () => {
        const out = await chunkText(
            [{ text: 'kept' }, { content: 'dropped' }, 'raw'],
            { strategy: 'combined', chunkSize: 500 },
        );
        // The middle item contributes an empty string, which the paragraph
        // filter then removes.
        expect(out).toHaveLength(1);
        expect(out[0].text).toBe('kept\n\nraw');
    });

    it('skips non-string object values', async () => {
        const out = await chunkText(
            { keep: 'text', drop: 42, alsoDrop: null },
            { strategy: 'combined', chunkSize: 500 },
        );
        expect(out[0].text).toBe('text');
    });
});

// ---------------------------------------------------------------------------
// Strategy metadata helpers
// ---------------------------------------------------------------------------

describe('strategy introspection helpers', () => {
    it('lists exactly the strategies that are implemented', () => {
        expect(getAvailableStrategies()).toEqual([
            'per_message',
            'conversation_turns',
            'message_batch',
            'adaptive',
            'paragraph',
            'section',
            'sentence',
            'per_entry',
            'per_field',
            'combined',
            'dialogue',
        ]);
    });

    it('classifies unit strategies (size controls do not apply)', () => {
        for (const s of ['per_message', 'conversation_turns', 'message_batch', 'per_entry', 'per_field']) {
            expect(isUnitStrategy(s)).toBe(true);
        }
        for (const s of ['adaptive', 'paragraph', 'section', 'sentence', 'combined', 'dialogue', 'bogus']) {
            expect(isUnitStrategy(s)).toBe(false);
        }
    });

    it('offers four chat strategies', () => {
        expect(getChatStrategies()).toEqual([
            'per_message',
            'conversation_turns',
            'message_batch',
            'adaptive',
        ]);
    });
});

/**
 * Unit tests for core/reformat-schema.js
 *
 * Covers the Auto-Reformat schema validator, hallucination guardrail
 * (computeNameVerification), and prompt builder. Pure module, no ST globals
 * — no mocking required (same convention as glossary-extractor.test.js).
 */

import { describe, it, expect } from 'vitest';
import {
    REFORMAT_ENTRY_TYPES,
    REFORMAT_HIERARCHY_REL_TYPES,
    validateReformattedChunk,
    computeNameVerification,
    computeKeywordVerification,
    buildReformatPrompt,
    buildRepairPrompt,
    buildRelationalClause,
    buildLinkingPrompt,
    computeBatchCoverage,
    sanitizeTraits,
    TRAIT_MAX_CHARS,
    TRAITS_MAX_COUNT,
    TRAIT_BODY_OVERLAP_MIN_CHARS,
} from '../core/reformat-schema.js';

describe('validateReformattedChunk', () => {
    it('accepts a well-formed record and normalizes array fields', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'character',
            name: '  Bulwark  ',
            aliases: ['Eleanor Graves', 'Eleanor Graves', '  '],
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: [{ text: 'Ironclad', importance: 6 }, { text: 'Fortress', importance: 9 }],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });

        expect(ok).toBe(true);
        expect(errors).toEqual([]);
        expect(chunk).toEqual({
            entry_type: 'character',
            name: 'Bulwark',
            aliases: ['Eleanor Graves'], // deduped + trimmed + empties dropped
            affiliation: 'Ironclad Agency',
            traits: ['Transformation-type Spark'],
            relationships: [],
            keywords: [{ text: 'Ironclad', importance: 6 }, { text: 'Fortress', importance: 9 }],
            body: 'Bulwark is the lead hero of Ironclad Agency.',
        });
    });

    it('accepts legacy plain-string keywords and defaults their importance to 5', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: ['legacy term'],
        });
        expect(chunk.keywords).toEqual([{ text: 'legacy term', importance: 5 }]);
    });

    it('clamps out-of-range keyword importance to 1-10 and rounds fractional values', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: [
                { text: 'too high', importance: 99 },
                { text: 'too low', importance: -5 },
                { text: 'fractional', importance: 6.7 },
                { text: 'not a number', importance: 'high' },
            ],
        });
        expect(chunk.keywords).toEqual([
            { text: 'too high', importance: 10 },
            { text: 'too low', importance: 1 },
            { text: 'fractional', importance: 7 },
            { text: 'not a number', importance: 5 },
        ]);
    });

    it('dedupes keywords by case-insensitive text, keeping the first occurrence', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'X', body: 'Y',
            keywords: [{ text: 'Fortress', importance: 9 }, { text: 'FORTRESS', importance: 2 }],
        });
        expect(chunk.keywords).toEqual([{ text: 'Fortress', importance: 9 }]);
    });

    it('rejects a non-object input', () => {
        const { ok, errors } = validateReformattedChunk('not an object');
        expect(ok).toBe(false);
        expect(errors[0]).toMatch(/not an object/);
    });

    it('rejects a record with no name', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', body: 'Some lore.' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['name is empty or missing']);
    });

    it('rejects a record with no body', () => {
        const { ok, errors } = validateReformattedChunk({ entry_type: 'concept', name: 'Spark Classification' });
        expect(ok).toBe(false);
        expect(errors).toEqual(['body is empty or missing']);
    });

    it('coerces an unknown entry_type to "other" and reports it', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'villain_org', // not in vocabulary
            name: 'The Daughters of the Awakening',
            body: 'A female supremacist paramilitary organization.',
        });

        expect(ok).toBe(true);
        expect(chunk.entry_type).toBe('other');
        expect(errors.some(e => /not in vocabulary/.test(e))).toBe(true);
    });

    it('every declared entry_type round-trips without coercion', () => {
        for (const entry_type of REFORMAT_ENTRY_TYPES) {
            const { ok, errors, chunk } = validateReformattedChunk({ entry_type, name: 'X', body: 'Y' });
            expect(ok).toBe(true);
            expect(chunk.entry_type).toBe(entry_type);
            expect(errors).toEqual([]);
        }
    });

    it('defaults affiliation to an empty string when missing', () => {
        const { chunk } = validateReformattedChunk({ entry_type: 'concept', name: 'X', body: 'Y' });
        expect(chunk.affiliation).toBe('');
        expect(chunk.aliases).toEqual([]);
        expect(chunk.traits).toEqual([]);
        expect(chunk.relationships).toEqual([]);
        expect(chunk.keywords).toEqual([]);
    });

    it('accepts canonical {target, type} relationships without warnings and never produces "[object Object]"', () => {
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'Empire of the Rising Sun',
            body: 'A militant feline aristocracy allied with the Reich.',
            relationships: [{ target: 'The Reich', type: 'alliance' }],
        });

        expect(ok).toBe(true);
        expect(chunk.relationships).toEqual([{ target: 'The Reich', type: 'alliance' }]);
        expect(JSON.stringify(chunk.relationships)).not.toContain('[object Object]');
        expect(errors).toEqual([]);
    });

    it('coerces a legacy plain-string relationship to {target, type:""} and reports the reshaping', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'Waffen-SS',
            body: 'Y',
            relationships: ['Schutzstaffel (parent organization)'],
        });

        // Parentheticals are deliberately NOT parsed out of strings — parens
        // legitimately appear in entity names.
        expect(chunk.relationships).toEqual([{ target: 'Schutzstaffel (parent organization)', type: '' }]);
        expect(errors.some(e => /relationships.*reshaping/.test(e))).toBe(true);
    });

    it('accepts alternate object keys (name/relation) for relationships and reports the reshaping', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'X',
            body: 'Y',
            relationships: [{ name: 'Reich', relation: 'ally' }],
        });

        expect(chunk.relationships).toEqual([{ target: 'Reich', type: 'ally' }]);
        expect(errors.some(e => /relationships.*reshaping/.test(e))).toBe(true);
    });

    it('dedupes relationships by case-insensitive target+type and drops items with no resolvable target', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'organization',
            name: 'X',
            body: 'Y',
            relationships: [
                { target: 'Reich', type: 'ally' },
                { target: 'reich', type: 'ALLY' },
                { unrecognizedKey: 'value' },
            ],
        });

        expect(chunk.relationships).toEqual([{ target: 'Reich', type: 'ally' }]);
        expect(errors.some(e => /relationships.*no resolvable target/.test(e))).toBe(true);
    });

    it('applies the object-coercion safety net to aliases and traits', () => {
        const { chunk, errors } = validateReformattedChunk({
            entry_type: 'character',
            name: 'X',
            body: 'Y',
            aliases: [{ name: 'The Masked One' }],
            traits: [{ description: 'Superhuman strength' }],
        });

        expect(chunk.aliases).toEqual(['The Masked One']);
        expect(chunk.traits).toEqual(['Superhuman strength']);
        expect(errors.some(e => /aliases.*object/.test(e))).toBe(true);
        expect(errors.some(e => /traits.*object/.test(e))).toBe(true);
    });
});

describe('computeNameVerification', () => {
    const source = 'Bulwark (Eleanor Graves) leads Ironclad Agency. Her Spark is called Fortress.';

    it('grounds a name that appears verbatim in the source', () => {
        const [result] = computeNameVerification([{ name: 'Bulwark', aliases: [] }], source);
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual([]);
    });

    it('grounds a name regardless of case/punctuation differences', () => {
        const [result] = computeNameVerification([{ name: 'ELEANOR, GRAVES' }], source);
        expect(result.nameGrounded).toBe(true);
    });

    it('flags a name that does not appear anywhere in the source', () => {
        const [result] = computeNameVerification([{ name: 'Solaris', aliases: [] }], source);
        expect(result.nameGrounded).toBe(false);
    });

    it('flags only the ungrounded aliases, not the grounded ones', () => {
        const [result] = computeNameVerification(
            [{ name: 'Bulwark', aliases: ['Eleanor Graves', 'Steel Maiden'] }],
            source,
        );
        expect(result.nameGrounded).toBe(true);
        expect(result.ungroundedAliases).toEqual(['Steel Maiden']);
    });

    it('treats every chunk as grounded when sourceText is empty (nothing to check against)', () => {
        const result = computeNameVerification([{ name: 'Anyone' }], '');
        expect(result).toEqual([{ nameGrounded: true, ungroundedAliases: [] }]);
    });

    it('returns an empty array for non-array input', () => {
        expect(computeNameVerification(null, source)).toEqual([]);
    });

    it('grounds a compound sub-entry name when each component is grounded', () => {
        const subSource = '# Male Sympathizers\n\n## Demographic Composition\n\nSympathizers draw from specific segments.';
        const [result] = computeNameVerification(
            [{ name: 'Male Sympathizers: Demographic Composition', aliases: [] }],
            subSource,
        );
        expect(result.nameGrounded).toBe(true);
    });

    it('flags a compound name when one component is ungrounded', () => {
        const subSource = '# Male Sympathizers\n\nSome text with no such subsection.';
        const [result] = computeNameVerification(
            [{ name: 'Male Sympathizers: Demographic Composition', aliases: [] }],
            subSource,
        );
        expect(result.nameGrounded).toBe(false);
    });

    it('does not split intra-name hyphens as compound separators', () => {
        const [result] = computeNameVerification(
            [{ name: 'Jean-Luc', aliases: [] }],
            'Captain Jean-Luc commands the vessel.',
        );
        expect(result.nameGrounded).toBe(true);
    });
});

describe('computeKeywordVerification', () => {
    const source = 'Bulwark (Eleanor Graves) leads Ironclad Agency. Her Spark is called Fortress.';

    it('grounds a keyword that appears verbatim in the source', () => {
        const [result] = computeKeywordVerification([{ keywords: [{ text: 'Fortress', importance: 9 }] }], source);
        expect(result.ungroundedKeywords).toEqual([]);
    });

    it('flags a keyword that does not appear anywhere in the source', () => {
        const [result] = computeKeywordVerification(
            [{ keywords: [{ text: 'betrayal', importance: 6 }] }],
            source,
        );
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('flags only the ungrounded keywords, not the grounded ones', () => {
        const [result] = computeKeywordVerification(
            [{ keywords: [{ text: 'Fortress', importance: 9 }, { text: 'betrayal', importance: 3 }] }],
            source,
        );
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('accepts legacy plain-string keywords', () => {
        const [result] = computeKeywordVerification([{ keywords: ['Fortress', 'betrayal'] }], source);
        expect(result.ungroundedKeywords).toEqual(['betrayal']);
    });

    it('treats every chunk as grounded when sourceText is empty (nothing to check against)', () => {
        const result = computeKeywordVerification([{ keywords: [{ text: 'anything', importance: 5 }] }], '');
        expect(result).toEqual([{ ungroundedKeywords: [] }]);
    });

    it('returns an empty array for non-array input', () => {
        expect(computeKeywordVerification(null, source)).toEqual([]);
    });

    it('uses a softer default threshold than computeNameVerification', () => {
        // "Iron Agency" is a near-miss for "Ironclad Agency" in the source
        // (similarity ~0.73) — grounded under the keyword threshold (0.7)
        // but not under the stricter name threshold (0.8), demonstrating
        // keywords get more slack than names/aliases.
        const keyword = 'Iron Agency';
        const [keywordResult] = computeKeywordVerification([{ keywords: [{ text: keyword, importance: 5 }] }], source);
        const [nameResult] = computeNameVerification([{ name: keyword, aliases: [] }], source);

        expect(keywordResult.ungroundedKeywords).toEqual([]);
        expect(nameResult.nameGrounded).toBe(false);
    });
});

describe('buildReformatPrompt', () => {
    it('substitutes {{text}} into the default template', () => {
        const prompt = buildReformatPrompt('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('SOME SOURCE TEXT HERE');
        expect(prompt).toContain('entry_type');
        expect(prompt).not.toContain('{{text}}');
    });

    it('has no continuation note when batchContext is not provided', () => {
        const prompt = buildReformatPrompt('body text');
        expect(prompt).not.toMatch(/continuation of section/i);
    });

    it('injects a continuation note listing already-extracted names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'Notable US Hero Agencies', alreadyExtractedNames: ['Columbia', 'Bulwark'] },
        });
        expect(prompt).toMatch(/continuation of section "Notable US Hero Agencies"/);
        expect(prompt).toContain('Columbia, Bulwark');
        expect(prompt).toContain('Emit additional facts about these entries under the same names');
    });

    it('shows "(none yet)" when the continuation has no prior names', () => {
        const prompt = buildReformatPrompt('more text', {
            batchContext: { sectionTitle: 'The Daughters of the Awakening', alreadyExtractedNames: [] },
        });
        expect(prompt).toContain('(none yet)');
    });

    it('uses a customPrompt override instead of the default template', () => {
        const prompt = buildReformatPrompt('MY TEXT', { customPrompt: 'Custom instructions.\n\n{{text}}' });
        expect(prompt).toBe('Custom instructions.\n\nMY TEXT');
    });

    it('teaches rewrite-not-verbatim: facts preserved, prose rewritten, meta-instructions dropped', () => {
        const prompt = buildReformatPrompt('x');
        expect(prompt).toContain('REWRITE the prose');
        expect(prompt).toContain('INFORMATIONAL, not instructional');
        expect(prompt).not.toContain('VERBATIM');
        // the no-invent/no-omit fact contract must survive the rewrite change
        expect(prompt).toMatch(/Never invent details/i);
        expect(prompt).toMatch(/never omit a named detail/i);
    });

    it('teaches the topic-hierarchy vocabulary exported as REFORMAT_HIERARCHY_REL_TYPES', () => {
        const prompt = buildReformatPrompt('x');
        for (const relType of REFORMAT_HIERARCHY_REL_TYPES) {
            expect(prompt).toContain(`"${relType}"`);
        }
        expect(prompt).toContain('TOPIC HIERARCHY');
        // anti-fragmentation guard: list-item subtypes stay in the parent body
        expect(prompt).toMatch(/one-line list item does NOT get its own entry/);
    });
});

describe('sanitizeTraits', () => {
    const body = 'Bulwark, civilian name Eleanor Graves, is the lead hero of Ironclad Agency in New York City. Her Transformation-type Spark, Fortress, allows Bulwark to turn her hide into indestructible metal.';

    it('drops traits longer than TRAIT_MAX_CHARS and reports a note', () => {
        const errors = [];
        const longTrait = 'x'.repeat(TRAIT_MAX_CHARS + 1);
        const out = sanitizeTraits(['short trait', longTrait], body, errors);
        expect(out).toEqual(['short trait']);
        expect(errors.some(e => /traits: 1 item\(s\) over/.test(e))).toBe(true);
    });

    it('drops a trait that duplicates a substantial span of the body (paste-body-into-traits failure)', () => {
        const errors = [];
        // ≥ TRAIT_BODY_OVERLAP_MIN_CHARS but under TRAIT_MAX_CHARS, and contained in body
        const bodyCopy = 'is the lead hero of Ironclad Agency in New York City. Her Transformation-type Spark, Fortress';
        expect(bodyCopy.length).toBeGreaterThanOrEqual(TRAIT_BODY_OVERLAP_MIN_CHARS);
        expect(bodyCopy.length).toBeLessThanOrEqual(TRAIT_MAX_CHARS);
        const out = sanitizeTraits([bodyCopy, 'Spark: Fortress'], body, errors);
        expect(out).toEqual(['Spark: Fortress']);
        expect(errors.some(e => /duplicated a span of the body/.test(e))).toBe(true);
    });

    it('keeps short traits that legitimately echo body phrases', () => {
        const out = sanitizeTraits(['lead hero of Ironclad Agency'], body, []);
        expect(out).toEqual(['lead hero of Ironclad Agency']);
    });

    it('caps the array at TRAITS_MAX_COUNT keeping the first entries', () => {
        const errors = [];
        const many = Array.from({ length: TRAITS_MAX_COUNT + 5 }, (_, i) => `trait ${i}`);
        const out = sanitizeTraits(many, body, errors);
        expect(out).toHaveLength(TRAITS_MAX_COUNT);
        expect(out[0]).toBe('trait 0');
        expect(errors.some(e => /capped at/.test(e))).toBe(true);
    });

    it('end-to-end: validateReformattedChunk sanitizes a body-pasted-into-traits payload without rejecting it', () => {
        const entryBody = 'The process of transforming into an individual dumb brute or stud, perfectly happy to work out and perform physical tasks mindlessly. Frequently involves an exaggerated, hypersexualized male form.';
        const { ok, errors, chunk } = validateReformattedChunk({
            entry_type: 'concept',
            name: 'Himbofication',
            aliases: [],
            affiliation: '',
            traits: [entryBody, 'male equivalent of bimbofication'],
            relationships: [],
            keywords: [],
            body: entryBody,
        });
        expect(ok).toBe(true);
        expect(chunk.traits).toEqual(['male equivalent of bimbofication']);
        expect(errors.some(e => /traits/.test(e))).toBe(true);
    });
});

describe('hierarchy relationship normalization', () => {
    it('canonicalizes "sub-topic of" spelling variants to "subtopic of"', () => {
        const { chunk } = validateReformattedChunk({
            entry_type: 'concept', name: 'Transformation Sparks', body: 'Body.',
            relationships: [
                { target: 'Spark Classification System', type: 'Sub-Topic Of' },
                { target: 'Spark Classification System', type: 'subtopic of' }, // dupe after canonicalization
                { target: 'Something Else', type: 'variant of' },
            ],
        });
        expect(chunk.relationships).toEqual([
            { target: 'Spark Classification System', type: 'subtopic of' },
            { target: 'Something Else', type: 'variant of' },
        ]);
    });
});

describe('buildRelationalClause', () => {
    it('returns empty string when both affiliation and relationships are empty', () => {
        expect(buildRelationalClause('', [])).toBe('');
        expect(buildRelationalClause('', undefined)).toBe('');
        expect(buildRelationalClause(undefined, undefined)).toBe('');
    });

    it('includes only the affiliation clause when relationships is empty', () => {
        expect(buildRelationalClause('The Reich', [])).toBe(' Affiliated with The Reich.');
    });

    it('renders {target, type} with the type parenthesized, joined by semicolons', () => {
        expect(buildRelationalClause('', [
            { target: 'Schutzstaffel', type: 'parent organization' },
            { target: 'Oberkatze', type: 'leader' },
        ])).toBe(' Related: Schutzstaffel (parent organization); Oberkatze (leader).');
    });

    it('omits the parenthetical when type is empty', () => {
        expect(buildRelationalClause('', [{ target: 'Oberkatze', type: '' }]))
            .toBe(' Related: Oberkatze.');
    });

    it('tolerates legacy plain-string relationships, rendering them as-is', () => {
        expect(buildRelationalClause('', ['Leader of the Inner Circle', { target: 'Reich', type: 'ally' }]))
            .toBe(' Related: Leader of the Inner Circle; Reich (ally).');
    });

    it('combines affiliation and relationships in one trailer', () => {
        expect(buildRelationalClause('Reich', [{ target: 'Inner Circle', type: 'leader' }]))
            .toBe(' Affiliated with Reich. Related: Inner Circle (leader).');
    });

    it('trims whitespace and drops entries with no target', () => {
        expect(buildRelationalClause('  Reich  ', [{ target: '  ', type: 'x' }, { target: ' Inner Circle ', type: '' }, null]))
            .toBe(' Affiliated with Reich. Related: Inner Circle.');
    });

    it('is appendable directly onto a body string with a single leading space', () => {
        const clause = buildRelationalClause('Reich', [{ target: 'Inner Circle', type: 'leader' }]);
        const body = 'Oberkatze rose to power through the movement.';
        expect(body + clause).toBe('Oberkatze rose to power through the movement. Affiliated with Reich. Related: Inner Circle (leader).');
    });
});

describe('buildLinkingPrompt', () => {
    const catalog = [
        { name: 'Victory Plaza', entry_type: 'location', aliases: ['Times Square'] },
        { name: 'Capital Punishment in the Reich', entry_type: 'concept', aliases: [] },
    ];

    it('lists every catalog entity with its type, including aliases when present', () => {
        const prompt = buildLinkingPrompt('Some section text.', catalog);
        expect(prompt).toContain('- Victory Plaza [location] (also known as: Times Square)');
        expect(prompt).toContain('- Capital Punishment in the Reich [concept]');
        expect(prompt).not.toContain('Capital Punishment in the Reich [concept] (also known as');
    });

    it('embeds the batch text and asks for {source, target, type} triples only', () => {
        const prompt = buildLinkingPrompt('Executions are held in Victory Plaza.', catalog);
        expect(prompt).toContain('Executions are held in Victory Plaza.');
        expect(prompt).toMatch(/"source":.*"target":.*"type":/s);
        expect(prompt).toMatch(/MUST both be names from the CATALOG/);
    });

    it('handles an empty catalog without crashing', () => {
        const prompt = buildLinkingPrompt('Text.', []);
        expect(typeof prompt).toBe('string');
        expect(prompt).toContain('Text.');
    });
});

// ---------------------------------------------------------------------------
// Coverage check (under-extraction guardrail)
// ---------------------------------------------------------------------------

describe('computeBatchCoverage', () => {
    // Mirrors the observed real-world failure: a 4-subsection organization
    // profile where the model's output covered only the first subsection.
    const batchText = [
        '# Male Sympathizers in the Matriarchal Society',
        '',
        '## Definition and Organizational Structure',
        '',
        'Male Sympathizers are a decentralized network of female citizens advocating equality for males. They communicate through encrypted messaging and library book marginalia.',
        '',
        '## Societal Treatment and Legal Consequences',
        '',
        'Visible sympathizers face charges from "promoting gender disorder" (misdemeanor) to "seditious conspiracy" (felony, 5–20 years). The state diagnoses sympathizers with invented conditions such as "reverse gender identity disorder".',
        '',
        '## Social Stigmatization and Pejorative Terms',
        '',
        'The linguistic arsenal includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
    ].join('\n');

    const definitionEntry = {
        entry_type: 'organization',
        name: 'Male Sympathizers',
        aliases: [],
        traits: ['decentralized female network'],
        keywords: [{ text: 'sympathizers', importance: 8 }],
        body: 'Male Sympathizers are a decentralized network of female citizens advocating equality for males. They communicate through encrypted messaging and library book marginalia.',
    };

    it('flags sections whose facts did not land in any entry, listing the missing facts', () => {
        const flagged = computeBatchCoverage(batchText, [definitionEntry], 0.5);

        const titles = flagged.map(s => s.title);
        expect(titles).toContain('Societal Treatment and Legal Consequences');
        expect(titles).toContain('Social Stigmatization and Pejorative Terms');
        expect(titles).not.toContain('Definition and Organizational Structure');

        const stigma = flagged.find(s => s.title === 'Social Stigmatization and Pejorative Terms');
        expect(stigma.missingFacts).toContain('male-lover');
        expect(stigma.missingFacts).toContain('gender traitor');
        expect(stigma.coverage).toBeLessThan(0.5);
    });

    it('returns no flags when every section\'s facts are covered', () => {
        const fullEntries = [
            definitionEntry,
            {
                entry_type: 'concept',
                name: 'Male Sympathizers: Societal Treatment and Legal Consequences',
                aliases: [], traits: [], keywords: [],
                body: 'Visible sympathizers face charges from "promoting gender disorder" (a misdemeanor) to "seditious conspiracy" (a felony carrying 5–20 years). The state diagnoses sympathizers with invented conditions such as "reverse gender identity disorder".',
            },
            {
                entry_type: 'concept',
                name: 'Male Sympathizers: Social Stigmatization and Pejorative Terms',
                aliases: [], traits: [], keywords: [],
                body: 'The linguistic arsenal against sympathizers includes "male-lover", "gender traitor", "softhead", and youth slang like "moid-simp" and "equality-pilled".',
            },
        ];
        expect(computeBatchCoverage(batchText, fullEntries, 0.5)).toEqual([]);
    });

    it('skips sections with too few distinctive fact tokens to score', () => {
        expect(computeBatchCoverage('# Hi\n\nShort note.', [], 0.5)).toEqual([]);
    });

    it('treats headerless text as a single section', () => {
        const text = 'The Edict of Coals of 1147 fines offenders 500 crowns, with conviction rates above 90% in the Pyre Courts.';
        const flagged = computeBatchCoverage(text, [], 0.5);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].missingFacts.length).toBeGreaterThan(0);
    });

    it('returns [] for empty or non-string input', () => {
        expect(computeBatchCoverage('', [], 0.5)).toEqual([]);
        expect(computeBatchCoverage(null, [], 0.5)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Repair prompt
// ---------------------------------------------------------------------------

describe('buildRepairPrompt', () => {
    const flagged = [
        {
            title: 'Social Stigmatization and Pejorative Terms',
            text: '## Social Stigmatization and Pejorative Terms\n\nThe arsenal includes "male-lover" and "gender traitor".',
            missingFacts: ['male-lover', 'gender traitor'],
        },
    ];

    it('rides the full extraction template: schema fields, rules, and the flagged text all present', () => {
        const prompt = buildRepairPrompt(flagged, { alreadyExtractedNames: ['Male Sympathizers'] });
        // full schema must be restated — LLM calls are stateless
        expect(prompt).toContain('entry_type');
        expect(prompt).toContain('TOPIC HIERARCHY');
        // the repair note and its payload
        expect(prompt).toMatch(/REPAIR PASS/);
        expect(prompt).toContain('Male Sympathizers');
        expect(prompt).toContain('male-lover; gender traitor');
        // flagged section text is the {{text}} payload
        expect(prompt).toContain('The arsenal includes "male-lover" and "gender traitor".');
        expect(prompt).not.toContain('{{text}}');
        expect(prompt).not.toContain('{{continuationNote}}');
    });

    it('respects a customPrompt override', () => {
        const prompt = buildRepairPrompt(flagged, { customPrompt: 'CUSTOM {{continuationNote}}TEXT: {{text}}' });
        expect(prompt).toMatch(/^CUSTOM NOTE — REPAIR PASS/);
        expect(prompt).toContain('TEXT: ## Social Stigmatization');
    });

    it('shows "(none)" when nothing was extracted yet', () => {
        const prompt = buildRepairPrompt(flagged, {});
        expect(prompt).toContain('Entries already extracted: (none)');
    });
});


it('does not count metadata-only facts as body coverage', () => {
    const text = '## Licensing\nThe Federal Hero Oversight Bureau requires 500 crowns in 1147 under the Edict of Coals. Permits expire in 1148.';
    const entries = [{ name: text, aliases: [text], traits: [text], keywords: [{ text, importance: 10 }], body: 'Licensing is discussed.' }];
    expect(computeBatchCoverage(text, entries)).not.toEqual([]);
    expect(computeBatchCoverage(text, [{ body: text }])).toEqual([]);
});


it('preserves dollar replacement sequences in source material verbatim', () => {
    const text = 'Literal $& and $$ and $` and $\' must survive.';
    expect(buildReformatPrompt(text, { customPrompt: '{{text}}' })).toBe(text);
    expect(buildRepairPrompt([{ title: 'Syntax', text, missingFacts: [] }], { customPrompt: '{{text}}' })).toBe(text);
});

/**
 * Unit tests for core/glossary-extractor.js
 *
 * Covers the acronym-grounding fix: a document typically spells out a named
 * entity once ("Federal Hero Oversight Bureau (FHOB)") and refers to it by
 * bare acronym everywhere else. extractGlossary() must find the real
 * definition and reject look-alike false positives (e.g. "Threat Level
 * (FHOB)"), and injectGlossary() must ground any chunk that references an
 * acronym without its full name — without touching chunks that don't need it.
 *
 * Pure module, no ST globals — no mocking required.
 */

import { describe, it, expect } from 'vitest';
import { extractGlossary, injectGlossary, groundReferenceChunks, splitReferenceSources } from '../core/glossary-extractor.js';

describe('extractGlossary', () => {
    it('extracts a simple "Full Name (ACRONYM)" definition', () => {
        const text = 'Rankings are published quarterly by the Federal Hero Oversight Bureau (FHOB).';
        const glossary = extractGlossary(text);
        expect(glossary).toEqual([{ acronym: 'FHOB', fullName: 'Federal Hero Oversight Bureau' }]);
    });

    it('rejects a look-alike false positive whose initials do not match', () => {
        const text = 'Threat Level (FHOB): Severe';
        const glossary = extractGlossary(text);
        expect(glossary).toEqual([]);
    });

    it('keeps the real definition even when a look-alike false positive appears first', () => {
        const text = [
            'Threat Level (FHOB): Severe',
            'Later, the Federal Hero Oversight Bureau (FHOB) explained its methodology.',
        ].join('\n\n');
        const glossary = extractGlossary(text);
        expect(glossary).toEqual([{ acronym: 'FHOB', fullName: 'Federal Hero Oversight Bureau' }]);
    });

    it('leaves conflicting explicit definitions unresolved', () => {
        const text = [
            'The International Spark Research Council (ISRC) sets classification standards.',
            'Some other body, Innovative Space Research Committee (ISRC), is unrelated.',
        ].join('\n\n');
        const glossary = extractGlossary(text);
        expect(glossary).toEqual([]);
    });

    it('tolerates stopwords inside the phrase via the initials check', () => {
        const text = 'Filed with the Department of Justice (DOJ) last spring.';
        const glossary = extractGlossary(text);
        expect(glossary).toEqual([{ acronym: 'DOJ', fullName: 'Department of Justice' }]);
    });

    it('finds multiple distinct acronyms in one document', () => {
        const text = [
            'The Federal Hero Oversight Bureau (FHOB) ranks heroes nationally.',
            'The Spark Liberation Front (SLF) opposes all licensing.',
        ].join('\n\n');
        const glossary = extractGlossary(text);
        expect(glossary.map(g => g.acronym).sort()).toEqual(['FHOB', 'SLF']);
    });

    it('returns an empty array for empty, null, or non-string input', () => {
        expect(extractGlossary('')).toEqual([]);
        expect(extractGlossary(null)).toEqual([]);
        expect(extractGlossary(undefined)).toEqual([]);
    });

    it('returns an empty array when no definitions are present', () => {
        expect(extractGlossary('Just some ordinary prose with no acronyms at all.')).toEqual([]);
    });
});

describe('injectGlossary', () => {
    const glossary = [{ acronym: 'FHOB', fullName: 'Federal Hero Oversight Bureau' }];

    it('prepends a glossary line to a chunk that references the bare acronym', () => {
        const chunks = [{ text: 'Threat Level (FHOB): Severe', metadata: {} }];
        const result = injectGlossary(chunks, glossary);
        expect(result[0].text).toBe('[Glossary: FHOB = Federal Hero Oversight Bureau]\nThreat Level (FHOB): Severe');
    });

    it('leaves a chunk untouched when it already contains the full name', () => {
        const original = 'Federal Hero Oversight Bureau (FHOB) publishes the Hero Billboard Chart.';
        const chunks = [{ text: original, metadata: {} }];
        const result = injectGlossary(chunks, glossary);
        expect(result[0].text).toBe(original);
    });

    it('leaves a chunk untouched when it references no glossary acronym', () => {
        const original = 'No acronyms here at all.';
        const chunks = [{ text: original, metadata: {} }];
        const result = injectGlossary(chunks, glossary);
        expect(result[0].text).toBe(original);
    });

    it('does not match the acronym as a substring of another word', () => {
        const original = 'The word AFHOBX should not trigger a match.';
        const chunks = [{ text: original, metadata: {} }];
        const result = injectGlossary(chunks, glossary);
        expect(result[0].text).toBe(original);
    });

    it('is non-mutating — returns new objects, leaves the input array/objects untouched', () => {
        const original = { text: 'Threat Level (FHOB): Severe', metadata: {} };
        const chunks = [original];
        const result = injectGlossary(chunks, glossary);
        expect(result).not.toBe(chunks);
        expect(result[0]).not.toBe(original);
        expect(original.text).toBe('Threat Level (FHOB): Severe');
    });

    it('preserves existing chunk metadata', () => {
        const chunks = [{ text: 'Threat Level (FHOB): Severe', metadata: { chunkIndex: 3 } }];
        const result = injectGlossary(chunks, glossary);
        expect(result[0].metadata).toEqual({ chunkIndex: 3 });
    });

    it('handles multiple referenced acronyms in one chunk', () => {
        const twoAcronymGlossary = [
            { acronym: 'FHOB', fullName: 'Federal Hero Oversight Bureau' },
            { acronym: 'SLF', fullName: 'Spark Liberation Front' },
        ];
        const chunks = [{ text: 'The FHOB investigated the SLF last year.', metadata: {} }];
        const result = injectGlossary(chunks, twoAcronymGlossary);
        expect(result[0].text).toBe(
            '[Glossary: FHOB = Federal Hero Oversight Bureau]\n[Glossary: SLF = Spark Liberation Front]\nThe FHOB investigated the SLF last year.'
        );
    });

    it('returns chunks unchanged when the glossary is empty', () => {
        const chunks = [{ text: 'Threat Level (FHOB): Severe', metadata: {} }];
        expect(injectGlossary(chunks, [])).toBe(chunks);
    });

    it('returns an empty array for non-array chunks input', () => {
        expect(injectGlossary(null, glossary)).toEqual([]);
        expect(injectGlossary(undefined, glossary)).toEqual([]);
    });
});


describe('reference-source grounding', () => {
    it('recognizes explicit transcript definitions, including lowercase expansions', () => {
        expect(extractGlossary('00:12 Speaker: FHOB stands for federal hero oversight bureau.')).toEqual([
            { acronym: 'FHOB', fullName: 'Federal hero oversight bureau' },
        ]);
        expect(extractGlossary('FHOB means Federal Hero Oversight Bureau.')).toHaveLength(1);
        expect(extractGlossary('FHOB means something unknown.')).toEqual([]);
    });

    it('isolates conflicting wiki definitions and preserves source offsets', () => {
        const text = '# First\nFederal Hero Oversight Bureau (FHOB).\nFHOB approves permits.\n# Second\nForeign Hero Operations Board (FHOB).\nFHOB rejects permits.';
        const sources = splitReferenceSources(text, 'wiki');
        expect(sources).toHaveLength(2);
        expect(text.slice(sources[1].start, sources[1].end)).toBe(sources[1].text);
        const result = groundReferenceChunks([
            { text: 'FHOB approves permits.', metadata: { pageTitle: 'First' } },
            { text: 'FHOB rejects permits.', metadata: { pageTitle: 'Second' } },
        ], text, 'wiki');
        expect(result[0].text).toContain('Federal Hero Oversight Bureau');
        expect(result[1].text).toContain('Foreign Hero Operations Board');
        expect(result[1].text).not.toContain('Federal Hero Oversight Bureau');
    });

    it('does not leak definitions into another wiki page or an unidentified mixed chunk', () => {
        const text = '# First\nFederal Hero Oversight Bureau (FHOB).\n# Second\nFHOB has an unknown meaning.';
        const chunks = [{ text: 'FHOB has an unknown meaning.', metadata: { pageTitle: 'Second' } }, { text: 'FHOB mixed chunk.' }];
        expect(groundReferenceChunks(chunks, text, 'wiki')).toEqual(chunks);
    });
});

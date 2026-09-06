/**
 * Unit tests for enrichChunks (core/content-vectorization.js)
 *
 * Focus: entryName resolution — specifically the wiki per_page path, where the
 * page title lives in chunk.metadata.pageTitle (set by prepareWikiContent) and
 * must surface as metadata.entryName so the Database Browser and the
 * hybrid-search title boost see a real title. Guards the precedence order:
 * lorebook entry names and Auto-Reformat record names always win over pageTitle.
 *
 * content-vectorization.js pulls in heavy SillyTavern host chains — every
 * direct dependency that reaches a host module is mocked by resolved path,
 * same convention as world-info-integration.test.js.
 */

import { describe, it, expect, vi } from 'vitest';

// --- SillyTavern host modules ---
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({})),
}));
vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat123'),
}));
vi.mock('../../../../utils.js', () => ({
    getStringHash: vi.fn((s) => `hash_${String(s).length}`),
}));

// --- internal chains enrichChunks never exercises ---
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
    getSavedHashes: vi.fn(),
}));
vi.mock('../core/collection-metadata.js', () => ({
    setCollectionMeta: vi.fn(),
    setCollectionLock: vi.fn(),
    setCollectionCharacterLock: vi.fn(),
    saveChunkMetadata: vi.fn(),
}));
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(),
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(),
}));
vi.mock('../core/collection-ids.js', () => ({
    buildLorebookCollectionId: vi.fn(),
    buildCharacterCollectionId: vi.fn(),
    buildDocumentCollectionId: vi.fn(),
    COLLECTION_PREFIXES: {},
    buildRegistryKey: vi.fn(),
    getBackendFromCollectionId: vi.fn(),
}));
vi.mock('../core/text-cleaning.js', () => ({
    cleanText: vi.fn((t) => t),
    cleanContentOrNull: vi.fn((t) => t),
    cleanWikiNoise: vi.fn((t) => t),
}));
vi.mock('../core/lorebook-content-preparer.js', () => ({
    prepareLorebookContent: vi.fn(),
}));
vi.mock('../core/glossary-extractor.js', () => ({
    extractGlossary: vi.fn(),
    injectGlossary: vi.fn(),
}));
vi.mock('../core/reformat-store.js', () => ({
    getReformatCache: vi.fn(() => null),
    recordReformatVectorization: vi.fn(),
    invalidateReformatCacheForCollections: vi.fn(() => ({ invalidated: 0, unlinked: 0 })),
    invalidateAllVectorizedReformatCaches: vi.fn(() => 0),
}));
vi.mock('../ui/progress-tracker.js', () => ({
    progressTracker: { start: vi.fn(), update: vi.fn(), finish: vi.fn() },
}));

// Keyword extraction is out of scope here — neutralize it so assertions only
// see entryName behavior, not stemming/stopword rules.
vi.mock('../core/keyword-boost.js', () => ({
    extractLorebookKeywords: vi.fn(() => []),
    extractTextKeywords: vi.fn(() => []),
    extractChatKeywords: vi.fn(() => []),
    extractBM25Keywords: vi.fn(() => []),
    EXTRACTION_LEVELS: {},
    DEFAULT_EXTRACTION_LEVEL: 'balanced',
    DEFAULT_BASE_WEIGHT: 1.5,
    dedupeKeywordsByStem: vi.fn((kws) => kws),
}));

import { enrichChunks } from '../core/content-vectorization.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SETTINGS = { keywordLevel: 'off' };
const SOURCE = { name: 'test-source' };

function enrichOne(chunk, contentType = 'wiki', preparedContent = {}) {
    const [result] = enrichChunks([chunk], contentType, SOURCE, SETTINGS, preparedContent, {});
    return result;
}

// ---------------------------------------------------------------------------
// entryName resolution
// ---------------------------------------------------------------------------

describe('enrichChunks — entryName from wiki pageTitle', () => {
    it('surfaces metadata.pageTitle as entryName for wiki per_page chunks', () => {
        const result = enrichOne({
            text: '# Brown Fur\n\nA character covered in brown fur.',
            metadata: { pageTitle: 'Brown Fur' },
        });
        expect(result.metadata.entryName).toBe('Brown Fur');
        expect(result.metadata.pageTitle).toBe('Brown Fur');
    });

    it('leaves entryName null when a wiki chunk has no pageTitle (combined strategy)', () => {
        const result = enrichOne({
            text: 'Combined wiki text without per-page metadata.',
            metadata: {},
        });
        expect(result.metadata.entryName).toBeNull();
    });

    it('lorebook entry names still win over a stray pageTitle', () => {
        const result = enrichOne(
            { text: 'Entry body.', metadata: { pageTitle: 'Should Not Win' } },
            'lorebook',
            { entries: [{ comment: 'Dragon Queen', content: 'Entry body.', uid: 7 }] },
        );
        expect(result.metadata.entryName).toBe('Dragon Queen');
        expect(result.metadata.entryUid).toBe(7);
    });

    it('Auto-Reformat record names still win over a stray pageTitle', () => {
        const result = enrichOne({
            text: 'Himbofication is a transformation process.',
            metadata: { entry_type: 'concept', name: 'Himbofication', pageTitle: 'Should Not Win' },
        });
        expect(result.metadata.entryName).toBe('Himbofication');
    });

    it('explicit entryName survives the metadata spread even when chunk metadata carries entryName: undefined', () => {
        const result = enrichOne({
            text: '# Titled Page\n\nBody.',
            metadata: { pageTitle: 'Titled Page', entryName: undefined },
        });
        expect(result.metadata.entryName).toBe('Titled Page');
    });
});


it('retains reformat provenance when preparing transcript chunks for retrieval', () => {
    const provenance = [{ sourceId: '0', start: 0, end: 100, granularity: 'batch', timestamps: ['00:30'] }];
    const result = enrichOne({
        text: 'Federal Hero Oversight Bureau (FHOB) permits are not valid unless renewed.',
        metadata: { entry_type: 'concept', name: 'Permits', sourceId: '0', provenance },
    }, 'youtube');
    expect(result.metadata.provenance).toEqual(provenance);
    expect(result.metadata.sourceId).toBe('0');
    expect(result.text).toContain('not valid unless renewed');
});

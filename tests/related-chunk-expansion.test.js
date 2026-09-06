import { describe, expect, it, vi } from 'vitest';
import { createRelatedChunkExpansion } from '../core/related-chunk-expansion.js';
import { createDebugData } from '../core/retrieval-diagnostics.js';

function fixture(read) {
    const getSavedHashes = vi.fn(read);
    const getChunkMetadata = vi.fn(() => null);
    const log = { warn: vi.fn() };
    return { getSavedHashes, getChunkMetadata, log,
        related: createRelatedChunkExpansion({ getSavedHashes, getChunkMetadata, log }) };
}
const snapshot = (...items) => ({ hashes: items.map(item => item.hash), metadata: items });
const chunk = (hash, metadata = {}) => ({ hash, collectionId: 'docs', text: `chunk ${hash}`, score: 0.8, metadata });

describe('Related-chunk expansion interface', () => {
    it('returns the original array when summaries need no lookup', async () => {
        const { related, getSavedHashes } = fixture();
        const chunks = [chunk(1)];
        expect(await related.expandSummaries(chunks, {}, createDebugData())).toBe(chunks);
        expect(await related.applyLinks(chunks, {}, createDebugData())).toEqual(chunks);
        expect(getSavedHashes).not.toHaveBeenCalled();
    });

    it('inherits summary score and parent metadata without mutating the source snapshot', async () => {
        const parent = { hash: 2, text: 'parent', score: 0.1, custom: { retained: true } };
        const { related } = fixture(async () => snapshot(parent));
        const debug = createDebugData();
        const result = await related.expandSummaries([chunk(1, { isSummary: true, parentHash: 2 })], {}, debug);
        expect(result[0]).toMatchObject({ hash: '2', score: 0.8, text: 'parent', metadata: {
            score: 0.1, custom: { retained: true }, originalSummaryHash: 1, originalSummaryScore: 0.8,
        } });
        expect(parent).not.toHaveProperty('expandedFromSummary');
        expect(debug.chunkFates['2'].stages[0]).toMatchObject({ stage: 'summary_expansion', fate: 'passed' });
    });

    it('reads again between phases, preserving snapshot invalidation and metadata changes', async () => {
        const { related, getSavedHashes } = fixture();
        getSavedHashes.mockResolvedValueOnce(snapshot({ hash: 2, text: 'parent', chunkLinks: [{ targetHash: '3', mode: 'force' }] }));
        getSavedHashes.mockResolvedValueOnce(snapshot({ hash: 3, text: 'new target', score: 0.2 }));
        const settings = {};
        const debug = createDebugData();
        const expanded = await related.expandSummaries([chunk(1, { isSummary: true, parentHash: 2 })], settings, debug);
        const linked = await related.applyLinks(expanded, settings, debug);
        expect(linked[1]).toMatchObject({ hash: 3, text: 'new target', score: 1, originalScore: 0.2 });
        expect(getSavedHashes.mock.calls).toEqual([['docs', settings, true], ['docs', settings, true]]);
    });

    it('retries a failed read in the next phase instead of caching the failure', async () => {
        const { related, getSavedHashes, log } = fixture();
        getSavedHashes.mockRejectedValueOnce(new Error('temporary failure'));
        getSavedHashes.mockResolvedValueOnce(snapshot({ hash: 3, text: 'recovered' }));
        const source = chunk(1, { isSummary: true, parentHash: 2, chunkLinks: [{ targetHash: '3', mode: 'force' }] });
        const debug = createDebugData();
        const expanded = await related.expandSummaries([source], {}, debug);
        expect(expanded).toEqual([source]);
        const linked = await related.applyLinks(expanded, {}, debug);
        expect(linked[1]).toMatchObject({ hash: 3, text: 'recovered' });
        expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps backend links authoritative, including empty arrays, and uses saved links when absent', async () => {
        const { related, getChunkMetadata, getSavedHashes } = fixture(async () => snapshot({ hash: 3, text: 'target' }));
        getChunkMetadata.mockReturnValue({ chunkLinks: [{ targetHash: '3', mode: 'force' }] });
        const empty = await related.applyLinks([chunk(1, { chunkLinks: [] })], {}, createDebugData());
        expect(empty.map(c => c.hash)).toEqual([1]);
        expect(getSavedHashes).not.toHaveBeenCalled();
        const fallback = await related.applyLinks([chunk(1)], {}, createDebugData());
        expect(fallback.map(c => c.hash)).toEqual([1, 3]);
    });
});

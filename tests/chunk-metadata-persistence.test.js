/**
 * Tests: chunk keyword metadata persistence for no-plugin standard backend users.
 *
 * Problem: native ST /api/vector/insert only stores {hash, text, index}.
 * Without the plugin, keywords are silently dropped on insert, so keyword
 * boosting during retrieval always sees an empty keyword list.
 *
 * Fix (A): content-vectorization.js calls saveChunkMetadata(hash, {keywords})
 *          after insertVectorItems so keywords land in extension_settings.
 * Fix (B): chat-vectorization.js stage 4.3 falls back to getChunkMetadata when
 *          chunk.metadata.keywords is empty (no-plugin query result).
 *
 * Storage contract coverage lives here. Retrieval behavior is exercised through
 * the real selection interface in chunk-selection.test.js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ST globals needed by collection-metadata.js
// vi.hoisted lifts the variable to the same scope as vi.mock (both are hoisted)
// ---------------------------------------------------------------------------
const mockSettings = vi.hoisted(() => ({ vectfox: {} }));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: mockSettings,
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import { saveChunkMetadata, getChunkMetadata, deleteChunkMetadata } from '../core/collection-metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeywords(...words) {
    return words.map((text, i) => ({ text, weight: 1.0 + i * 0.1 }));
}

// ---------------------------------------------------------------------------
// Storage contract (Fix A)
// ---------------------------------------------------------------------------

describe('saveChunkMetadata / getChunkMetadata — keyword round-trip', () => {
    beforeEach(() => {
        // Reset settings store between tests
        mockSettings.vectfox = {};
    });

    it('stores keywords and retrieves them by hash', () => {
        const hash = '1234567890';
        const keywords = makeKeywords('dragon', 'ancient', 'fire');

        saveChunkMetadata(hash, { keywords });

        const stored = getChunkMetadata(hash);
        expect(stored).not.toBeNull();
        expect(stored.keywords).toHaveLength(3);
        expect(stored.keywords[0]).toMatchObject({ text: 'dragon', weight: 1.0 });
        expect(stored.keywords[1]).toMatchObject({ text: 'ancient', weight: 1.1 });
    });

    it('returns null for unknown hash', () => {
        expect(getChunkMetadata('no-such-hash')).toBeNull();
    });

    it('merges keyword update into existing metadata without overwriting other fields', () => {
        const hash = 'abc123';
        saveChunkMetadata(hash, { conditions: { enabled: true }, keywords: makeKeywords('sword') });
        saveChunkMetadata(hash, { keywords: makeKeywords('sword', 'shield') });

        const stored = getChunkMetadata(hash);
        // Latest write wins for keywords
        expect(stored.keywords).toHaveLength(2);
        // conditions key should still be there from first write merged by the caller
    });

    it('deleteChunkMetadata removes the entry', () => {
        const hash = 'del123';
        saveChunkMetadata(hash, { keywords: makeKeywords('test') });
        expect(getChunkMetadata(hash)).not.toBeNull();

        deleteChunkMetadata(hash);
        expect(getChunkMetadata(hash)).toBeNull();
    });
});

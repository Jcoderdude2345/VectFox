import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ registry: [], metadata: {}, windows: { chat: true } }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: () => 'chat', chat_metadata: {}, saveSettingsDebounced: vi.fn(),
}));
vi.mock('../core/core-vector-api.js', () => ({ purgeVectorIndex: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({
    unregisterCollection: vi.fn(key => { state.registry = state.registry.filter(k => k !== key); }),
}));
vi.mock('../core/collection-metadata.js', () => ({
    deleteCollectionMeta: vi.fn(key => { delete state.metadata[key]; }),
}));
vi.mock('../core/eventbase-store.js', () => ({
    clearExtractionCachesForChat: vi.fn(uuid => { delete state.windows[uuid]; }),
}));

import { extension_settings } from '../../../../extensions.js';
import { purgeVectorIndex } from '../core/core-vector-api.js';
import { deleteCollectionMeta } from '../core/collection-metadata.js';
import { clearExtractionCachesForChat } from '../core/eventbase-store.js';
import { deleteCollection } from '../core/collection-removal.js';
import { getReformatCache, saveReformatCache, recordReformatVectorization } from '../core/reformat-store.js';

const id = 'vf_eventbase_standard_chat';
const key = `vectra:${id}`;
const otherId = 'vf_eventbase_qdrant_other';

beforeEach(() => {
    vi.clearAllMocks();
    purgeVectorIndex.mockReset().mockResolvedValue(true);
    deleteCollectionMeta.mockReset().mockImplementation(k => { delete state.metadata[k]; });
    clearExtractionCachesForChat.mockReset().mockImplementation(uuid => { delete state.windows[uuid]; });
    state.registry = [id, key, `standard:${id}`, `qdrant:${id}`];
    state.metadata = Object.fromEntries(state.registry.map(k => [k, { name: 'Collection' }]));
    state.windows = { chat: true };
    extension_settings.vectfox = {};
    saveReformatCache('source', { chunks: [{ text: 'accepted' }] });
    recordReformatVectorization('source', id);
});

describe('collection removal interface', () => {
    it.each([false, new Error('offline')])('preserves all local state on purge failure (%s)', async failure => {
        if (failure instanceof Error) purgeVectorIndex.mockRejectedValueOnce(failure);
        else purgeVectorIndex.mockResolvedValueOnce(failure);
        const before = structuredClone({ ...state, settings: extension_settings.vectfox });
        const result = await deleteCollection(id, { vector_backend: 'standard' }, key);
        expect(result).toMatchObject({ success: false, status: 'failed', vectorsDeleted: false });
        expect({ ...state, settings: extension_settings.vectfox }).toEqual(before);
    });

    it('removes canonical and legacy records, preserving another backend and shared freeze', async () => {
        recordReformatVectorization('source', otherId);
        const result = await deleteCollection(id, { vector_backend: 'qdrant' }, key);
        expect(result).toMatchObject({ success: true, status: 'removed', cachesDeleted: true });
        expect(state.registry).toEqual([`qdrant:${id}`]);
        expect(Object.keys(state.metadata)).toEqual([`qdrant:${id}`]);
        expect(state.windows).toEqual({});
        expect(getReformatCache('source').vectorizedInto).toEqual([otherId]);
        expect(purgeVectorIndex).toHaveBeenCalledWith(id, expect.objectContaining({ vector_backend: 'vectra' }));
    });

    it('invalidates the final vectorized copy', async () => {
        await deleteCollection(id, { vector_backend: 'standard' });
        expect(getReformatCache('source')).toBeNull();
    });

    it('attempts the remaining cleanup after metadata fails and permits retry', async () => {
        deleteCollectionMeta.mockImplementationOnce(() => { throw new Error('metadata unavailable'); });
        const result = await deleteCollection(id, { vector_backend: 'standard' }, key);
        expect(result).toMatchObject({ success: false, status: 'partial', vectorsDeleted: true, metadataDeleted: false, cachesDeleted: true });
        expect(result.errors).toContain('Metadata: metadata unavailable');
        expect(state.metadata[key]).toBeUndefined();
        expect(getReformatCache('source')).toBeNull();
        expect(state.windows).toEqual({});
        expect((await deleteCollection(id, { vector_backend: 'standard' }, key)).success).toBe(true);
        expect(state.metadata[id]).toBeUndefined();
    });

    it('reports cache cleanup failure and still cleans the other cache', async () => {
        clearExtractionCachesForChat.mockImplementationOnce(() => { throw new Error('cache unavailable'); });
        const result = await deleteCollection(id, { vector_backend: 'standard' }, key);
        expect(result).toMatchObject({ status: 'partial', cachesDeleted: false });
        expect(getReformatCache('source')).toBeNull();
        expect((await deleteCollection(id, { vector_backend: 'standard' }, key)).success).toBe(true);
        expect(state.windows).toEqual({});
    });

    it('uses a Qdrant registry key instead of current Standard settings', async () => {
        await deleteCollection('legacy', { vector_backend: 'standard', qdrant_multitenancy: true }, 'qdrant:legacy');
        expect(purgeVectorIndex).toHaveBeenCalledWith('legacy', expect.objectContaining({
            vector_backend: 'qdrant', qdrant_multitenancy: true,
        }));
    });

    it('rejects mismatched identity before touching either collection', async () => {
        const result = await deleteCollection(id, { vector_backend: 'standard' }, 'qdrant:another');
        expect(result.status).toBe('failed');
        expect(purgeVectorIndex).not.toHaveBeenCalled();
        expect(state.registry).toContain(key);
    });

    it('repeats removal when the backend confirms the already-absent collection', async () => {
        expect((await deleteCollection(id, { vector_backend: 'standard' }, key)).success).toBe(true);
        expect((await deleteCollection(id, { vector_backend: 'standard' }, key)).success).toBe(true);
    });
});

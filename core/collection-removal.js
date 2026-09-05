import { purgeVectorIndex } from './core-vector-api.js';
import { unregisterCollection } from './collection-loader.js';
import { deleteCollectionMeta } from './collection-metadata.js';
import { resolveBackendForCollection, buildRegistryKey, COLLECTION_PREFIXES } from './collection-ids.js';

/**
 * Remove a collection and its local records. A failed purge leaves local state
 * intact. After a confirmed purge, each cleanup is attempted independently.
 * Repeating removal is safe when the backend confirms deletion or absence;
 * ambiguous errors (including an unclassified 404) never authorize cleanup.
 *
 * The legacy loader export remains available to callers. Replacement/import
 * operations still use the lower-level purge operation.
 * @returns {Promise<{success: boolean, status: string, errors: string[], vectorsDeleted: boolean, registryDeleted: boolean, metadataDeleted: boolean, cachesDeleted: boolean}>}
 */
export async function deleteCollection(collectionId, settings = {}, registryKey = null) {
    const result = {
        success: false, status: 'failed', errors: [],
        vectorsDeleted: false, registryDeleted: false, metadataDeleted: false, cachesDeleted: false,
    };
    const fail = (step, error) => result.errors.push(`${step}: ${error?.message || error}`);
    const target = resolveBackendForCollection(registryKey || collectionId);
    const original = resolveBackendForCollection(collectionId);
    if (!target.collectionId || target.collectionId !== original.collectionId) {
        fail('Collection', 'Collection ID and registry key do not match');
        return result;
    }
    const backend = target.backend || settings.vector_backend;
    if (!backend) {
        fail('Collection', 'Cannot determine the collection backend');
        return result;
    }
    const routedSettings = { ...settings, vector_backend: backend };
    const id = target.collectionId;
    try {
        if (await purgeVectorIndex(id, routedSettings) !== true) {
            throw new Error('Backend did not confirm complete removal; local records were kept. Retry deletion.');
        }
        result.vectorsDeleted = true;
    } catch (error) {
        fail('Vectors', error);
        return result;
    }

    // Include legacy bare IDs and the Standard alias without touching another
    // backend's records for the same bare ID.
    const keys = new Set([id, buildRegistryKey(id, routedSettings), registryKey].filter(Boolean));
    if (backend === 'standard' || backend === 'vectra') keys.add(`standard:${id}`);
    const cleanup = async (step, work) => {
        try { await work(); } catch (error) { fail(step, error); }
    };
    let before = result.errors.length;
    for (const key of keys) await cleanup('Registry', () => unregisterCollection(key));
    result.registryDeleted = result.errors.length === before;
    before = result.errors.length;
    for (const key of keys) await cleanup('Metadata', () => deleteCollectionMeta(key));
    result.metadataDeleted = result.errors.length === before;
    before = result.errors.length;
    if (id.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE)) {
        await cleanup('EventBase cache', async () => {
            const { clearExtractionCachesForChat } = await import('./eventbase-store.js');
            const chatUUID = id.split('_').pop();
            if (chatUUID) clearExtractionCachesForChat(chatUUID);
        });
    }
    await cleanup('Auto-Reformat cache', async () => {
        const { invalidateReformatCacheForCollections } = await import('./reformat-store.js');
        invalidateReformatCacheForCollections([id]);
    });
    result.cachesDeleted = result.errors.length === before;
    result.success = result.errors.length === 0;
    result.status = result.success ? 'removed' : 'partial';
    return result;
}

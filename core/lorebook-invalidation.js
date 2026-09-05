/**
 * ============================================================================
 * VectFox LOREBOOK INVALIDATION
 * ============================================================================
 * Cross-extension re-index hook: lets lorebook-writing extensions tell VectFox
 * that a book's content changed on disk so its vector collection can be
 * refreshed.
 *
 * Why it matters: the vector store snapshots entries at vectorization time.
 * Injection staleness is already fixed by live-entry resolution
 * (world-info-integration.js resolveLiveEntries), but retrieval RANKING still
 * uses the snapshot — and entries created after vectorization have no vectors
 * at all, so they can never be retrieved. An agent that writes new lore every
 * few turns therefore needs this hook for semantic activation to keep up.
 *
 * Contract (consumed via `globalThis.vectfox_invalidateLorebook`):
 *   - create-or-refresh: unindexed books are vectorized fresh; indexed books
 *     are re-vectorized. Fatbody-owned campaign books are always ignored —
 *     Fatbody alone handles its books.
 *   - debounced per book (60s, resettable) so a burst of agent writes costs
 *     one re-index.
 *   - the collection is marked dirty immediately, so even with auto re-index
 *     disabled the Database Browser can surface staleness.
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { getCollectionRegistry, deleteCollection } from './collection-loader.js';
import { getCollectionMeta, setCollectionMeta } from './collection-metadata.js';
import { resolveBackendForCollection } from './collection-ids.js';
import { isFatbodyOwnedBook } from './fatbody-guard.js';
import { log } from './log.js';

export const REINDEX_DEBOUNCE_MS = 60_000;

/** @type {Map<string, ReturnType<typeof setTimeout>>} bookName → pending debounce timer */
const _timers = new Map();
/** @type {Set<string>} bookNames currently re-indexing (single-flight) */
const _inFlight = new Set();

/** Same sanitization the collection-ID builder applies to lorebook names. */
function _sanitizeLorebookName(name) {
    return String(name || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .substring(0, 50);
}

/**
 * Finds the registry key of an existing vf_lorebook_* collection for a book.
 * Mirrors world-info-integration.js _findLorebookRegistryEntry (registry scan —
 * exact IDs carry backend/handle/timestamp segments unknowable at lookup time).
 * @param {string} lorebookName
 * @returns {string|null}
 */
export function findLorebookRegistryKey(lorebookName) {
    const sanitizedName = _sanitizeLorebookName(lorebookName);
    if (!sanitizedName) return null;
    const nameNeedle = `_${sanitizedName}_`;

    for (const key of getCollectionRegistry()) {
        const id = String(key).includes(':') ? String(key).split(':').slice(1).join(':') : String(key);
        const idLower = id.toLowerCase();
        if (idLower.startsWith('vf_lorebook_') && idLower.includes(nameNeedle)) {
            return key;
        }
    }
    return null;
}

/**
 * Marks a lorebook's vector collection stale and schedules a debounced
 * re-index (or first-time vectorization). Safe to call on every book write.
 *
 * @param {string} bookName - SillyTavern lorebook (world) name
 * @param {{debounceMs?: number}} [opts] - test override for the debounce window
 * @returns {boolean} true if a re-index was scheduled
 */
export function invalidateLorebook(bookName, { debounceMs = REINDEX_DEBOUNCE_MS } = {}) {
    if (!bookName || typeof bookName !== 'string') return false;
    const settings = extension_settings.vectfox || {};

    // Fatbody-owned campaign books are always hands-off — never auto-vectorized
    // or re-indexed, even if a collection exists from an older VectFox version.
    if (isFatbodyOwnedBook(bookName)) return false;

    const registryKey = findLorebookRegistryKey(bookName);

    if (registryKey) {
        // Mark stale immediately — visible even when auto re-index is off/fails.
        try {
            setCollectionMeta(registryKey, { dirty: true, dirtyAt: new Date().toISOString() });
        } catch (e) {
            log.warn(`VectFox: could not mark collection dirty for "${bookName}":`, e.message);
        }
    }

    if (settings.auto_reindex_invalidated_lorebooks === false) {
        log.verbose(`VectFox: auto re-index disabled — "${bookName}" marked dirty only`);
        return false;
    }

    const pending = _timers.get(bookName);
    if (pending) clearTimeout(pending);
    _timers.set(bookName, setTimeout(() => {
        _timers.delete(bookName);
        reindexLorebookNow(bookName).catch(e =>
            log.warn(`VectFox: background re-index of "${bookName}" failed:`, e.message || e));
    }, debounceMs));

    log.verbose(`VectFox: re-index of "${bookName}" scheduled (${debounceMs}ms debounce)`);
    return true;
}

/**
 * Re-indexes a lorebook immediately: deletes the existing collection (if any),
 * preserving its scope/strategy/chunkSize, then vectorizes the book fresh.
 * Single-flight per book. Exported for tests and manual UI triggers.
 *
 * @param {string} bookName
 * @returns {Promise<boolean>} true when a fresh collection was created
 */
export async function reindexLorebookNow(bookName) {
    if (_inFlight.has(bookName)) return false;
    _inFlight.add(bookName);
    try {
        // Dynamic import: content-vectorization pulls in the chunking/UI stack —
        // keep it out of the load path of every module that imports this hook.
        const { vectorizeContent, resolveEffectiveSettings } = await import('./content-vectorization.js');

        // Carry forward how the book was originally vectorized.
        let carried = {};
        const registryKey = findLorebookRegistryKey(bookName);
        if (registryKey) {
            const meta = getCollectionMeta(registryKey);
            carried = {
                scope: meta.scope || 'character',
                ...(meta.settings?.strategy ? { strategy: meta.settings.strategy } : {}),
                ...(meta.settings?.chunkSize ? { chunkSize: meta.settings.chunkSize } : {}),
            };
            const { collectionId, backend } = resolveBackendForCollection(registryKey);
            if (backend) carried.vector_backend = backend;
            const removal = await deleteCollection(collectionId, resolveEffectiveSettings(carried), registryKey);
            if (!removal.success) {
                throw new Error(`Lorebook removal incomplete: ${removal.errors.join('; ')}`);
            }
        }

        await vectorizeContent({
            contentType: 'lorebook',
            source: { type: 'select', id: bookName, name: bookName },
            settings: resolveEffectiveSettings(carried),
        });

        log.lifecycle(`VectFox: re-indexed lorebook "${bookName}" after external change`);
        return true;
    } finally {
        _inFlight.delete(bookName);
    }
}

/**
 * Publishes the cross-extension global. Called once at extension init.
 * The wrapper never throws into the caller — a broken re-index must not be
 * able to break a Fatbody lore write.
 */
export function installLorebookInvalidationHook() {
    globalThis.vectfox_invalidateLorebook = (name) => {
        try {
            return invalidateLorebook(String(name || ''));
        } catch (e) {
            log.warn('VectFox: vectfox_invalidateLorebook failed:', e?.message || e);
            return false;
        }
    };
    log.lifecycle('VectFox: lorebook invalidation hook installed (vectfox_invalidateLorebook)');
}

/** Test helper: clears pending debounce timers without firing them. */
export function _clearPendingInvalidations() {
    for (const t of _timers.values()) clearTimeout(t);
    _timers.clear();
}

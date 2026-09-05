/**
 * ============================================================================
 * WIKI LIBRARY SERVICE
 * ============================================================================
 * DOM-free orchestrator for the Wiki Library: runs scrape tasks against the
 * incremental scraper primitives, persists every batch to the IndexedDB
 * store before the next request fires, feeds the in-memory search index, and
 * emits events both UI surfaces (the vectorizer's wiki section and the
 * Library modal) subscribe to — so they can never disagree about state.
 *
 * One task at a time: enumeration, content fetch, and fetch-everything share
 * a single activeTask slot. Two stop semantics ride on it:
 *   stopAndKeep()  flips the stopToken — primitives return normally, the
 *                  checkpoint is already persisted, nothing is lost
 *   cancelHard()   aborts the signal — in-flight request dies, but batches
 *                  persisted before the abort REMAIN in the library (the
 *                  legacy all-or-nothing loss is gone either way)
 *
 * Events: 'task-status' {task|null}, 'pages-added' {libraryId, records},
 * 'pages-fetched' {libraryId, records}, 'library-updated' {library},
 * 'basket-changed' {count}.
 *
 * @module wikiLibraryService
 */

import { getStringHash } from '../../../../utils.js';
import {
    discoverApiEndpoint,
    enumeratePagesWithMetadata,
    fetchPageContents,
    enumerateE621Pages,
    searchE621ByTitle,
    resolveE621Base,
    buildApiCandidates,
    WikiScrapeError,
    WIKI_SCRAPER_TIMINGS,
} from './wiki-scraper.js';
import {
    pageKey,
    upsertLibrary,
    getLibrary,
    listLibraries,
    deleteLibrary,
    putPages,
    getPages,
    getPagesByLibrary,
    updatePageContents,
    basketAdd,
    basketRemove,
    basketClear,
    basketList,
    estimateUsage,
    isStoreAvailable,
    WikiLibraryError,
} from './wiki-library-store.js';
import { createWikiIndex } from './wiki-search-index.js';
import { log } from './log.js';
import { shouldFallbackToPlugin, regexFromString, scrapeWiki } from './wiki-scraper.js';
import { fetchPluginWiki, wikiSourceName } from './wiki-plugin.js';

// e621's wiki-page id space (~120k) at 320/request — the fetch-everything
// confirm dialog needs a number before the first walk has counted anything
const E621_WALK_REQUEST_ESTIMATE = Math.ceil(120000 / 320);

// ---------------------------------------------------------------------------
// Event emitter
// ---------------------------------------------------------------------------

const listeners = new Map();

/**
 * @param {string} event
 * @param {Function} handler
 * @returns {Function} Unsubscribe
 */
export function on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
}

function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
        try {
            handler(payload);
        } catch (error) {
            log.error('[WikiLibrary] Event handler failed:', event, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Index lifecycle
// ---------------------------------------------------------------------------

let index = null;
let indexLoadPromise = null;

/**
 * Builds the in-memory index from IndexedDB once per SillyTavern session.
 * @returns {Promise<ReturnType<typeof createWikiIndex>>}
 */
export async function ensureIndexLoaded() {
    if (index) {
        return index;
    }
    if (!indexLoadPromise) {
        indexLoadPromise = (async () => {
            const fresh = createWikiIndex();
            const libraries = await listLibraries();
            for (const library of libraries) {
                const records = await getPagesByLibrary(library.id);
                fresh.addDocs(records);
            }
            index = fresh;
            return fresh;
        })();
        indexLoadPromise.catch(() => { indexLoadPromise = null; });
    }
    return indexLoadPromise;
}

/** Search over the loaded index (loads it on first use). */
export async function search(options) {
    const idx = await ensureIndexLoaded();
    return idx.search(options ?? {});
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

/** @type {{libraryId: string, kind: string, abortController: AbortController, stopToken: {stopped: boolean}, phase: string, done: number, total: number|null}|null} */
let activeTask = null;

export function getActiveTask() {
    return activeTask;
}

export function isBusy() {
    return activeTask !== null;
}

/** Graceful stop: keep everything persisted so far, checkpoint for resume. */
export function stopAndKeep() {
    if (activeTask) {
        activeTask.stopToken.stopped = true;
    }
}

/** Hard cancel: abort in-flight requests (persisted batches remain). */
export function cancelHard() {
    if (activeTask) {
        activeTask.abortController.abort();
    }
}

function updateTaskProgress(phase, done, total) {
    if (activeTask) {
        activeTask.phase = phase;
        activeTask.done = done;
        activeTask.total = total ?? null;
        emit('task-status', { task: { ...activeTask } });
    }
}

async function withTask(kind, libraryId, work) {
    if (activeTask) {
        throw new WikiLibraryError('busy', 'Another Wiki Library task is already running — stop it first.');
    }
    activeTask = {
        libraryId,
        kind,
        abortController: new AbortController(),
        stopToken: { stopped: false },
        phase: 'starting',
        done: 0,
        total: null,
    };
    emit('task-status', { task: { ...activeTask } });
    try {
        const result = await work(activeTask);
        if (activeTask.abortController.signal.aborted) throw new WikiScrapeError('aborted', 'Wiki acquisition cancelled');
        return result;
    } catch (error) {
        if (activeTask.abortController.signal.aborted) throw new WikiScrapeError('aborted', 'Wiki acquisition cancelled');
        throw error;
    } finally {
        activeTask = null;
        emit('task-status', { task: null });
    }
}

// ---------------------------------------------------------------------------
// Library identity
// ---------------------------------------------------------------------------

/**
 * Derives the stable library id + display name from the RESOLVED endpoint,
 * not the user's input — so one wiki reached via different URL spellings
 * always maps to the same library.
 */
/**
 * Whether a library has interrupted enumeration worth resuming. A checkpoint
 * of `null` legitimately means "resume from the beginning" (e.g. Stop & Keep
 * fired while the first 500-page window was still streaming in, before any
 * continuation cursor existed) — so `checkpoint != null` alone would hide
 * Resume for exactly the pages-were-kept-but-window-1-incomplete case.
 * titleCount > 0 catches that: enumeration touched the library but never
 * finished it.
 *
 * @param {WikiLibrary} library
 * @returns {boolean}
 */
export function isResumable(library) {
    return !!library && !library.enumComplete
        && (library.checkpoint != null || (library.titleCount ?? 0) > 0);
}

export function deriveLibraryIdentity(wikiType, apiUrl) {
    if (wikiType === 'e621') {
        const host = new URL(apiUrl).hostname;
        return { id: `e621:${host}`, name: 'e621-wiki' };
    }
    const url = new URL(apiUrl);
    if (wikiType === 'fandom') {
        const fandomId = url.hostname.split('.')[0];
        return { id: `fandom:${fandomId}`, name: fandomId };
    }
    const path = url.pathname.replace(/\/api\.php$/, '').replace(/\/+$/, '');
    return { id: `mediawiki:${url.hostname}${path}`, name: url.hostname };
}

// ---------------------------------------------------------------------------
// Enumeration (titles + metadata; e621 walks arrive with content)
// ---------------------------------------------------------------------------

/**
 * Applies putPages stats + checkpoint to the library row and re-emits it.
 */
async function persistBatch(library, records, { checkpoint, enumComplete, stats }) {
    const updated = await upsertLibrary({
        id: library.id,
        titleCount: (library.titleCount ?? 0) + stats.added,
        fetchedCount: (library.fetchedCount ?? 0) + stats.fetchedDelta,
        bytesApprox: (library.bytesApprox ?? 0) + stats.bytesDelta,
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(enumComplete !== undefined ? { enumComplete } : {}),
        lastError: '',
    });
    Object.assign(library, updated);
    emit('library-updated', { library: { ...updated } });
    if (records.length > 0) {
        emit('pages-added', { libraryId: library.id, records });
    }
    return updated;
}

async function runMediaWikiEnumeration(library, { filter, signal, stopToken }) {
    const idx = await ensureIndexLoaded();
    const resumeContinue = !library.enumComplete && library.checkpoint ? library.checkpoint : undefined;

    const result = await enumeratePagesWithMetadata(library.apiUrl, {
        resumeContinue,
        filter,
        signal,
        stopToken,
        onBatch: async (records, checkpoint) => {
            const full = records.map(r => ({ ...r, libraryId: library.id, key: pageKey(library.id, r.title) }));
            const stats = await putPages(full);
            await persistBatch(library, full, {
                checkpoint: checkpoint.continue,
                enumComplete: checkpoint.complete,
                stats,
            });
            idx.addDocs(full);
        },
        onProgress: (p) => updateTaskProgress('titles', p.done, p.total),
    });

    return { count: result.count, stopped: result.stopped, complete: !result.stopped && result.continue === null };
}

async function runE621Enumeration(library, { signal, stopToken, rememberPages }) {
    const idx = await ensureIndexLoaded();
    const base = new URL(library.apiUrl).origin;
    const resumeCursor = !library.enumComplete && Number.isFinite(library.checkpoint)
        ? library.checkpoint
        : undefined;

    const result = await enumerateE621Pages({
        url: base,
        resumeCursor,
        signal,
        stopToken,
        onBatch: async (records, cursor) => {
            rememberPages?.(records);
            const full = records.map(r => ({
                ...r,
                libraryId: library.id,
                key: pageKey(library.id, r.title),
                url: `${base}/wiki_pages/show_or_new?title=${encodeURIComponent(r.title)}`,
            }));
            const stats = await putPages(full);
            await persistBatch(library, full, { checkpoint: cursor, stats });
            idx.addDocs(full);
        },
        onProgress: (p) => updateTaskProgress('titles', p.done, p.total),
    });

    if (result.done) {
        const updated = await upsertLibrary({ id: library.id, enumComplete: true });
        Object.assign(library, updated);
        emit('library-updated', { library: { ...updated } });
    }
    return { count: result.count, stopped: result.stopped, complete: result.done };
}

async function runEnumeration(library, { filter, signal, stopToken, rememberPages }) {
    try {
        return library.wikiType === 'e621'
            ? await runE621Enumeration(library, { signal, stopToken, rememberPages })
            : await runMediaWikiEnumeration(library, { filter, signal, stopToken });
    } catch (error) {
        // Quota mid-scrape = implicit Stop & Keep: the checkpoint and every
        // batch before this one are already persisted
        if (error instanceof WikiLibraryError && error.code === 'quota') {
            await upsertLibrary({ id: library.id, lastError: error.message });
            emit('library-updated', { library: { ...(await getLibrary(library.id)) } });
            return { count: 0, stopped: true, complete: false, quota: true };
        }
        if (!(error instanceof WikiScrapeError && error.code === 'aborted')) {
            await upsertLibrary({ id: library.id, lastError: error?.message ?? String(error) })
                .catch(() => { /* storage may be the thing that failed */ });
        }
        throw error;
    }
}

/**
 * Starts (or resumes, when a checkpoint exists) title/metadata enumeration
 * for a wiki, creating its library row on first contact.
 *
 * @param {object} options
 * @param {string} options.wikiType - 'fandom' | 'mediawiki' | 'e621'
 * @param {string} options.url - Wiki URL/id as typed by the user
 * @param {string} [options.filter] - Optional title regex applied while indexing
 * @returns {Promise<{libraryId: string, count: number, stopped: boolean, complete: boolean}>}
 */
export async function startEnumeration(options) {
    return acquireWiki({ ...options, kind: 'index' });
}

/** One task spans discovery, enumeration, content acquisition and fallback. */
export async function acquireWiki({ wikiType, url, filter, kind = 'index', confirmFullDownload, persistent = true }) {
    return withTask(kind, null, async task => {
        const signal = task.abortController.signal;
        const retainedPages = new Map();
        const titleFilter = filter ? regexFromString(String(filter)) : null;
        const rememberPages = pages => pages.forEach(p => {
            const content = p.plaintext ?? p.content;
            if (content && (!titleFilter || new RegExp(titleFilter).test(p.title + '\n'))) {
                retainedPages.set(p.title, { title: p.title, content });
            }
        });
        const options = { signal, stopToken: task.stopToken, rememberPages };
        const check = () => {
            if (signal.aborted) throw new WikiScrapeError('aborted', 'Wiki acquisition cancelled');
        };
        let library;
        const unsavedResult = () => ({
            libraryId: library?.id, stopped: true, saved: false,
            source: shapeWikiSource([...retainedPages.values()], { wikiType, url, name: library?.name || wikiSourceName(url, wikiType) }),
            warning: 'Some fetched content was not saved. These pages remain usable for this session; previously saved pages were kept.',
        });
        try {
            if (!persistent) {
                const pages = await scrapeWiki({ wikiType, url, filter, signal,
                    onProgress: p => updateTaskProgress(p.phase, p.done, p.total) });
                check();
                return { source: shapeWikiSource(pages, { wikiType, url, name: wikiSourceName(url, wikiType) }),
                    saved: false, warning: 'Not saved: the Wiki Library is unavailable. Content is usable for this session.' };
            }
            await ensureIndexLoaded();
            check();
            const apiUrl = wikiType === 'e621' ? resolveE621Base(url)
                : await discoverApiEndpoint(wikiType, url, { signal });
            check();
            const identity = deriveLibraryIdentity(wikiType, apiUrl);
            task.libraryId = identity.id;
            library = await upsertLibrary({ id: identity.id, wikiType, inputUrl: url ?? '', apiUrl, name: identity.name });
            check();
            emit('library-updated', { library: { ...library } });
            const result = await runEnumeration(library, { ...options, filter });
            check();
            if (result.quota && retainedPages.size) return unsavedResult();
            let fetched = {};
            if (kind === 'full' && wikiType !== 'e621' && !result.stopped) {
                const records = await getPagesByLibrary(library.id);
                rememberPages(records.filter(r => r.contentFetched));
                check();
                fetched = await runContentFetch(library.id, records.filter(r => !r.contentFetched).map(r => r.key), options);
            }
            check();
            const source = kind === 'full' || wikiType === 'e621'
                ? await materializeWikiSource(library.id, filter) : null;
            check();
            return { libraryId: library.id, ...result, ...fetched, source, saved: true };
        } catch (error) {
            check();
            if (error instanceof WikiLibraryError && retainedPages.size) return unsavedResult();
            if (wikiType === 'e621' || !shouldFallbackToPlugin(error) || task.stopToken.stopped) throw error;
            if (kind !== 'full') {
                const consent = await confirmFullDownload?.();
                check();
                if (!consent) return { libraryId: library?.id, stopped: true, declined: true };
            }
            if (task.stopToken.stopped) return { libraryId: library?.id, stopped: true, declined: true };
            updateTaskProgress('plugin', 0, null);
            const pages = await fetchPluginWiki({ wikiType, url, filter, signal });
            check();
            const source = shapeWikiSource(pages, { wikiType, url, name: wikiSourceName(url, wikiType) });
            if (!source.pageCount) throw new Error('No content found');
            let saved = true;
            let warning;
            let libraryId = library?.id;
            try {
                if (!persistent) throw new Error('Wiki Library unavailable');
                const persisted = await ingestPluginPages(wikiType, url, source.pages, { signal });
                libraryId = persisted.libraryId;
            } catch (error) {
                check();
                saved = false;
                warning = 'Not saved to the Wiki Library. These pages are available for this session only.';
                log.warn('[WikiLibrary] Plugin content retained in memory:', error);
            }
            check();
            return { libraryId, source, saved, warning, stopped: task.stopToken.stopped, plugin: true };
        }
    });
}

function shapeWikiSource(pages, { wikiType, url, name }) {
    pages = (pages ?? []).filter(p => p?.title && p?.content).map(p => ({ title: String(p.title), content: String(p.content) }));
    const content = pages.map(p => `# ${p.title.trim()}\n\n${p.content.trim()}`).join('\n\n---\n\n');
    return { type: 'wiki', wikiType, url, name, pages, pageCount: pages.length, content };
}

export async function materializeWikiSource(libraryId, filter) {
    const library = await getLibrary(libraryId);
    if (!library) return null;
    const regex = filter ? regexFromString(String(filter)) : undefined;
    const records = await getPagesByLibrary(libraryId, { fetchedOnly: true });
    return shapeWikiSource(records.filter(r => r.plaintext && (!regex || new RegExp(regex).test(r.title + '\n')))
        .map(r => ({ title: r.title, content: r.plaintext })),
        { wikiType: library.wikiType, url: library.inputUrl, name: library.name });
}
/**
 * Resumes enumeration of an existing library from its stored checkpoint.
 * @param {string} libraryId
 */
export async function resumeEnumeration(libraryId) {
    return withTask('enumerate', libraryId, async (task) => {
        await ensureIndexLoaded();
        const library = await getLibrary(libraryId);
        if (!library) {
            throw new WikiLibraryError('storage', `Unknown library: ${libraryId}`);
        }
        task.abortController.signal.throwIfAborted();

        const result = await runEnumeration(library, {
            signal: task.abortController.signal,
            stopToken: task.stopToken,
        });
        return { libraryId, ...result };
    });
}

// ---------------------------------------------------------------------------
// Content fetching
// ---------------------------------------------------------------------------

async function runContentFetch(libraryId, keys, { signal, stopToken, rememberPages }) {
    const idx = await ensureIndexLoaded();
    const library = await getLibrary(libraryId);
    if (!library) {
        throw new WikiLibraryError('storage', `Unknown library: ${libraryId}`);
    }
    const records = (await getPages(keys)).filter(r => !r.contentFetched);
    if (records.length === 0) {
        return { fetched: 0, stopped: false };
    }
    if (library.wikiType === 'e621') {
        // e621 pages are born fetched; anything unfetched here is a ghost
        log.warn(`[WikiLibrary] ${records.length} unfetched e621 pages — skipping (bodies arrive with enumeration)`);
        return { fetched: 0, stopped: false };
    }

    const titles = records.map(r => r.title);
    let fetched = 0;
    const result = await fetchPageContents(library.apiUrl, titles, {
        signal,
        stopToken,
        onBatch: async (pages) => {
            rememberPages?.(pages);
            const updates = pages.map(p => ({
                key: pageKey(libraryId, p.title),
                content: p.content,
                plaintext: p.plaintext,
            }));
            const stats = await updatePageContents(updates);
            fetched += stats.updated;
            const updatedLibrary = await upsertLibrary({
                id: libraryId,
                fetchedCount: (library.fetchedCount ?? 0) + stats.fetchedDelta,
                bytesApprox: (library.bytesApprox ?? 0) + stats.bytesDelta,
            });
            Object.assign(library, updatedLibrary);
            emit('library-updated', { library: { ...updatedLibrary } });

            const fresh = await getPages(updates.map(u => u.key));
            for (const record of fresh) {
                idx.updateDoc(record);
            }
            emit('pages-fetched', { libraryId, records: fresh });
        },
        onProgress: (p) => updateTaskProgress('content', p.done, p.total),
    });

    return { fetched, stopped: result.stopped };
}

/**
 * Fetches content for specific pages (basket entries, browser selection),
 * grouped per source library. Supports Stop & Keep mid-run.
 *
 * @param {string[]} keys - Page keys (`libraryId::title`)
 * @returns {Promise<{fetched: number, stopped: boolean}>}
 */
export async function fetchContentForKeys(keys) {
    const byLibrary = new Map();
    for (const key of keys ?? []) {
        const libraryId = key.split('::')[0];
        if (!byLibrary.has(libraryId)) {
            byLibrary.set(libraryId, []);
        }
        byLibrary.get(libraryId).push(key);
    }
    return withTask('fetch', [...byLibrary.keys()].join(','), async (task) => {
        let fetched = 0;
        for (const [libraryId, libraryKeys] of byLibrary) {
            if (task.stopToken.stopped) {
                return { fetched, stopped: true };
            }
            const result = await runContentFetch(libraryId, libraryKeys, {
                signal: task.abortController.signal,
                stopToken: task.stopToken,
            });
            fetched += result.fetched;
            if (result.stopped) {
                return { fetched, stopped: true };
            }
        }
        return { fetched, stopped: false };
    });
}

/**
 * The persistent successor of the legacy "Scrape Wiki" button: enumerate
 * whatever is left to enumerate, then fetch content for every unfetched page.
 *
 * @param {string} libraryId
 * @returns {Promise<{libraryId: string, enumerated: number, fetched: number, stopped: boolean}>}
 */
export async function fetchEverything(libraryId) {
    return withTask('full', libraryId, async (task) => {
        await ensureIndexLoaded();
        const library = await getLibrary(libraryId);
        if (!library) {
            throw new WikiLibraryError('storage', `Unknown library: ${libraryId}`);
        }
        task.abortController.signal.throwIfAborted();

        let enumerated = 0;
        if (!library.enumComplete) {
            const enumResult = await runEnumeration(library, {
                signal: task.abortController.signal,
                stopToken: task.stopToken,
            });
            enumerated = enumResult.count;
            if (enumResult.stopped) {
                return { libraryId, enumerated, fetched: 0, stopped: true };
            }
        }
        const unfetched = (await getPagesByLibrary(libraryId)).filter(r => !r.contentFetched);
        if (unfetched.length === 0 || library.wikiType === 'e621') {
            return { libraryId, enumerated, fetched: 0, stopped: false };
        }
        const result = await runContentFetch(libraryId, unfetched.map(r => r.key), {
            signal: task.abortController.signal,
            stopToken: task.stopToken,
        });
        return { libraryId, enumerated, fetched: result.fetched, stopped: result.stopped };
    });
}

/**
 * Rough cost preview for fetchEverything — feeds the confirm dialog shown
 * before an e621 full walk (hundreds of requests at ~1/s).
 *
 * @param {string} libraryId
 * @returns {Promise<{titleCount: number, unfetchedCount: number, requests: number, estMs: number}>}
 */
export async function estimateFullWalk(libraryId) {
    const library = await getLibrary(libraryId);
    // Fall back to the id prefix when the library doesn't exist yet (the
    // caller previews the cost of a wiki's FIRST walk, before startEnumeration
    // has created its row) — otherwise the e621 estimate silently reads as
    // "0 requests" and the cost-confirm dialog never appears.
    const wikiType = library?.wikiType ?? libraryId.split(':')[0];
    if (wikiType === 'e621') {
        const requests = library?.enumComplete ? 0 : E621_WALK_REQUEST_ESTIMATE;
        return {
            titleCount: library?.titleCount ?? 0,
            unfetchedCount: 0,
            requests,
            estMs: requests * WIKI_SCRAPER_TIMINGS.e621DelayMs,
        };
    }
    const pages = library ? await getPagesByLibrary(libraryId) : [];
    const unfetchedCount = pages.filter(r => !r.contentFetched).length;
    const requests = Math.ceil(unfetchedCount / 50);
    return {
        titleCount: library?.titleCount ?? 0,
        unfetchedCount,
        requests,
        estMs: requests * WIKI_SCRAPER_TIMINGS.batchDelayMs,
    };
}

// ---------------------------------------------------------------------------
// Plugin-fallback ingestion
// ---------------------------------------------------------------------------

/**
 * Lands pages scraped via the external Fandom Scraper server plugin in the
 * library, so the fallback path is no longer a persistence dead end. Plugin
 * pages arrive already converted to plaintext with no metadata.
 *
 * @param {string} wikiType - 'fandom' | 'mediawiki'
 * @param {string} url - The user's wiki URL/id input
 * @param {Array<{title: string, content: string}>} pages
 * @returns {Promise<{libraryId: string, count: number}>}
 */
export async function ingestPluginPages(wikiType, url, pages, { signal } = {}) {
    signal?.throwIfAborted();
    const idx = await ensureIndexLoaded();
    const apiUrl = buildApiCandidates(wikiType, url)[0];
    const identity = deriveLibraryIdentity(wikiType, apiUrl);

    const library = await upsertLibrary({
        id: identity.id,
        wikiType,
        inputUrl: url ?? '',
        apiUrl,
        name: identity.name,
        origin: 'plugin',
    });

    const records = (pages ?? [])
        .filter(p => p?.title && p?.content)
        .map(p => ({
            libraryId: library.id,
            key: pageKey(library.id, p.title),
            title: p.title,
            url: '',
            categories: [],
            sizeBytes: p.content.length,
            touched: 0,
            content: p.content,
            plaintext: p.content,
            contentFetched: true,
        }));
    signal?.throwIfAborted();
    const stats = await putPages(records);
    signal?.throwIfAborted();
    await persistBatch(library, records, { stats });
    idx.addDocs(records);
    return { libraryId: library.id, count: records.length };
}

// ---------------------------------------------------------------------------
// e621 quick lookup (exact title, no walk)
// ---------------------------------------------------------------------------

/**
 * Server-side exact-title lookup on e621/e926, storing hits straight into
 * the e621 library — the "I want ONE page without a 300-request walk" path.
 *
 * @param {string} url - '' for e621.net, or an e621/e926 URL
 * @param {string} title - Exact page title
 * @returns {Promise<{libraryId: string, records: Array<object>}>}
 */
export async function quickLookupE621(url, title) {
    const idx = await ensureIndexLoaded();
    const base = resolveE621Base(url);
    const identity = deriveLibraryIdentity('e621', base);

    const found = await searchE621ByTitle(base, title);
    const library = await upsertLibrary({
        id: identity.id,
        wikiType: 'e621',
        inputUrl: url ?? '',
        apiUrl: base,
        name: identity.name,
    });
    const records = found.map(r => ({
        ...r,
        libraryId: library.id,
        key: pageKey(library.id, r.title),
        url: `${base}/wiki_pages/show_or_new?title=${encodeURIComponent(r.title)}`,
    }));
    const stats = await putPages(records);
    await persistBatch(library, records, { stats });
    idx.addDocs(records);
    return { libraryId: library.id, records };
}

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

async function emitBasketChanged() {
    const rows = await basketList();
    emit('basket-changed', { count: rows.length });
    return rows;
}

/** @param {string[]} keys - Page keys to add */
export async function addToBasket(keys) {
    const records = await getPages(keys ?? []);
    await basketAdd(records.map(r => ({ pageKey: r.key, libraryId: r.libraryId, title: r.title })));
    return emitBasketChanged();
}

/** @param {string[]} keys - Page keys to remove */
export async function removeFromBasket(keys) {
    await basketRemove(keys ?? []);
    return emitBasketChanged();
}

export async function clearBasket() {
    await basketClear();
    return emitBasketChanged();
}

/** @returns {Promise<import('./wiki-library-store.js').BasketRow[]>} */
export async function getBasket() {
    return basketList();
}

/**
 * Materializes the basket into the vectorizer's wiki sourceData shape.
 *
 * Determinism matters here: basket rows are sorted by (libraryId, title), so
 * the same selection ALWAYS yields byte-identical combinedContent no matter
 * what order pages were added in — which keeps the Auto-Reformat freeze
 * (keyed by a hash of the prepared text) stable across sessions.
 *
 * @returns {Promise<{pages: Array<{title: string, content: string}>, combinedContent: string, pageCount: number, name: string, libraryIds: string[], unfetchedKeys: string[], selectionDescriptor: string}>}
 */
export async function materializeBasket() {
    const rows = await basketList();
    const records = await getPages(rows.map(r => r.pageKey));

    const unfetchedKeys = records.filter(r => !r.contentFetched).map(r => r.key);
    const fetched = records.filter(r => r.contentFetched && r.plaintext);
    const pages = fetched.map(r => ({ title: r.title, content: r.plaintext }));
    // Exact joiner of the legacy scrape path (content-vectorizer.js) so
    // prepareWikiContent and the reformat hash treat both sources identically
    const combinedContent = pages.map(page =>
        `# ${String(page.title).trim()}\n\n${String(page.content).trim()}`
    ).join('\n\n---\n\n');

    const libraryIds = [...new Set(records.map(r => r.libraryId))];
    let name = 'wiki-basket';
    if (libraryIds.length === 1) {
        name = (await getLibrary(libraryIds[0]))?.name || name;
    }

    const selectionDescriptor = records
        .map(r => `${r.key}:${getStringHash(r.plaintext ?? '')}`)
        .join('|');

    return {
        pages,
        combinedContent,
        pageCount: pages.length,
        name,
        libraryIds,
        unfetchedKeys,
        selectionDescriptor,
    };
}

// ---------------------------------------------------------------------------
// Maintenance / passthroughs (single import surface for the UI)
// ---------------------------------------------------------------------------

/**
 * Deletes a library everywhere: store (cascading to pages + basket rows),
 * in-memory index, and notifies subscribers.
 */
export async function removeLibrary(libraryId) {
    const result = await deleteLibrary(libraryId);
    if (index) {
        index.removeLibrary(libraryId);
    }
    emit('library-updated', { library: null, deletedId: libraryId });
    await emitBasketChanged();
    return result;
}

export { getLibrary, listLibraries, getPages, getPagesByLibrary, estimateUsage, isStoreAvailable, pageKey, WikiLibraryError };

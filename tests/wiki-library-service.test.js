/**
 * Unit tests for core/wiki-library-service.js
 *
 * End-to-end over fake-indexeddb + fetch mocks: enumeration must persist
 * every batch and checkpoint BEFORE the next request (so stop/cancel/crash
 * never lose retrieved pages), Stop & Keep must resume where it left off,
 * hard cancel must keep already-persisted batches, and materializeBasket
 * must be deterministic regardless of basket add-order (the Auto-Reformat
 * freeze hash depends on it).
 *
 * Module state (index cache, active task, listeners) is reset between tests
 * via vi.resetModules(); the fake-indexeddb global is wiped explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));
// SillyTavern's string hash — a tiny deterministic stand-in is enough
vi.mock('../../../../utils.js', () => ({
    getStringHash: (str) => {
        let hash = 0;
        for (let i = 0; i < String(str).length; i++) {
            hash = ((hash << 5) - hash + String(str).charCodeAt(i)) | 0;
        }
        return hash;
    },
}));

let svc, store, scraper;

beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    store = await import('../core/wiki-library-store.js');
    await store._deleteDatabaseForTests();
    scraper = await import('../core/wiki-scraper.js');
    Object.assign(scraper.WIKI_SCRAPER_TIMINGS, {
        enumDelayMs: 0,
        batchDelayMs: 0,
        rateLimitDefaultMs: 0,
        rateLimitMaxDelayMs: 0,
        discoverTimeoutMs: 1000,
        e621DelayMs: 0,
    });
    svc = await import('../core/wiki-library-service.js');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
    };
}

const SITEINFO = { query: { general: { sitename: 'Test Wiki' } } };

describe('Wiki acquisition lifecycle', () => {
    it('keeps downloaded browser content when the content write fails', async () => {
        installMediaWikiMock();
        vi.spyOn(store, 'updatePageContents').mockRejectedValueOnce(new store.WikiLibraryError('quota', 'Full'));
        const result = await svc.acquireWiki({ wikiType: 'fandom', url: 'testwiki', kind: 'full' });
        expect(result).toMatchObject({ stopped: true, saved: false });
        expect(result.source.pages.map(p => p.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(result.warning).toContain('not saved');
        expect((await store.getPagesByLibrary(result.libraryId)).length).toBe(3);
    });

    it('downloads content after explicit titles-fallback consent', async () => {
        vi.stubGlobal('fetch', pluginFetch());
        const consent = vi.fn(async () => true);
        const result = await svc.acquireWiki({ wikiType: 'fandom', url: 'testwiki', kind: 'index', confirmFullDownload: consent });
        expect(consent).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ saved: true, plugin: true, source: { pages } });
    });

    const pages = [{ title: 'Kept', content: 'Useful content' }];
    function pluginFetch(gate) {
        return vi.fn(async (url) => {
            if (String(url).includes('/probe')) return jsonResponse({});
            if (String(url).includes('/scrape')) {
                if (gate) await gate;
                return jsonResponse(pages);
            }
            throw new TypeError('Browser blocked');
        });
    }

    it('holds the task during discovery and does not escalate titles without consent', async () => {
        const fetchMock = pluginFetch();
        vi.stubGlobal('fetch', fetchMock);
        const confirm = vi.fn(async () => {
            expect(svc.isBusy()).toBe(true);
            await expect(svc.startEnumeration({ wikiType: 'fandom', url: 'other' })).rejects.toMatchObject({ code: 'busy' });
            return false;
        });
        const result = await svc.acquireWiki({ wikiType: 'fandom', url: 'testwiki', kind: 'index', confirmFullDownload: confirm });
        expect(confirm).toHaveBeenCalledOnce();
        expect(result.declined).toBe(true);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/scrape'))).toBe(false);
        expect(svc.isBusy()).toBe(false);
    });

    it('keeps plugin content usable with an explicit warning when persistence fails', async () => {
        vi.stubGlobal('fetch', pluginFetch());
        vi.spyOn(store, 'putPages').mockRejectedValueOnce(new store.WikiLibraryError('quota', 'Full'));
        const result = await svc.acquireWiki({ wikiType: 'fandom', url: 'testwiki', kind: 'full' });
        expect(result.saved).toBe(false);
        expect(result.warning).toContain('Not saved');
        expect(result.source.pages).toEqual(pages);
        expect(result.source.content).toBe('# Kept\n\nUseful content');
    });

    it.each(['stop', 'cancel'])('%s during plugin acquisition keeps the shared task until it settles', async action => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const fetchMock = pluginFetch(gate);
        vi.stubGlobal('fetch', fetchMock);
        const run = svc.acquireWiki({ wikiType: 'fandom', url: 'testwiki', kind: 'full' });
        const outcome = run.then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/scrape'))).toBe(true));
        expect(svc.isBusy()).toBe(true);
        if (action === 'cancel') svc.cancelHard(); else svc.stopAndKeep();
        expect(svc.isBusy()).toBe(true);
        release();
        const result = await outcome;
        if (action === 'cancel') {
            expect(result.error).toMatchObject({ code: 'aborted' });
            expect(await store.listLibraries()).toEqual([]);
        } else {
            expect(result.value).toMatchObject({ stopped: true, saved: true, source: { pages } });
        }
        expect(svc.isBusy()).toBe(false);
    });
});

function gpage(pageid, title, categories = [], length = 100) {
    return {
        pageid, ns: 0, title, length,
        touched: '2024-01-01T00:00:00Z',
        fullurl: `https://testwiki.fandom.com/wiki/${title}`,
        ...(categories.length ? { categories: categories.map(c => ({ ns: 14, title: `Category:${c}` })) } : {}),
    };
}

/**
 * MediaWiki mock: siteinfo probe, two-window generator enumeration
 * (window 1: Alpha+Beta, gapcontinue; window 2: Gamma, complete), and
 * revisions content for any requested titles. `gate` (optional) delays the
 * window-2 response until released — used to hold a task open.
 */
function installMediaWikiMock({ gate } = {}) {
    const fetchMock = vi.fn(async (url) => {
        const params = new URL(url).searchParams;
        if (params.get('meta') === 'siteinfo') {
            return jsonResponse(SITEINFO);
        }
        if (params.get('generator') === 'allpages') {
            if (params.get('gapcontinue') === 'Gamma') {
                if (gate) {
                    await gate.promise;
                }
                return jsonResponse({ query: { pages: { 3: gpage(3, 'Gamma', ['Characters'], 55) } } });
            }
            return jsonResponse({
                continue: { gapcontinue: 'Gamma', continue: 'gapcontinue||' },
                query: { pages: {
                    1: gpage(1, 'Alpha', ['Characters', 'Companions']),
                    2: gpage(2, 'Beta', ['Locations']),
                } },
            });
        }
        if (params.get('prop') === 'revisions') {
            const titles = params.get('titles').split('|');
            const pages = {};
            titles.forEach((title, i) => {
                pages[String(i + 1)] = {
                    pageid: i + 1, ns: 0, title,
                    revisions: [{ slots: { main: { '*': `'''${title}''' body text` } } }],
                };
            });
            return jsonResponse({ query: { pages } });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const LIB = 'fandom:testwiki';

describe('startEnumeration (MediaWiki)', () => {
    it('persists every batch + checkpoint, updates the index, and completes', async () => {
        installMediaWikiMock();
        const added = [];
        const libraryEvents = [];
        svc.on('pages-added', (e) => added.push(e.records.map(r => r.title)));
        svc.on('library-updated', (e) => e.library && libraryEvents.push({ checkpoint: e.library.checkpoint, enumComplete: e.library.enumComplete }));

        const result = await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });

        expect(result).toMatchObject({ libraryId: LIB, count: 3, stopped: false, complete: true });
        expect(added).toEqual([['Alpha', 'Beta'], ['Gamma']]);

        const library = await svc.getLibrary(LIB);
        expect(library).toMatchObject({
            wikiType: 'fandom',
            apiUrl: 'https://testwiki.fandom.com/api.php',
            name: 'testwiki',
            titleCount: 3,
            fetchedCount: 0,
            enumComplete: true,
            checkpoint: null,
        });

        // Mid-run, the window-1 checkpoint was persisted before window 2 ran
        expect(libraryEvents.some(e =>
            e.checkpoint?.gapcontinue === 'Gamma' && e.enumComplete === false)).toBe(true);

        // Stored pages carry metadata; index is queryable immediately
        const alpha = await store.getPage(store.pageKey(LIB, 'Alpha'));
        expect(alpha.categories).toEqual(['Characters', 'Companions']);
        expect(alpha.url).toBe('https://testwiki.fandom.com/wiki/Alpha');
        expect(alpha.contentFetched).toBe(0);

        const { keys } = await svc.search({ query: 'gam' });
        expect(keys).toEqual([store.pageKey(LIB, 'Gamma')]);
    });

    it('Stop & Keep persists a checkpoint and resumeEnumeration finishes without duplicates', async () => {
        installMediaWikiMock();
        const off = svc.on('pages-added', () => {
            svc.stopAndKeep();
            off();
        });

        const stopped = await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        expect(stopped).toMatchObject({ count: 2, stopped: true, complete: false });

        let library = await svc.getLibrary(LIB);
        expect(library.enumComplete).toBe(false);
        expect(library.checkpoint).toEqual({ gapcontinue: 'Gamma', continue: 'gapcontinue||' });
        expect(library.titleCount).toBe(2);

        const resumed = await svc.resumeEnumeration(LIB);
        expect(resumed).toMatchObject({ count: 1, stopped: false, complete: true });

        library = await svc.getLibrary(LIB);
        expect(library.titleCount).toBe(3);
        expect(library.enumComplete).toBe(true);
        expect((await store.getPagesByLibrary(LIB)).map(p => p.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('hard cancel throws aborted but keeps batches persisted before the abort', async () => {
        installMediaWikiMock();
        const off = svc.on('pages-added', () => {
            svc.cancelHard();
            off();
        });

        await expect(svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' }))
            .rejects.toMatchObject({ code: 'aborted' });

        // The legacy behavior (cancel discards everything) is gone:
        expect((await store.getPagesByLibrary(LIB)).map(p => p.title).sort()).toEqual(['Alpha', 'Beta']);
        expect(svc.getActiveTask()).toBeNull();
    });

    it('rejects a second task while one is running (busy), then completes the first', async () => {
        let release;
        const gate = { promise: new Promise(r => { release = r; }) };
        installMediaWikiMock({ gate });

        const firstBatch = new Promise(resolve => {
            const off = svc.on('pages-added', () => { off(); resolve(); });
        });
        const running = svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        await firstBatch;

        await expect(svc.resumeEnumeration(LIB)).rejects.toMatchObject({ code: 'busy' });

        release();
        const result = await running;
        expect(result.complete).toBe(true);
    });
});

describe('fetchContentForKeys', () => {
    it('fetches content for selected pages, updates counters and full-text index', async () => {
        installMediaWikiMock();
        await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });

        const keys = [store.pageKey(LIB, 'Alpha'), store.pageKey(LIB, 'Gamma')];
        const fetchedEvents = [];
        svc.on('pages-fetched', (e) => fetchedEvents.push(...e.records.map(r => r.title)));

        const result = await svc.fetchContentForKeys(keys);
        expect(result).toEqual({ fetched: 2, stopped: false });
        expect(fetchedEvents.sort()).toEqual(['Alpha', 'Gamma']);

        const alpha = await store.getPage(store.pageKey(LIB, 'Alpha'));
        expect(alpha.contentFetched).toBe(1);
        expect(alpha.content).toBe("'''Alpha''' body text");
        expect(alpha.plaintext).toBe('Alpha body text');

        const library = await svc.getLibrary(LIB);
        expect(library.fetchedCount).toBe(2);
        expect(library.bytesApprox).toBeGreaterThan(0);

        // Fetched pages joined full-text scope; Beta (unfetched) did not
        const { keys: hits } = await svc.search({ query: 'body text', mode: 'fulltext' });
        expect(hits.sort()).toEqual(keys.sort());
    });

    it('skips already-fetched pages instead of re-downloading', async () => {
        installMediaWikiMock();
        await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        await svc.fetchContentForKeys([store.pageKey(LIB, 'Alpha')]);

        const again = await svc.fetchContentForKeys([store.pageKey(LIB, 'Alpha')]);
        expect(again).toEqual({ fetched: 0, stopped: false });
    });
});

describe('fetchEverything', () => {
    it('enumerates whatever is left, then fetches all unfetched content', async () => {
        installMediaWikiMock();
        const result = await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        expect(result.complete).toBe(true);

        const full = await svc.fetchEverything(LIB);
        expect(full).toMatchObject({ libraryId: LIB, enumerated: 0, fetched: 3, stopped: false });

        const pages = await store.getPagesByLibrary(LIB, { fetchedOnly: true });
        expect(pages).toHaveLength(3);
    });

    it('estimateFullWalk reports remaining work', async () => {
        installMediaWikiMock();
        await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        const estimate = await svc.estimateFullWalk(LIB);
        expect(estimate.titleCount).toBe(3);
        expect(estimate.unfetchedCount).toBe(3);
        expect(estimate.requests).toBe(1);
    });

    it('estimateFullWalk reports the e621 corpus-walk cost even before the library exists (first walk)', async () => {
        // Regression: the confirm dialog is shown by the CALLER based on
        // estimate.requests > 0, computed BEFORE startEnumeration creates the
        // library row — the id-prefix fallback must still say "this is e621".
        const estimate = await svc.estimateFullWalk('e621:e621.net');
        expect(estimate.requests).toBeGreaterThan(0);
        expect(estimate.titleCount).toBe(0);
    });
});

describe('isResumable', () => {
    it('is false for a library with no library row', () => {
        expect(svc.isResumable(null)).toBe(false);
    });

    it('is false once enumeration is complete', () => {
        expect(svc.isResumable({ enumComplete: true, checkpoint: { gapcontinue: 'X' }, titleCount: 5 })).toBe(false);
    });

    it('is true with an explicit continuation checkpoint', () => {
        expect(svc.isResumable({ enumComplete: false, checkpoint: { gapcontinue: 'X' }, titleCount: 2 })).toBe(true);
    });

    it('is true when checkpoint is null but pages were already kept (Stop & Keep mid-first-window)', () => {
        // The scenario the bug fix targets: a stop before any continuation
        // cursor existed persists checkpoint=null, not an object.
        expect(svc.isResumable({ enumComplete: false, checkpoint: null, titleCount: 2 })).toBe(true);
    });

    it('is false for a brand-new, never-enumerated library', () => {
        expect(svc.isResumable({ enumComplete: false, checkpoint: null, titleCount: 0 })).toBe(false);
    });
});

describe('e621 enumeration', () => {
    function e6page(id, title, body) {
        return { id, title, body, is_deleted: false, updated_at: '2024-06-01T00:00:00Z', category_id: 5 };
    }

    it('persists cursor checkpoints and stores pages born content-fetched', async () => {
        const batch1 = Array.from({ length: 320 }, (_, i) => e6page(1000 - i, `tag_${1000 - i}`, `Body ${i}.`));
        const batch2 = [e6page(500, 'tag_500', 'Last body.')];
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([batch1, batch2][call++] ?? [])));

        const checkpoints = [];
        svc.on('library-updated', (e) => e.library && checkpoints.push(e.library.checkpoint));

        const result = await svc.startEnumeration({ wikiType: 'e621', url: '' });
        expect(result).toMatchObject({ libraryId: 'e621:e621.net', count: 321, complete: true });

        const library = await svc.getLibrary('e621:e621.net');
        expect(library.enumComplete).toBe(true);
        expect(library.titleCount).toBe(321);
        expect(library.fetchedCount).toBe(321);
        expect(checkpoints).toContain(681); // batch-1 cursor persisted mid-run

        const page = await store.getPage(store.pageKey('e621:e621.net', 'tag_500'));
        expect(page.contentFetched).toBe(1);
        expect(page.categories).toEqual(['species']);
        expect(page.url).toContain('/wiki_pages/show_or_new?title=tag_500');
    });
});

describe('quickLookupE621', () => {
    it('stores exact-title hits without a walk', async () => {
        const fetchMock = vi.fn(async () => jsonResponse([
            { id: 5, title: 'bimbo', body: 'The literal page.', is_deleted: false, category_id: 0 },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const { libraryId, records } = await svc.quickLookupE621('', 'bimbo');
        expect(libraryId).toBe('e621:e621.net');
        expect(records).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('search[title]')).toBe('bimbo');

        const page = await store.getPage(store.pageKey('e621:e621.net', 'bimbo'));
        expect(page.contentFetched).toBe(1);
        expect((await svc.search({ query: 'bimbo' })).keys).toHaveLength(1);
    });
});

describe('ingestPluginPages', () => {
    it('lands plugin-fallback results in a library as fetched pages', async () => {
        const { libraryId, count } = await svc.ingestPluginPages('fandom', 'testwiki', [
            { title: 'Alpha', content: 'Alpha plaintext from plugin.' },
            { title: '', content: 'skipped' },
        ]);
        expect(libraryId).toBe(LIB);
        expect(count).toBe(1);

        const library = await svc.getLibrary(LIB);
        expect(library.origin).toBe('plugin');
        expect(library.fetchedCount).toBe(1);

        const page = await store.getPage(store.pageKey(LIB, 'Alpha'));
        expect(page.contentFetched).toBe(1);
        expect(page.plaintext).toBe('Alpha plaintext from plugin.');
    });
});

describe('basket + materializeBasket', () => {
    async function seedTwoLibraries() {
        await store.upsertLibrary({ id: 'fandom:bg3', wikiType: 'fandom', name: 'bg3', apiUrl: 'https://bg3.fandom.com/api.php' });
        await store.upsertLibrary({ id: 'e621:e621.net', wikiType: 'e621', name: 'e621-wiki', apiUrl: 'https://e621.net' });
        await store.putPages([
            { libraryId: 'fandom:bg3', title: 'Astarion', content: 'raw', plaintext: 'Astarion is a vampire spawn.', contentFetched: true },
            { libraryId: 'fandom:bg3', title: 'Gale', content: 'raw', plaintext: 'Gale is a wizard.', contentFetched: true },
            { libraryId: 'e621:e621.net', title: 'himbofication', content: 'raw', plaintext: 'Male bimbofication.', contentFetched: true },
            { libraryId: 'fandom:bg3', title: 'Unfetched Page' },
        ]);
    }

    it('add order does not change combinedContent or selectionDescriptor', async () => {
        await seedTwoLibraries();
        const k = (lib, title) => store.pageKey(lib, title);
        const orderA = [k('e621:e621.net', 'himbofication'), k('fandom:bg3', 'Gale'), k('fandom:bg3', 'Astarion')];
        const orderB = [k('fandom:bg3', 'Astarion'), k('e621:e621.net', 'himbofication'), k('fandom:bg3', 'Gale')];

        await svc.addToBasket(orderA);
        const first = await svc.materializeBasket();
        await svc.clearBasket();
        await svc.addToBasket(orderB);
        const second = await svc.materializeBasket();

        expect(first.combinedContent).toBe(second.combinedContent);
        expect(first.selectionDescriptor).toBe(second.selectionDescriptor);
        // Deterministic (libraryId, title) order
        expect(first.pages.map(p => p.title)).toEqual(['himbofication', 'Astarion', 'Gale']);
        expect(first.combinedContent).toContain('# Astarion\n\nAstarion is a vampire spawn.');
        expect(first.pageCount).toBe(3);
        expect(first.name).toBe('wiki-basket');
        expect(first.libraryIds.sort()).toEqual(['e621:e621.net', 'fandom:bg3']);
    });

    it('reports unfetched keys and excludes them from pages', async () => {
        await seedTwoLibraries();
        await svc.addToBasket([
            store.pageKey('fandom:bg3', 'Astarion'),
            store.pageKey('fandom:bg3', 'Unfetched Page'),
        ]);
        const basket = await svc.materializeBasket();
        expect(basket.unfetchedKeys).toEqual([store.pageKey('fandom:bg3', 'Unfetched Page')]);
        expect(basket.pages.map(p => p.title)).toEqual(['Astarion']);
        // Single-library basket takes the library name
        expect(basket.name).toBe('bg3');
    });

    it('emits basket-changed with the live count', async () => {
        await seedTwoLibraries();
        const counts = [];
        svc.on('basket-changed', (e) => counts.push(e.count));

        await svc.addToBasket([store.pageKey('fandom:bg3', 'Astarion'), store.pageKey('fandom:bg3', 'Gale')]);
        await svc.removeFromBasket([store.pageKey('fandom:bg3', 'Gale')]);
        await svc.clearBasket();
        expect(counts).toEqual([2, 1, 0]);
    });
});

describe('removeLibrary', () => {
    it('cascades store deletion, drops index docs, and prunes the basket', async () => {
        installMediaWikiMock();
        await svc.startEnumeration({ wikiType: 'fandom', url: 'testwiki' });
        await svc.addToBasket([store.pageKey(LIB, 'Alpha')]);

        const counts = [];
        svc.on('basket-changed', (e) => counts.push(e.count));
        await svc.removeLibrary(LIB);

        expect(await svc.getLibrary(LIB)).toBeNull();
        expect((await svc.search({})).total).toBe(0);
        expect(counts).toEqual([0]);
    });
});

describe('deriveLibraryIdentity', () => {
    it('normalizes on the resolved endpoint', () => {
        expect(svc.deriveLibraryIdentity('fandom', 'https://fallout.fandom.com/api.php'))
            .toEqual({ id: 'fandom:fallout', name: 'fallout' });
        expect(svc.deriveLibraryIdentity('mediawiki', 'https://example.com/w/api.php'))
            .toEqual({ id: 'mediawiki:example.com/w', name: 'example.com' });
        expect(svc.deriveLibraryIdentity('mediawiki', 'https://example.com/api.php'))
            .toEqual({ id: 'mediawiki:example.com', name: 'example.com' });
        expect(svc.deriveLibraryIdentity('e621', 'https://e926.net'))
            .toEqual({ id: 'e621:e926.net', name: 'e621-wiki' });
    });
});

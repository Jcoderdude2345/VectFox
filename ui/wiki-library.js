/**
 * ============================================================================
 * WIKI LIBRARY MODAL
 * ============================================================================
 * The browsing/curation surface over everything the wiki scraper has ever
 * retrieved: search and facet-filter indexed pages, select single pages or
 * whole categories, fetch content on demand, build the cross-wiki selection
 * basket that feeds vectorization/Auto-Reformat, and manage storage.
 *
 * Follows the database-browser modal pattern: module-level state with an
 * isOpen guard, modal built once, fadeIn/fadeOut, mousedown/touchstart
 * stopPropagation (SillyTavern closes drawers on those events).
 *
 * All page titles/categories are remote-controlled strings — every dynamic
 * node is built with .text(), never string-concatenated HTML.
 *
 * @module wikiLibraryUI
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import * as wikiLibrary from '../core/wiki-library-service.js';
import { SIZE_BUCKETS } from '../core/wiki-search-index.js';

// ============================================================================
// STATE
// ============================================================================

const libraryState = {
    isOpen: false,
    activeTab: 'pages',
    libraryFilter: 'all',
    query: '',
    mode: 'title',          // 'title' | 'fulltext'
    categories: new Set(),
    sizeBuckets: new Set(),
    fetched: undefined,     // undefined | true | false
    shownLimit: 200,
    selected: new Set(),    // page keys ticked in the Pages tab
    categoriesExpanded: false,
    basketKeys: new Set(),
    unsubs: [],
    refreshQueued: false,
};

const PAGE_SLICE = 200;

function formatBytes(n) {
    const value = Number(n) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

export async function openWikiLibrary() {
    if (libraryState.isOpen) {
        return;
    }
    libraryState.isOpen = true;
    try {
        if ($('#vectfox_wiki_library_modal').length === 0) {
            createLibraryModal();
            bindModalEvents();
        }
        subscribeServiceEvents();

        // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
        $('#vectfox_wiki_library_modal').on('mousedown touchstart', function(e) {
            e.stopPropagation();
        });

        await refreshBasketKeys();
        await refreshLibraryDropdown();
        renderTaskStrip(wikiLibrary.getActiveTask());
        await renderActiveTab();

        $('#vectfox_wiki_library_modal').fadeIn(200);
    } catch (err) {
        libraryState.isOpen = false;
        throw err;
    }
}

export function closeWikiLibrary() {
    $('#vectfox_wiki_library_modal').fadeOut(200);
    libraryState.isOpen = false;
    for (const unsub of libraryState.unsubs) {
        try { unsub(); } catch { /* gone */ }
    }
    libraryState.unsubs = [];
}

function subscribeServiceEvents() {
    const scheduleRefresh = () => {
        if (libraryState.refreshQueued || !libraryState.isOpen) {
            return;
        }
        libraryState.refreshQueued = true;
        setTimeout(async () => {
            libraryState.refreshQueued = false;
            if (libraryState.isOpen) {
                await renderActiveTab();
            }
        }, 500);
    };
    libraryState.unsubs.push(wikiLibrary.on('pages-added', scheduleRefresh));
    libraryState.unsubs.push(wikiLibrary.on('pages-fetched', scheduleRefresh));
    libraryState.unsubs.push(wikiLibrary.on('library-updated', async () => {
        if (libraryState.isOpen) {
            await refreshLibraryDropdown();
            scheduleRefresh();
        }
    }));
    libraryState.unsubs.push(wikiLibrary.on('basket-changed', async () => {
        if (libraryState.isOpen) {
            await refreshBasketKeys();
            updateBasketTabLabel();
            if (libraryState.activeTab !== 'pages') {
                scheduleRefresh();
            } else {
                await renderActiveTab();
            }
        }
    }));
    libraryState.unsubs.push(wikiLibrary.on('task-status', ({ task }) => {
        if (libraryState.isOpen) {
            renderTaskStrip(task);
            if (!task) {
                scheduleRefresh();
            }
        }
    }));
}

// ============================================================================
// MODAL SHELL
// ============================================================================

function createLibraryModal() {
    const modalHtml = `
        <div id="vectfox_wiki_library_modal" class="vectfox-modal">
            <div class="vectfox-modal-content vectfox-wl-content">
                <div class="vectfox-modal-header">
                    <h3><i class="fa-solid fa-book-open"></i> Wiki Library</h3>
                    <button class="vectfox-btn-icon" id="vectfox_wl_close">✕</button>
                </div>

                <!-- Running-task strip -->
                <div class="vectfox-wl-task-strip" id="vectfox_wl_task_strip" style="display: none;">
                    <span id="vectfox_wl_task_text"></span>
                    <span class="vectfox-wl-task-actions">
                        <button id="vectfox_wl_stop_keep" class="vectfox-btn-secondary" title="Stop now but keep everything retrieved so far.">
                            <i class="fa-solid fa-hand"></i> Stop &amp; Keep
                        </button>
                        <button id="vectfox_wl_cancel" class="vectfox-btn-danger" title="Abort the current request. Saved pages are kept.">
                            <i class="fa-solid fa-stop"></i> Cancel
                        </button>
                    </span>
                </div>

                <div class="vectfox-wl-tabs">
                    <button class="vectfox-wl-tab-btn active" data-wl-tab="pages">
                        <i class="fa-solid fa-file-lines"></i> Pages
                    </button>
                    <button class="vectfox-wl-tab-btn" data-wl-tab="basket" id="vectfox_wl_basket_tab">
                        <i class="fa-solid fa-basket-shopping"></i> Basket
                    </button>
                    <button class="vectfox-wl-tab-btn" data-wl-tab="storage">
                        <i class="fa-solid fa-database"></i> Storage
                    </button>
                </div>

                <div class="vectfox-modal-body vectfox-wl-body">
                    <!-- Pages tab -->
                    <div class="vectfox-wl-tab-content active" data-wl-panel="pages">
                        <div class="vectfox-wl-filter-row">
                            <select id="vectfox_wl_library_filter" class="vectfox-select" title="Limit the list to one wiki"></select>
                            <input type="text" id="vectfox_wl_query" class="vectfox-input"
                                   placeholder="Search titles… (wrap in /slashes/ for regex)" autocomplete="off">
                            <label class="vectfox-wl-mode-toggle" title="Full-text searches inside page content — only pages whose content has been fetched are in scope.">
                                <input type="checkbox" id="vectfox_wl_fulltext_toggle"> Full-text
                            </label>
                        </div>
                        <div class="vectfox-wl-facets" id="vectfox_wl_facets"></div>
                        <div class="vectfox-wl-toolbar">
                            <button id="vectfox_wl_select_all" class="vectfox-btn-sm" title="Select every page matching the current search + filters">Select all (filtered)</button>
                            <button id="vectfox_wl_select_none" class="vectfox-btn-sm">None</button>
                            <span class="vectfox-wl-toolbar-sep"></span>
                            <button id="vectfox_wl_basket_add" class="vectfox-btn-sm" title="Add the selected pages to the basket"><i class="fa-solid fa-basket-shopping"></i> Add selected to basket</button>
                            <button id="vectfox_wl_fetch_selected" class="vectfox-btn-sm" title="Download content for the selected pages"><i class="fa-solid fa-download"></i> Fetch content for selected</button>
                            <span class="vectfox-wl-toolbar-sep"></span>
                            <button id="vectfox_wl_fetch_everything" class="vectfox-btn-sm" title="Download content for every unfetched page of the selected wiki"><i class="fa-solid fa-cloud-arrow-down"></i> Fetch everything</button>
                        </div>
                        <div class="vectfox-wl-quick-lookup" id="vectfox_wl_quick_lookup_row">
                            <i class="fa-solid fa-bolt"></i>
                            <input type="text" id="vectfox_wl_quick_lookup" class="vectfox-input"
                                   placeholder="e621 quick lookup — exact tag title (no full walk needed)" autocomplete="off">
                            <button id="vectfox_wl_quick_lookup_btn" class="vectfox-btn-sm">Look up</button>
                        </div>
                        <div class="vectfox-wl-list" id="vectfox_wl_pages_list"></div>
                        <div class="vectfox-wl-list-footer">
                            <span id="vectfox_wl_pages_stats"></span>
                            <button id="vectfox_wl_show_more" class="vectfox-btn-sm" style="display: none;">Show more</button>
                        </div>
                    </div>

                    <!-- Basket tab -->
                    <div class="vectfox-wl-tab-content" data-wl-panel="basket">
                        <div class="vectfox-wl-toolbar">
                            <button id="vectfox_wl_basket_use" class="vectfox-btn-primary" title="Hand the basket to the Content Vectorizer as the wiki source"><i class="fa-solid fa-bolt"></i> Use basket in Vectorizer</button>
                            <button id="vectfox_wl_basket_fetch_missing" class="vectfox-btn-sm"><i class="fa-solid fa-download"></i> Fetch missing content</button>
                            <span class="vectfox-wl-toolbar-sep"></span>
                            <button id="vectfox_wl_basket_clear" class="vectfox-btn-sm vectfox-btn-danger-outline">Clear basket</button>
                        </div>
                        <div class="vectfox-wl-basket-totals" id="vectfox_wl_basket_totals"></div>
                        <div class="vectfox-wl-list" id="vectfox_wl_basket_list"></div>
                    </div>

                    <!-- Storage tab -->
                    <div class="vectfox-wl-tab-content" data-wl-panel="storage">
                        <div class="vectfox-wl-list" id="vectfox_wl_storage_list"></div>
                        <div class="vectfox-wl-storage-footer" id="vectfox_wl_storage_footer"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
    $('body').append(modalHtml);
}

function bindModalEvents() {
    $('#vectfox_wl_close').on('click', closeWikiLibrary);
    $('#vectfox_wl_stop_keep').on('click', () => wikiLibrary.stopAndKeep());
    $('#vectfox_wl_cancel').on('click', () => wikiLibrary.cancelHard());

    $('.vectfox-wl-tab-btn').on('click', async function() {
        $('.vectfox-wl-tab-btn').removeClass('active');
        $(this).addClass('active');
        libraryState.activeTab = $(this).data('wl-tab');
        $('.vectfox-wl-tab-content').removeClass('active');
        $(`.vectfox-wl-tab-content[data-wl-panel="${libraryState.activeTab}"]`).addClass('active');
        await renderActiveTab();
    });

    // Pages tab controls
    let queryDebounce;
    $('#vectfox_wl_query').on('input', function() {
        clearTimeout(queryDebounce);
        queryDebounce = setTimeout(async () => {
            libraryState.query = $(this).val();
            libraryState.shownLimit = PAGE_SLICE;
            await renderPagesTab();
        }, 200);
    });
    $('#vectfox_wl_fulltext_toggle').on('change', async function() {
        libraryState.mode = this.checked ? 'fulltext' : 'title';
        libraryState.shownLimit = PAGE_SLICE;
        await renderPagesTab();
    });
    $('#vectfox_wl_library_filter').on('change', async function() {
        libraryState.libraryFilter = $(this).val();
        libraryState.shownLimit = PAGE_SLICE;
        await renderPagesTab();
    });
    $('#vectfox_wl_show_more').on('click', async () => {
        libraryState.shownLimit += PAGE_SLICE;
        await renderPagesTab();
    });

    $('#vectfox_wl_select_all').on('click', async () => {
        const { keys } = await wikiLibrary.search({ ...currentSearchOptions(), limit: undefined, offset: 0 });
        for (const key of keys) {
            libraryState.selected.add(key);
        }
        await renderPagesTab();
    });
    $('#vectfox_wl_select_none').on('click', async () => {
        libraryState.selected.clear();
        await renderPagesTab();
    });
    $('#vectfox_wl_basket_add').on('click', async () => {
        if (libraryState.selected.size === 0) {
            toastr.info('Select some pages first');
            return;
        }
        await wikiLibrary.addToBasket([...libraryState.selected]);
        toastr.success(`Added ${libraryState.selected.size} page(s) to the basket`, 'VectFox');
    });
    $('#vectfox_wl_fetch_selected').on('click', async () => {
        if (libraryState.selected.size === 0) {
            toastr.info('Select some pages first');
            return;
        }
        await runGuarded(() => wikiLibrary.fetchContentForKeys([...libraryState.selected]),
            (r) => `Fetched content for ${r.fetched} page(s)${r.stopped ? ' (stopped early — everything fetched so far is kept)' : ''}`);
    });
    $('#vectfox_wl_fetch_everything').on('click', async () => {
        const libraryId = libraryState.libraryFilter;
        if (libraryId === 'all') {
            toastr.info('Pick a specific wiki in the dropdown first');
            return;
        }
        const estimate = await wikiLibrary.estimateFullWalk(libraryId);
        // requests, not unfetchedCount: an e621 wiki not yet walked reports
        // unfetchedCount=0 (its cost is in the corpus WALK, not per-page
        // fetches) but still needs the confirm — requests covers both cases.
        if (estimate.requests > 4) {
            const detail = estimate.unfetchedCount > 0
                ? `content for <b>${estimate.unfetchedCount.toLocaleString()}</b> pages (~${estimate.requests} requests)`
                : `the full wiki corpus (~${estimate.requests} requests, several minutes)`;
            const confirmed = await callGenericPopup(
                `<p>This will download ${detail}.</p><p>You can Stop &amp; Keep at any time. Continue?</p>`,
                POPUP_TYPE.CONFIRM);
            if (!confirmed) {
                return;
            }
        }
        await runGuarded(() => wikiLibrary.fetchEverything(libraryId),
            (r) => `Fetched ${r.fetched} page(s)${r.stopped ? ' (stopped early)' : ''}`);
    });

    $('#vectfox_wl_quick_lookup_btn').on('click', runQuickLookup);
    $('#vectfox_wl_quick_lookup').on('keydown', (e) => {
        if (e.key === 'Enter') {
            runQuickLookup();
        }
    });

    // Basket tab controls
    $('#vectfox_wl_basket_clear').on('click', async () => {
        const confirmed = await callGenericPopup('Remove every page from the basket? (The pages stay in the library.)', POPUP_TYPE.CONFIRM);
        if (confirmed) {
            await wikiLibrary.clearBasket();
        }
    });
    $('#vectfox_wl_basket_fetch_missing').on('click', async () => {
        const basket = await wikiLibrary.materializeBasket();
        if (basket.unfetchedKeys.length === 0) {
            toastr.info('Every basket page already has content');
            return;
        }
        await runGuarded(() => wikiLibrary.fetchContentForKeys(basket.unfetchedKeys),
            (r) => `Fetched content for ${r.fetched} page(s)`);
    });
    $('#vectfox_wl_basket_use').on('click', async () => {
        const basket = await wikiLibrary.materializeBasket();
        if (basket.pageCount === 0 && basket.unfetchedKeys.length === 0) {
            toastr.info('The basket is empty — add pages from the Pages tab first');
            return;
        }
        const cv = await import('./content-vectorizer.js');
        if (typeof cv.useBasketAsWikiSource === 'function') {
            closeWikiLibrary();
            await cv.useBasketAsWikiSource();
        } else {
            cv.openContentVectorizer('wiki');
            toastr.info('Basket ready — choose "Selection basket" as the wiki source');
        }
    });
}

/** Wraps a service task with busy/error handling and a completion toast. */
async function runGuarded(task, successMessage) {
    if (wikiLibrary.isBusy()) {
        toastr.warning('A Wiki Library task is already running — stop it first.');
        return;
    }
    try {
        const result = await task();
        toastr.success(successMessage(result), 'VectFox');
    } catch (e) {
        if (e?.code === 'aborted') {
            toastr.info('Cancelled — pages already saved were kept');
        } else {
            console.error('VectFox: Wiki Library task failed:', e);
            toastr.error(e.message ?? String(e), 'VectFox');
        }
    }
}

async function runQuickLookup() {
    const title = $('#vectfox_wl_quick_lookup').val().trim();
    if (!title) {
        return;
    }
    try {
        const { records } = await wikiLibrary.quickLookupE621('', title);
        if (records.length === 0) {
            toastr.info(`No e621 wiki page titled "${title}" (exact match, lowercase_with_underscores)`, 'VectFox');
            return;
        }
        toastr.success(`Found and saved ${records.length} page(s)`, 'VectFox');
        $('#vectfox_wl_quick_lookup').val('');
        libraryState.query = records[0].title;
        $('#vectfox_wl_query').val(records[0].title);
        await refreshLibraryDropdown();
        await renderPagesTab();
    } catch (e) {
        toastr.error(e.message ?? String(e), 'VectFox');
    }
}

// ============================================================================
// TASK STRIP
// ============================================================================

function renderTaskStrip(task) {
    const strip = $('#vectfox_wl_task_strip');
    if (!task) {
        strip.hide();
        return;
    }
    const label = task.phase === 'content'
        ? `Fetching content ${task.done}/${task.total ?? '?'}…`
        : `Indexing pages… ${task.done} found`;
    $('#vectfox_wl_task_text').html('<i class="fa-solid fa-spinner fa-spin"></i> ');
    $('#vectfox_wl_task_text').append(document.createTextNode(label));
    strip.css('display', 'flex');
}

// ============================================================================
// PAGES TAB
// ============================================================================

function currentSearchOptions() {
    return {
        query: libraryState.query,
        mode: libraryState.mode,
        categories: libraryState.categories.size ? [...libraryState.categories] : undefined,
        sizeBuckets: libraryState.sizeBuckets.size ? [...libraryState.sizeBuckets] : undefined,
        fetched: libraryState.fetched,
        libraryIds: libraryState.libraryFilter === 'all' ? undefined : [libraryState.libraryFilter],
    };
}

async function renderActiveTab() {
    if (libraryState.activeTab === 'pages') {
        await renderPagesTab();
    } else if (libraryState.activeTab === 'basket') {
        await renderBasketTab();
    } else {
        await renderStorageTab();
    }
    updateBasketTabLabel();
}

async function refreshBasketKeys() {
    const rows = await wikiLibrary.getBasket();
    libraryState.basketKeys = new Set(rows.map(r => r.pageKey));
}

function updateBasketTabLabel() {
    const btn = $('#vectfox_wl_basket_tab');
    btn.empty()
        .append($('<i class="fa-solid fa-basket-shopping"></i>'))
        .append(document.createTextNode(` Basket (${libraryState.basketKeys.size})`));
}

async function refreshLibraryDropdown() {
    const libraries = await wikiLibrary.listLibraries();
    const select = $('#vectfox_wl_library_filter');
    const current = libraryState.libraryFilter;
    select.empty();
    select.append($('<option>').val('all').text('All wikis'));
    for (const library of libraries) {
        select.append($('<option>').val(library.id).text(
            `${library.name} (${(library.titleCount ?? 0).toLocaleString()})`));
    }
    if (current !== 'all' && !libraries.some(l => l.id === current)) {
        libraryState.libraryFilter = 'all';
    }
    select.val(libraryState.libraryFilter);
}

async function renderPagesTab() {
    const options = currentSearchOptions();
    const { keys, total, facets } = await wikiLibrary.search({
        ...options,
        limit: libraryState.shownLimit,
        offset: 0,
    });
    renderFacets(facets);

    const records = await wikiLibrary.getPages(keys);
    const list = $('#vectfox_wl_pages_list').empty();
    if (records.length === 0) {
        list.append($('<div class="vectfox-wl-empty">').text(
            total === 0 && !libraryState.query
                ? 'Nothing indexed yet — use Index Titles or Fetch Everything in the Content Vectorizer\'s wiki section.'
                : 'No pages match the current search/filters.'));
    }
    for (const record of records) {
        list.append(buildPageRow(record));
    }

    $('#vectfox_wl_pages_stats').text(
        `${total.toLocaleString()} page(s) · ${libraryState.selected.size} selected · showing ${Math.min(libraryState.shownLimit, total).toLocaleString()}`);
    $('#vectfox_wl_show_more').toggle(total > libraryState.shownLimit);
}

function buildPageRow(record) {
    const row = $('<div class="vectfox-wl-row">');

    const checkbox = $('<input type="checkbox" class="vectfox-wl-row-check">')
        .prop('checked', libraryState.selected.has(record.key))
        .on('change', function() {
            if (this.checked) {
                libraryState.selected.add(record.key);
            } else {
                libraryState.selected.delete(record.key);
            }
            $('#vectfox_wl_pages_stats').text(function(_, old) {
                return old.replace(/· \d+ selected/, `· ${libraryState.selected.size} selected`);
            });
        });
    row.append($('<span class="vectfox-wl-cell-check">').append(checkbox));

    const dot = $('<span class="vectfox-wl-fetched-dot">')
        .addClass(record.contentFetched ? 'is-fetched' : 'is-unfetched')
        .attr('title', record.contentFetched ? 'Content fetched' : 'Title only — content not fetched yet');
    row.append(dot);

    const title = record.url
        ? $('<a class="vectfox-wl-title" target="_blank" rel="noopener noreferrer">').attr('href', record.url).text(record.title)
        : $('<span class="vectfox-wl-title">').text(record.title);
    row.append(title);

    const badges = $('<span class="vectfox-wl-badges">');
    const shown = record.categories.slice(0, 3);
    for (const category of shown) {
        badges.append($('<span class="vectfox-wl-badge">').text(category).attr('title', category).on('click', async () => {
            libraryState.categories.add(category);
            libraryState.shownLimit = PAGE_SLICE;
            await renderPagesTab();
        }));
    }
    if (record.categories.length > 3) {
        badges.append($('<span class="vectfox-wl-badge vectfox-wl-badge-more">')
            .text(`+${record.categories.length - 3}`)
            .attr('title', record.categories.join(', ')));
    }
    row.append(badges);

    row.append($('<span class="vectfox-wl-size">').text(formatBytes(record.sizeBytes)));

    const actions = $('<span class="vectfox-wl-row-actions">');
    const inBasket = libraryState.basketKeys.has(record.key);
    actions.append($('<button class="vectfox-btn-icon">')
        .attr('title', inBasket ? 'Remove from basket' : 'Add to basket')
        .html(inBasket ? '<i class="fa-solid fa-basket-shopping" style="color: var(--vectfox-success);"></i>' : '<i class="fa-solid fa-basket-shopping"></i>')
        .on('click', async () => {
            if (libraryState.basketKeys.has(record.key)) {
                await wikiLibrary.removeFromBasket([record.key]);
            } else {
                await wikiLibrary.addToBasket([record.key]);
            }
        }));
    if (!record.contentFetched) {
        actions.append($('<button class="vectfox-btn-icon" title="Fetch this page\'s content now">')
            .html('<i class="fa-solid fa-download"></i>')
            .on('click', () => runGuarded(
                () => wikiLibrary.fetchContentForKeys([record.key]),
                () => `Fetched "${record.title}"`)));
    }
    row.append(actions);
    return row;
}

function renderFacets(facets) {
    const container = $('#vectfox_wl_facets').empty();

    // Fetched-status chips
    const statusGroup = $('<span class="vectfox-wl-facet-group">');
    for (const [label, value] of [['All', undefined], [`Fetched (${facets.fetched.fetched})`, true], [`Not fetched (${facets.fetched.unfetched})`, false]]) {
        statusGroup.append($('<span class="vectfox-wl-chip">')
            .toggleClass('active', libraryState.fetched === value)
            .text(label)
            .on('click', async () => {
                libraryState.fetched = value;
                libraryState.shownLimit = PAGE_SLICE;
                await renderPagesTab();
            }));
    }
    container.append(statusGroup);

    // Size buckets
    const sizeGroup = $('<span class="vectfox-wl-facet-group">');
    for (const bucket of SIZE_BUCKETS) {
        const count = facets.sizeBuckets[bucket.id] ?? 0;
        if (count === 0 && !libraryState.sizeBuckets.has(bucket.id)) {
            continue;
        }
        sizeGroup.append($('<span class="vectfox-wl-chip">')
            .toggleClass('active', libraryState.sizeBuckets.has(bucket.id))
            .text(`${bucket.label} (${count})`)
            .on('click', async () => {
                if (libraryState.sizeBuckets.has(bucket.id)) {
                    libraryState.sizeBuckets.delete(bucket.id);
                } else {
                    libraryState.sizeBuckets.add(bucket.id);
                }
                libraryState.shownLimit = PAGE_SLICE;
                await renderPagesTab();
            }));
    }
    container.append(sizeGroup);

    // Category chips: active ones first, then top counts
    const entries = Object.entries(facets.categories).sort((a, b) => b[1] - a[1]);
    const catGroup = $('<span class="vectfox-wl-facet-group vectfox-wl-facet-categories">');
    const maxShown = libraryState.categoriesExpanded ? entries.length : 20;
    const active = entries.filter(([name]) => libraryState.categories.has(name));
    const inactive = entries.filter(([name]) => !libraryState.categories.has(name));
    const shown = [...active, ...inactive.slice(0, Math.max(0, maxShown - active.length))];
    for (const [name, count] of shown) {
        catGroup.append($('<span class="vectfox-wl-chip vectfox-wl-chip-category">')
            .toggleClass('active', libraryState.categories.has(name))
            .text(`${name} (${count})`)
            .on('click', async () => {
                if (libraryState.categories.has(name)) {
                    libraryState.categories.delete(name);
                } else {
                    libraryState.categories.add(name);
                }
                libraryState.shownLimit = PAGE_SLICE;
                await renderPagesTab();
            }));
    }
    if (entries.length > shown.length || libraryState.categoriesExpanded) {
        catGroup.append($('<span class="vectfox-wl-chip vectfox-wl-chip-more">')
            .text(libraryState.categoriesExpanded ? 'Show fewer' : `+${entries.length - shown.length} more categories`)
            .on('click', async () => {
                libraryState.categoriesExpanded = !libraryState.categoriesExpanded;
                await renderPagesTab();
            }));
    }
    if (entries.length > 0) {
        container.append(catGroup);
    }
}

// ============================================================================
// BASKET TAB
// ============================================================================

async function renderBasketTab() {
    const rows = await wikiLibrary.getBasket();
    const records = await wikiLibrary.getPages(rows.map(r => r.pageKey));
    const libraries = await wikiLibrary.listLibraries();
    const nameOf = new Map(libraries.map(l => [l.id, l.name]));

    const totals = {
        pages: records.length,
        unfetched: records.filter(r => !r.contentFetched).length,
        chars: records.reduce((sum, r) => sum + (r.plaintext?.length ?? 0), 0),
    };
    $('#vectfox_wl_basket_totals').text(records.length === 0
        ? 'The basket is empty — tick pages in the Pages tab and press "Add selected to basket".'
        : `${totals.pages} page(s) from ${new Set(records.map(r => r.libraryId)).size} wiki(s) · ${totals.unfetched} without content yet · ~${totals.chars.toLocaleString()} chars`);

    const list = $('#vectfox_wl_basket_list').empty();
    const byLibrary = new Map();
    for (const record of records) {
        if (!byLibrary.has(record.libraryId)) {
            byLibrary.set(record.libraryId, []);
        }
        byLibrary.get(record.libraryId).push(record);
    }

    for (const [libraryId, group] of byLibrary) {
        const details = $('<details class="vectfox-wl-basket-group" open>');
        const summary = $('<summary>');
        summary.append($('<span class="vectfox-wl-basket-group-name">').text(nameOf.get(libraryId) ?? libraryId));
        summary.append($('<span class="vectfox-wl-basket-group-count">').text(` ${group.length} page(s)`));
        summary.append($('<button class="vectfox-btn-icon" title="Remove this wiki\'s pages from the basket">')
            .html('<i class="fa-solid fa-xmark"></i>')
            .on('click', async (e) => {
                e.preventDefault();
                await wikiLibrary.removeFromBasket(group.map(r => r.key));
            }));
        details.append(summary);

        for (const record of group) {
            const row = $('<div class="vectfox-wl-row">');
            row.append($('<span class="vectfox-wl-fetched-dot">')
                .addClass(record.contentFetched ? 'is-fetched' : 'is-unfetched')
                .attr('title', record.contentFetched ? 'Content fetched' : 'Content not fetched yet'));
            row.append($('<span class="vectfox-wl-title">').text(record.title));
            row.append($('<span class="vectfox-wl-size">').text(formatBytes(record.plaintext?.length ?? record.sizeBytes)));
            row.append($('<span class="vectfox-wl-row-actions">').append(
                $('<button class="vectfox-btn-icon" title="Remove from basket">')
                    .html('<i class="fa-solid fa-xmark"></i>')
                    .on('click', () => wikiLibrary.removeFromBasket([record.key]))));
            details.append(row);
        }
        list.append(details);
    }
}

// ============================================================================
// STORAGE TAB
// ============================================================================

async function renderStorageTab() {
    const usage = await wikiLibrary.estimateUsage();
    const libraries = await wikiLibrary.listLibraries();

    const list = $('#vectfox_wl_storage_list').empty();
    if (libraries.length === 0) {
        list.append($('<div class="vectfox-wl-empty">').text('No wikis stored yet.'));
    }
    for (const library of libraries) {
        const card = $('<div class="vectfox-wl-storage-card">');
        const head = $('<div class="vectfox-wl-storage-head">');
        head.append($('<span class="vectfox-wl-storage-name">').text(library.name));
        head.append($('<span class="vectfox-wl-badge">').text(library.wikiType));
        if (library.origin === 'plugin') {
            head.append($('<span class="vectfox-wl-badge">').text('via plugin'));
        }
        card.append(head);

        const stats = $('<div class="vectfox-wl-storage-stats">');
        stats.append($('<span>').text(`${(library.titleCount ?? 0).toLocaleString()} titles`));
        stats.append($('<span>').text(`${(library.fetchedCount ?? 0).toLocaleString()} fetched`));
        stats.append($('<span>').text(`~${formatBytes(library.bytesApprox ?? 0)} text`));
        const resumable = wikiLibrary.isResumable(library);
        stats.append($('<span>').text(library.enumComplete
            ? 'fully indexed'
            : (resumable ? 'paused — checkpoint saved' : 'not indexed yet')));
        card.append(stats);
        if (library.lastError) {
            card.append($('<div class="vectfox-wl-storage-error">').text(`Last error: ${library.lastError}`));
        }

        const actions = $('<div class="vectfox-wl-storage-actions">');
        if (resumable) {
            actions.append($('<button class="vectfox-btn-sm">')
                .html('<i class="fa-solid fa-play"></i> Resume indexing')
                .on('click', () => runGuarded(
                    () => wikiLibrary.resumeEnumeration(library.id),
                    (r) => r.stopped ? 'Stopped — progress kept' : `Indexing complete (${r.count} new pages)`)));
        }
        actions.append($('<button class="vectfox-btn-sm vectfox-btn-danger-outline">')
            .html('<i class="fa-solid fa-trash"></i> Delete library')
            .on('click', async () => {
                const confirmed = await callGenericPopup(
                    `<p>Delete <b>${$('<span>').text(library.name).html()}</b> from the Wiki Library?</p>
                     <p>${(library.titleCount ?? 0).toLocaleString()} stored pages and their basket entries will be removed. Collections already vectorized are NOT affected.</p>`,
                    POPUP_TYPE.CONFIRM);
                if (confirmed) {
                    await wikiLibrary.removeLibrary(library.id);
                    toastr.success(`Deleted "${library.name}"`, 'VectFox');
                    await refreshLibraryDropdown();
                    await renderStorageTab();
                }
            }));
        card.append(actions);
        list.append(card);
    }

    const footer = $('#vectfox_wl_storage_footer').empty();
    if (usage.usage != null && usage.quota != null && usage.quota > 0) {
        const percent = Math.min(100, (usage.usage / usage.quota) * 100);
        footer.append($('<div class="vectfox-wl-usage-text">').text(
            `Browser storage: ${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} used (${percent.toFixed(1)}%)`));
        footer.append($('<div class="vectfox-wl-usage-bar">')
            .append($('<div class="vectfox-wl-usage-fill">').css('width', `${percent}%`)));
    }
}

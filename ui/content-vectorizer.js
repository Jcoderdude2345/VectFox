/**
 * ============================================================================
 * VECTFOX CONTENT VECTORIZER UI
 * ============================================================================
 * Modal interface for vectorizing different content types with intelligent
 * settings that adapt based on selected content type.
 *
 * @author Kritblade
 * @version 4.0.0
 * ============================================================================
 */

import {
    getContentType,
    getAllContentTypes,
    getChunkingStrategies,
    getChunkingStrategy,
    getContentTypeDefaults,
    hasFeature,
    CHARACTER_FIELDS,
} from '../core/content-types.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getChatUUID, vectorizeAll } from '../core/chat-vectorization.js';
import { validateLLMConfig } from '../core/summarizer.js';
import { getOpenRouterApiKey } from '../core/api-keys.js';
import StringUtils from '../utils/string-utils.js';
import { resolveEffectiveSettings } from '../core/content-vectorization.js';
import { renderCollections } from './database-browser.js';
import { buildArchiveEventCollectionId } from '../core/collection-ids.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { getCleaningSettings } from '../core/text-cleaning.js';
import { progressTracker } from './progress-tracker.js';
import { isFatbodyOwnedBook } from '../core/fatbody-guard.js';
import {
    WikiScrapeError,
    shouldFallbackToPlugin,
    buildApiCandidates,
    resolveE621Base,
} from '../core/wiki-scraper.js';
import * as wikiLibrary from '../core/wiki-library-service.js';
import { createReformatSession } from '../core/reformat-run.js';
import { closeReformatReview } from './reformat-review.js';
import { isWikiPluginAvailable } from '../core/wiki-plugin.js';

// ============================================================================
// STATE
// ============================================================================

let currentContentType = 'lorebook';
let currentSettings = {};
let sourceData = null;
let activeVectorizeAbortController = null;
let isVectorizing = false;
let startFromMessage = 1;
const reformatSession = createReformatSession();
function invalidateAutoReformat() {
    reformatSession.cancel();
    closeReformatReview();
}

function syncStartFromMessageFromUI() {
    const raw = parseInt($('#vectfox_cv_startfrom').val(), 10);
    startFromMessage = Number.isFinite(raw) && raw >= 1 ? raw : 1;
    $('#vectfox_cv_startfrom').val(startFromMessage);
}

/**
 * Returns true if this chat has any cached extraction state (window fingerprints
 * OR a vectorization tip). Used to decide whether the Vectorize button should
 * confirm before resetting. No state → fresh chat → no prompt needed.
 */
async function _hasPriorExtractionState(chatUUID) {
    if (!chatUUID) return false;
    const arr = extension_settings?.vectfox?.eventbase_extracted_windows?.[chatUUID];
    if (Array.isArray(arr) && arr.length > 0) return true;
    const { getVectorizationTip } = await import('../core/eventbase-store.js');
    return typeof getVectorizationTip(chatUUID) === 'number';
}

function updateVectorizeButtonState(running) {
    const btn = $('#vectfox_cv_vectorize');
    const cancelBtn = $('#vectfox_cv_cancel');
    const continueBtn = $('#vectfox_cv_continue');

    if (running) {
        btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Vectorizing...');
        cancelBtn.html('<i class="fa-solid fa-stop"></i> Stop');
        continueBtn.prop('disabled', true);
    } else {
        btn.prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Vectorize');
        cancelBtn.text('Cancel');
        continueBtn.prop('disabled', false);
    }
}

function stopActiveVectorization() {
    if (activeVectorizeAbortController && !activeVectorizeAbortController.signal.aborted) {
        activeVectorizeAbortController.abort('user-stop');
    }
}

// ============================================================================
// MODAL CREATION
// ============================================================================

/**
 * Opens the content vectorizer modal
 * @param {string} initialType - Optional initial content type to select
 */
export function openContentVectorizer(initialType = null) {
    currentContentType = initialType;
    currentSettings = initialType ? { ...getContentTypeDefaults(initialType) } : {};
    invalidateAutoReformat();
    sourceData = null;
    wikiSourceMode = 'scrape';
    stashedScrapeSourceData = null;
    currentBasketSelectionHash = null;

    createModal();
    bindEvents();

    // Only show subsequent sections if type is pre-selected
    if (currentContentType) {
        updateUIForContentType();
        $('.vectfox-cv-subsequent').show();
    } else {
        $('.vectfox-cv-subsequent').hide();
    }

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#vectfox_content_vectorizer_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    $('#vectfox_content_vectorizer_modal').fadeIn(200);
}

/**
 * Closes the modal
 */
export function closeContentVectorizer() {
    invalidateAutoReformat();
    teardownWikiLibraryEvents();
    $('#vectfox_content_vectorizer_modal').fadeOut(200, function() {
        $(this).remove();
    });
}

/**
 * Hide the Content Vectorizer modal so the progress panel is visible while work runs.
 *
 * On touch devices the vectorizer is a full-screen modal that would completely cover
 * the progress bottom-sheet, so we fade it out. We deliberately use .fadeOut() (NOT
 * closeContentVectorizer()) so the modal stays in the DOM — downstream code still reads
 * its inputs (e.g. #vectfox_cv_parallel_windows), and closeContentVectorizer() removes
 * it for good once the run completes.
 *
 * Desktop leaves the modal open; the progress panel floats in the corner and doesn't
 * obscure it. Uses pointer/hover — NOT viewport width — so high-DPI phones whose CSS
 * viewport can exceed 768px are still treated as touch devices.
 *
 * Call this only AFTER the run is committed (past the isVectorizing guard / early
 * returns), so the modal never disappears on a path that shows no progress.
 */
function hideVectorizerForProgress() {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        $('#vectfox_content_vectorizer_modal').fadeOut(200);
    }
}

/**
 * Creates the modal HTML
 */
function createModal() {
    // Remove existing
    $('#vectfox_content_vectorizer_modal').remove();

    const contentTypes = getAllContentTypes(); // All types including chat

    const html = `
        <div id="vectfox_content_vectorizer_modal" class="vectfox-modal">
            <div class="vectfox-modal-overlay"></div>
            <div class="vectfox-modal-content vectfox-content-vectorizer">
                <div class="vectfox-modal-header">
                    <h3>
                        <i class="fa-solid fa-database"></i>
                        Vectorize Content
                    </h3>
                    <button class="vectfox-modal-close" id="vectfox_cv_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>

                <div class="vectfox-cv-body">
                    <!-- Step 1: Content Type Selection - BIG DROPDOWN -->
                    <div class="vectfox-cv-section vectfox-cv-type-section">
                        <div class="vectfox-cv-type-dropdown-wrapper">
                            <label class="vectfox-cv-main-label">What do you want to vectorize?</label>
                            <select id="vectfox_cv_type_select" class="vectfox-cv-type-dropdown">
                                <option value="">-- Choose content type --</option>
                                ${contentTypes.map(type => `
                                    <option value="${type.id}" ${type.id === currentContentType ? 'selected' : ''}>
                                        ${type.name}
                                    </option>
                                `).join('')}
                            </select>
                            <span class="vectfox-cv-type-hint" id="vectfox_cv_type_hint">
                                Select a content type to continue
                            </span>
                        </div>
                    </div>

                    <!-- Step 1: Backfill Range (chat only) -->
                    <div class="vectfox-cv-section vectfox-cv-startfrom-section vectfox-cv-subsequent" id="vectfox_cv_startfrom_section" style="display:none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">1</span>
                            <span class="vectfox-cv-section-title">Backfill Range</span>
                        </div>
                        <div class="vectfox-cv-section-body">
                            <div class="vectfox-cv-startfrom-row">
                                <label for="vectfox_cv_startfrom">Start From Message</label>
                                <input type="number" id="vectfox_cv_startfrom" class="vectfox-input" min="1" step="1" value="1" style="width:100px;">
                            </div>
                            <span class="vectfox-cv-type-hint">Default 1 = entire chat. Enter e.g. 2000 to start from message 2000 onward.</span>
                        </div>
                    </div>

                    <!-- Step 2: Source Selection (changes based on type) -->
                    <div class="vectfox-cv-section vectfox-cv-source-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">2</span>
                            <span class="vectfox-cv-section-title" id="vectfox_cv_source_title">Select Source</span>
                        </div>
                        <div id="vectfox_cv_source_content" class="vectfox-cv-section-body">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Step 2.5: Auto-Reformat (Optional, Document/URL/Wiki/Transcript only) -->
                    <div class="vectfox-cv-section vectfox-cv-reformat-section vectfox-cv-subsequent" id="vectfox_cv_reformat_section" style="display:none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                            <span class="vectfox-cv-section-title">Auto-Reformat (Optional)</span>
                        </div>
                        <div id="vectfox_cv_reformat_content" class="vectfox-cv-section-body">
                            <!-- Dynamically populated -->
                        </div>
                    </div>

                    <!-- Step 3: Chunking Settings -->
                    <div class="vectfox-cv-section vectfox-cv-chunking-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">3</span>
                            <span class="vectfox-cv-section-title">Chunking Strategy</span>
                            <button class="vectfox-cv-collapse-btn" data-target="chunking">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vectfox-cv-collapsible" id="vectfox_cv_chunking_content">
                            <div class="vectfox-cv-strategy-select" id="vectfox_cv_strategy_select_wrapper">
                                <label>Strategy</label>
                                <select id="vectfox_cv_strategy" class="vectfox-select">
                                    <!-- Populated dynamically -->
                                </select>
                                <span class="vectfox-cv-strategy-desc" id="vectfox_cv_strategy_desc"></span>
                            </div>

                            <!-- Size/Overlap controls - only shown for text-based strategies -->
                            <div class="vectfox-cv-size-controls" id="vectfox_cv_size_controls">
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_chunk_size_row">
                                    <label>
                                        Chunk Size
                                        <span class="vectfox-cv-value" id="vectfox_cv_chunk_size_val">400</span> chars
                                    </label>
                                    <input type="range" id="vectfox_cv_chunk_size"
                                           min="100" max="1000" step="50" value="400">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>Precise</span>
                                        <span>Contextual</span>
                                    </div>
                                </div>
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_overlap_row">
                                    <label>
                                        Chunk Overlap
                                        <span class="vectfox-cv-value" id="vectfox_cv_overlap_val">50</span> chars
                                    </label>
                                    <input type="range" id="vectfox_cv_overlap"
                                           min="0" max="200" step="10" value="50">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>Off</span>
                                        <span>High</span>
                                    </div>
                                </div>
                                <!-- Batch size - only shown for message_batch strategy -->
                                <div class="vectfox-cv-slider-row" id="vectfox_cv_batch_size_row" style="display:none;">
                                    <label>
                                        Messages per Batch
                                        <span class="vectfox-cv-value" id="vectfox_cv_batch_size_val">4</span>
                                    </label>
                                    <input type="range" id="vectfox_cv_batch_size"
                                           min="1" max="20" step="1" value="4">
                                    <div class="vectfox-cv-slider-hints">
                                        <span>1 msg</span>
                                        <span>20 msgs</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Parallel Windows - EventBase/chat only -->
                            <div class="vectfox-cv-slider-row" id="vectfox_cv_parallel_row" style="display:none;">
                                <label>
                                    Parallel Windows
                                    <span class="vectfox-cv-value" id="vectfox_cv_parallel_val">3</span>
                                </label>
                                <input type="range" id="vectfox_cv_parallel_windows"
                                       min="1" max="8" step="1" value="3">
                                <div class="vectfox-cv-slider-hints">
                                    <span>1 (safe)</span>
                                    <span>8 (fast)</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Step 4: Type-Specific Options -->
                    <div class="vectfox-cv-section vectfox-cv-options-section vectfox-cv-subsequent">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number">4</span>
                            <span class="vectfox-cv-section-title">Options</span>
                            <button class="vectfox-cv-collapse-btn" data-target="options">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div class="vectfox-cv-collapsible" id="vectfox_cv_options_content">
                            <!-- Dynamically populated based on content type -->
                        </div>
                    </div>

                    <!-- Preview Section -->
                    <div class="vectfox-cv-section vectfox-cv-preview-section" style="display: none;">
                        <div class="vectfox-cv-section-header">
                            <span class="vectfox-cv-step-number"><i class="fa-solid fa-eye"></i></span>
                            <span class="vectfox-cv-section-title">Preview</span>
                        </div>
                        <div id="vectfox_cv_preview_content" class="vectfox-cv-preview">
                            <!-- Preview of chunks will appear here -->
                        </div>
                    </div>
                </div>

                <div class="vectfox-cv-footer">
                    <button class="vectfox-btn-secondary" id="vectfox_cv_cancel">Cancel</button>
                    <button class="vectfox-btn-secondary" id="vectfox_cv_preview_btn">
                        <i class="fa-solid fa-eye"></i> Preview Chunks
                    </button>
                    <button class="vectfox-btn-secondary" id="vectfox_cv_continue" style="display: none;">
                        <i class="fa-solid fa-forward"></i> Continue
                    </button>
                    <button class="vectfox-btn-primary" id="vectfox_cv_vectorize">
                        <i class="fa-solid fa-bolt"></i> Vectorize
                    </button>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
}

// ============================================================================
// UI UPDATES
// ============================================================================

/**
 * Updates the entire UI based on selected content type
 */
function updateUIForContentType() {
    const type = getContentType(currentContentType);
    if (!type) return;

    // Update source section
    updateSourceSection(type);

    // Auto-Reformat section (Document/URL/Wiki/Transcript only) — must run before
    // updateChunkingSection() so the latter can see currentSettings.reformat
    // state for the current content type when deciding whether to show the
    // strategy dropdown or the "handled by Auto-Reformat" message.
    renderReformatSection();

    // Update chunking strategies
    updateChunkingSection(type);

    // Update options section
    updateOptionsSection(type);

    // Show Continue button only for chat type (backfills missing chunks via hash dedup)
    const isChatType = currentContentType === 'chat';
    $('#vectfox_cv_continue').toggle(isChatType);
    // Show Start From section only for chat
    $('#vectfox_cv_startfrom_section').toggle(isChatType);
    if (!isChatType) startFromMessage = 1;
}

/**
 * Updates the source selection section
 */
function updateSourceSection(type) {
    const container = $('#vectfox_cv_source_content');
    container.empty();

    let html = '';

    switch (type.sourceType) {
        case 'select':
            html = renderSelectSource(type);
            break;
        case 'input':
            html = renderInputSource(type);
            break;
        case 'url':
            html = renderUrlSource(type);
            break;
        case 'chat':
            html = renderChatSource(type);
            break;
        case 'current':
            html = renderCurrentChatSource(type);
            break;
        case 'wiki':
            html = renderWikiSource(type);
            break;
        case 'youtube':
            html = renderYouTubeSource(type);
            break;
    }

    container.html(html);

    // Bind source-specific events after rendering
    bindSourceEvents(type);
}

/**
 * Renders URL input source
 */
function renderUrlSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-url-source">
            <label>Enter URL</label>
            <div class="vectfox-cv-url-input-row">
                <input type="text" id="vectfox_cv_url_input"
                       class="vectfox-input"
                       placeholder="${options.placeholder || 'https://example.com'}">
                <button id="vectfox_cv_fetch_url" class="vectfox-btn-primary">
                    <i class="fa-solid fa-download"></i> Fetch
                </button>
            </div>
            <div class="vectfox-cv-url-status" id="vectfox_cv_url_status"></div>
            <div class="vectfox-cv-url-preview" id="vectfox_cv_url_preview" style="display: none;">
                <div class="vectfox-cv-url-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_url_title">Page loaded</span>
                </div>
                <div class="vectfox-cv-url-preview-stats">
                    <span><strong id="vectfox_cv_url_chars">0</strong> characters</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders chat source with current chat + upload options
 */
function renderChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-chat-source">
            <div class="vectfox-cv-source-tabs">
                <button class="vectfox-cv-source-tab ${hasChat ? 'active' : ''}" data-source="current" ${!hasChat ? 'disabled' : ''}>
                    <i class="fa-solid fa-comment-dots"></i> Current Chat
                </button>
                <button class="vectfox-cv-source-tab ${!hasChat ? 'active' : ''}" data-source="upload">
                    <i class="fa-solid fa-upload"></i> Upload
                </button>
            </div>

            <!-- Current Chat Panel -->
            <div class="vectfox-cv-source-panel" data-panel="current" ${!hasChat ? 'style="display: none;"' : ''}>
                ${hasChat ? `
                    <div class="vectfox-cv-chat-info">
                        <div class="vectfox-cv-chat-stats">
                            <div class="vectfox-cv-stat">
                                <span class="vectfox-cv-stat-value">${messageCount}</span>
                                <span class="vectfox-cv-stat-label">Messages</span>
                            </div>
                            <div class="vectfox-cv-stat">
                                <span class="vectfox-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                                <span class="vectfox-cv-stat-label">Character</span>
                            </div>
                        </div>
                        <div class="vectfox-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                            <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
                        </div>
                        <div class="vectfox-cv-chat-note">
                            <i class="fa-solid fa-info-circle"></i>
                            Will vectorize all messages in the current chat
                        </div>
                    </div>
                ` : `
                    <div class="vectfox-cv-no-chat">
                        <i class="fa-solid fa-comment-slash"></i>
                        <span>No chat is currently open</span>
                    </div>
                `}
            </div>

            <!-- Upload Panel -->
            <div class="vectfox-cv-source-panel" data-panel="upload" ${hasChat ? 'style="display: none;"' : ''}>
                <div class="vectfox-cv-upload-zone" id="vectfox_cv_chat_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop chat file here or click to browse</span>
                    <span class="vectfox-cv-upload-formats">
                        Formats: ${options.uploadFormats.join(', ')}
                    </span>
                    <input type="file" id="vectfox_cv_chat_file_input"
                           accept="${options.uploadFormats.join(',')}" hidden>
                </div>
                <div class="vectfox-cv-upload-info" id="vectfox_cv_chat_upload_info" style="display: none;">
                    <i class="fa-solid fa-file"></i>
                    <span id="vectfox_cv_chat_upload_filename"></span>
                    <button class="vectfox-cv-upload-clear" id="vectfox_cv_chat_upload_clear">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-cv-chat-upload-stats" id="vectfox_cv_chat_upload_stats" style="display: none;">
                    <!-- Populated after file upload -->
                </div>
                <div class="vectfox-cv-upload-hint">
                    <strong>Supported formats:</strong><br>
                    • <code>.jsonl</code> - JSON Lines (one message per line)<br>
                    • <code>.json</code> - SillyTavern chat export<br>
                    • <code>.txt</code> - Plain text (will be chunked as-is)
                </div>
            </div>
        </div>
    `;
}

/**
 * Renders current chat source (for chat type) - legacy, kept for compatibility
 */
function renderCurrentChatSource(type) {
    const context = getContext();
    const hasChat = !!context?.chatId;
    const messageCount = context?.chat?.length || 0;

    if (!hasChat) {
        return `
            <div class="vectfox-cv-no-chat">
                <i class="fa-solid fa-comment-slash"></i>
                <span>No chat is currently open</span>
                <span class="vectfox-cv-hint">Open a chat to vectorize its messages</span>
            </div>
        `;
    }

    return `
        <div class="vectfox-cv-chat-info">
            <div class="vectfox-cv-chat-stats">
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${messageCount}</span>
                    <span class="vectfox-cv-stat-label">Messages</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${context?.name2 || 'Unknown'}</span>
                    <span class="vectfox-cv-stat-label">Character</span>
                </div>
            </div>
            <div class="vectfox-cv-chat-uuid" style="text-align: center; margin-top: 8px;">
                <code style="font-size: 0.7em; opacity: 0.6; user-select: all;">${getChatUUID() || 'unknown'}</code>
            </div>
            <div class="vectfox-cv-chat-note">
                <i class="fa-solid fa-info-circle"></i>
                Will vectorize all messages in the current chat
            </div>
        </div>
    `;
}

/**
 * Renders select-based source (lorebook, character)
 */
function renderSelectSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-source-select">
            <div class="vectfox-cv-source-tabs">
                <button class="vectfox-cv-source-tab active" data-source="existing">
                    <i class="fa-solid fa-list"></i> Existing
                </button>
                ${options.allowUpload ? `
                    <button class="vectfox-cv-source-tab" data-source="upload">
                        <i class="fa-solid fa-upload"></i> Upload
                    </button>
                ` : ''}
            </div>

            <div class="vectfox-cv-source-panel" data-panel="existing">
                <label>${options.selectLabel || 'Select'}</label>
                <select id="vectfox_cv_source_select" class="vectfox-select">
                    <option value="">-- Select --</option>
                    <!-- Populated dynamically -->
                </select>
                <!-- Stats display (shown after selection) -->
                <div class="vectfox-cv-source-stats" id="vectfox_cv_source_stats" style="display: none;">
                    <div class="vectfox-cv-stats-loading">
                        <i class="fa-solid fa-spinner fa-spin"></i> Loading info...
                    </div>
                </div>
            </div>

            ${options.allowUpload ? `
                <div class="vectfox-cv-source-panel" data-panel="upload" style="display: none;">
                    <div class="vectfox-cv-upload-zone" id="vectfox_cv_upload_zone">
                        <i class="fa-solid fa-cloud-arrow-up"></i>
                        <span>Drop file here or click to browse</span>
                        <span class="vectfox-cv-upload-formats">
                            Formats: ${options.uploadFormats.join(', ')}
                        </span>
                        <input type="file" id="vectfox_cv_file_input"
                               accept="${options.uploadFormats.join(',')}" hidden>
                    </div>
                    <div class="vectfox-cv-upload-info" id="vectfox_cv_upload_info" style="display: none;">
                        <i class="fa-solid fa-file"></i>
                        <span id="vectfox_cv_upload_filename"></span>
                        <button class="vectfox-cv-upload-clear" id="vectfox_cv_upload_clear">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * Renders input-based source (document)
 */
function renderInputSource(type) {
    const methods = type.sourceOptions.methods;

    return `
        <div class="vectfox-cv-input-source">
            <div class="vectfox-cv-input-tabs">
                ${methods.map((m, i) => `
                    <button class="vectfox-cv-input-tab ${i === 0 ? 'active' : ''}" data-method="${m.id}">
                        <i class="fa-solid ${m.icon}"></i>
                        <span>${m.name}</span>
                    </button>
                `).join('')}
            </div>

            <!-- Paste Text Panel -->
            <div class="vectfox-cv-input-panel" data-panel="paste">
                <textarea id="vectfox_cv_paste_text"
                          placeholder="Paste or type your text here..."
                          rows="8"></textarea>
            </div>

            <!-- Upload File Panel -->
            <div class="vectfox-cv-input-panel" data-panel="upload" style="display: none;">
                <div class="vectfox-cv-upload-zone" id="vectfox_cv_doc_upload_zone">
                    <i class="fa-solid fa-cloud-arrow-up"></i>
                    <span>Drop file here or click to browse</span>
                    <span class="vectfox-cv-upload-formats">
                        Formats: ${methods.find(m => m.id === 'upload')?.formats?.join(', ') || '.txt, .md'}
                    </span>
                    <input type="file" id="vectfox_cv_doc_file_input"
                           accept="${methods.find(m => m.id === 'upload')?.formats?.join(',') || '.txt,.md'}" hidden>
                </div>
            </div>

            <!-- URL Fetch Panel -->
            <div class="vectfox-cv-input-panel" data-panel="url" style="display: none;">
                <div class="vectfox-cv-url-input">
                    <input type="text" id="vectfox_cv_url_input"
                           placeholder="https://example.com/article">
                    <button id="vectfox_cv_fetch_url" class="vectfox-btn-secondary">
                        <i class="fa-solid fa-download"></i> Fetch
                    </button>
                </div>
                <div class="vectfox-cv-url-status" id="vectfox_cv_url_status"></div>
            </div>

            <!-- Document Name -->
            <div class="vectfox-cv-doc-name">
                <label>Collection Name</label>
                <input type="text" id="vectfox_cv_doc_name"
                       placeholder="My Document">
            </div>
        </div>
    `;
}

/**
 * Renders Wiki source (Fandom / MediaWiki)
 */
function renderWikiSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-wiki-source">
            <!-- Scraper Status -->
            <div class="vectfox-cv-wiki-plugin-status" id="vectfox_cv_wiki_plugin_status">
                <i class="fa-solid fa-spinner fa-spin"></i> Checking scraper status...
            </div>

            <!-- Wiki Type Selection -->
            <div class="vectfox-cv-wiki-type">
                <label>Wiki Type</label>
                <select id="vectfox_cv_wiki_type" class="vectfox-select">
                    ${options.types.map(t => `
                        <option value="${t.id}">${t.name}</option>
                    `).join('')}
                </select>
            </div>

            <!-- Wiki URL/ID Input -->
            <div class="vectfox-cv-wiki-url">
                <label>Wiki URL or ID</label>
                <input type="text" id="vectfox_cv_wiki_url"
                       class="vectfox-input"
                       placeholder="${options.types[0].placeholder}">
            </div>

            <!-- Page Filter (for bulk scraping) -->
            <div class="vectfox-cv-wiki-filter">
                <label>
                    Title Filter
                    <span class="vectfox-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vectfox_cv_wiki_filter"
                       class="vectfox-input"
                       placeholder="${options.filterPlaceholder}">
                <div class="vectfox-cv-hint">
                    Optional regex applied while indexing (e.g. Astarion|Gale). Leave empty to index
                    everything — you can search and pick pages in the Wiki Library afterwards.
                </div>
            </div>

            <!-- Wiki Library actions -->
            <div class="vectfox-cv-wiki-actions" id="vectfox_cv_wiki_library_actions">
                <button id="vectfox_cv_index_titles" class="vectfox-btn-primary"
                        title="Fast: list every page title with categories and sizes, without downloading content. Pick pages in the Wiki Library afterwards.">
                    <i class="fa-solid fa-list"></i> Index Titles
                </button>
                <button id="vectfox_cv_fetch_everything" class="vectfox-btn-secondary"
                        title="Index and download the full content of every page (the old Scrape Wiki behavior, now saved to the Wiki Library).">
                    <i class="fa-solid fa-download"></i> Fetch Everything
                </button>
                <button id="vectfox_cv_resume_indexing" class="vectfox-btn-secondary" style="display: none;"
                        title="Continue an interrupted scrape from its saved checkpoint.">
                    <i class="fa-solid fa-play"></i> Resume
                </button>
                <button id="vectfox_cv_open_library" class="vectfox-btn-secondary"
                        title="Browse everything scraped so far: search, filter by category, pick pages, build a cross-wiki basket, manage storage.">
                    <i class="fa-solid fa-book-open"></i> Wiki Library
                </button>
            </div>

            <!-- Running-task controls -->
            <div class="vectfox-cv-wiki-actions" id="vectfox_cv_wiki_running_actions" style="display: none;">
                <button id="vectfox_cv_stop_keep" class="vectfox-btn-secondary"
                        title="Stop now but KEEP everything retrieved so far (a checkpoint is saved for Resume).">
                    <i class="fa-solid fa-hand"></i> Stop &amp; Keep
                </button>
                <button id="vectfox_cv_cancel_scrape" class="vectfox-btn-danger"
                        title="Abort the current request. Pages already saved to the Wiki Library are kept.">
                    <i class="fa-solid fa-stop"></i> Cancel
                </button>
            </div>

            <!-- Legacy one-shot scrape (only when IndexedDB is unavailable) -->
            <div class="vectfox-cv-wiki-actions" id="vectfox_cv_wiki_legacy_actions" style="display: none;">
                <button id="vectfox_cv_scrape_wiki" class="vectfox-btn-primary">
                    <i class="fa-solid fa-download"></i> Scrape Wiki
                </button>
            </div>

            <!-- Source mode: latest scrape vs. selection basket -->
            <div class="vectfox-cv-wiki-source-mode" id="vectfox_cv_wiki_source_mode">
                <label title="Vectorize what the scrape above retrieved">
                    <input type="radio" name="vectfox_cv_wiki_source_mode" value="scrape" checked>
                    Latest scrape
                </label>
                <label title="Vectorize the pages you picked in the Wiki Library basket — can span multiple wikis">
                    <input type="radio" name="vectfox_cv_wiki_source_mode" value="basket">
                    <span id="vectfox_cv_wiki_basket_label">Selection basket (empty)</span>
                </label>
            </div>

            <!-- Status/Preview -->
            <div class="vectfox-cv-wiki-status" id="vectfox_cv_wiki_status"></div>

            <!-- Live results during scraping -->
            <div class="vectfox-cv-wiki-live" id="vectfox_cv_wiki_live" style="display: none;">
                <div class="vectfox-cv-wiki-live-counts" id="vectfox_cv_wiki_live_counts"></div>
                <ul class="vectfox-cv-wiki-live-list" id="vectfox_cv_wiki_live_list"></ul>
            </div>
            <div class="vectfox-cv-wiki-preview" id="vectfox_cv_wiki_preview" style="display: none;">
                <div class="vectfox-cv-wiki-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_wiki_title">Wiki content loaded</span>
                </div>
                <div class="vectfox-cv-wiki-preview-stats">
                    <span><strong id="vectfox_cv_wiki_pages">0</strong> pages</span>
                    <span><strong id="vectfox_cv_wiki_chars">0</strong> characters</span>
                </div>
                <details class="vectfox-cv-wiki-pages-details" id="vectfox_cv_wiki_pages_details">
                    <summary>Show scraped page titles</summary>
                    <ul id="vectfox_cv_wiki_page_list" class="vectfox-cv-wiki-page-list"></ul>
                </details>
            </div>
        </div>
    `;
}

/**
 * Renders YouTube source
 */
function renderYouTubeSource(type) {
    const options = type.sourceOptions;

    return `
        <div class="vectfox-cv-youtube-source">
            <!-- URL Input -->
            <div class="vectfox-cv-youtube-url">
                <label>YouTube URL or Video ID</label>
                <div class="vectfox-cv-youtube-input-row">
                    <input type="text" id="vectfox_cv_youtube_url"
                           class="vectfox-input"
                           placeholder="${options.placeholder}">
                    <button id="vectfox_cv_fetch_youtube" class="vectfox-btn-primary">
                        <i class="fa-brands fa-youtube"></i> Fetch
                    </button>
                </div>
            </div>

            <!-- Language (optional) -->
            <div class="vectfox-cv-youtube-lang">
                <label>
                    Language Code
                    <span class="vectfox-cv-optional">(optional)</span>
                </label>
                <input type="text" id="vectfox_cv_youtube_lang"
                       class="vectfox-input vectfox-input-sm"
                       placeholder="${options.langPlaceholder}"
                       maxlength="5"
                       style="width: 100px;">
                <div class="vectfox-cv-hint">
                    ISO 639-1 code (e.g., "en", "es", "ja"). Leave blank for auto-detect.
                </div>
            </div>

            <!-- Status/Preview -->
            <div class="vectfox-cv-youtube-status" id="vectfox_cv_youtube_status"></div>
            <div class="vectfox-cv-youtube-preview" id="vectfox_cv_youtube_preview" style="display: none;">
                <div class="vectfox-cv-youtube-preview-header">
                    <i class="fa-solid fa-check-circle"></i>
                    <span id="vectfox_cv_youtube_title">Transcript loaded</span>
                </div>
                <div class="vectfox-cv-youtube-preview-stats">
                    <span><strong id="vectfox_cv_youtube_chars">0</strong> characters</span>
                    <span><strong id="vectfox_cv_youtube_duration">~0</strong> min estimated</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Updates chunking strategy section
 */
// ============================================================================
// AUTO-REFORMAT (Document/URL/Wiki/Transcript only)
// ============================================================================

const REFORMAT_SUPPORTED_TYPES = ['document', 'url', 'wiki', 'youtube'];

function isReformatSupportedType() {
    return REFORMAT_SUPPORTED_TYPES.includes(currentContentType);
}

/**
 * Renders the Auto-Reformat section based on content type + current
 * currentSettings.reformat state. Safe to call any time content type or
 * reformat state changes (source-load, accept, discard, re-run).
 */
function renderReformatSection() {
    const section = $('#vectfox_cv_reformat_section');
    if (!isReformatSupportedType()) {
        section.hide();
        return;
    }
    section.show();

    const container = $('#vectfox_cv_reformat_content');
    const reformat = currentSettings.reformat;

    if (reformat?.accepted) {
        // A basket-sourced reformat is pinned to the exact page selection it
        // was accepted for; warn instead of silently orphaning it later
        const selectionDrifted = reformat.selectionHash != null
            && currentBasketSelectionHash != null
            && reformat.selectionHash !== currentBasketSelectionHash;
        container.html(`
            ${selectionDrifted ? `
            <div class="vectfox-cv-reformat-warning">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Your page selection changed since this Auto-Reformat was accepted — the reviewed entries no longer match the basket. Re-run Auto-Reformat, or discard it to chunk mechanically.</span>
            </div>` : ''}
            <div class="vectfox-cv-reformat-accepted">
                <i class="fa-solid fa-circle-check"></i>
                <span>Auto-Reformat accepted. Chunking Strategy below is bypassed — the reviewed entries will be stored as-is.</span>
            </div>
            <div class="vectfox-cv-reformat-actions">
                <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_discard">
                    <i class="fa-solid fa-rotate-left"></i> Discard &amp; Chunk Manually
                </button>
                <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_rerun">
                    <i class="fa-solid fa-arrows-rotate"></i> Re-run Auto-Reformat
                </button>
            </div>
        `);
        $('#vectfox_cv_reformat_discard').on('click', () => {
            currentSettings.reformat = null;
            const type = getContentType(currentContentType);
            renderReformatSection();
            updateChunkingSection(type);
        });
        $('#vectfox_cv_reformat_rerun').on('click', runAutoReformat);
        return;
    }

    container.html(`
        <div class="vectfox-cv-reformat-intro">
            <span>Optional: have an LLM read this content, split it into clean per-entity/per-topic entries, and use those as the final chunks — instead of the mechanical strategy below. You'll review every entry before anything is stored.</span>
        </div>
        <button class="vectfox-btn-secondary" id="vectfox_cv_reformat_run">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Run Auto-Reformat
        </button>
    `);
    $('#vectfox_cv_reformat_run').on('click', runAutoReformat);
}

/**
 * Resolves the current source into plain text suitable for the reformatter.
 * Forces wiki away from `per_page` (which would return an array of per-page
 * objects, not a single string the batching packer can consume).
 */
async function _resolveReformatSourceText(source, contentType = currentContentType, settings = currentSettings) {
    const { resolveAndPrepareContent } = await import('../core/content-vectorization.js');
    const prepSettings = contentType === 'wiki'
        ? { ...settings, strategy: 'adaptive' }
        : settings;
    const prepared = await resolveAndPrepareContent(contentType, source, prepSettings);
    if (typeof prepared.text === 'string') return prepared.text;
    if (Array.isArray(prepared.text)) {
        return prepared.text.map(t => (typeof t === 'string' ? t : t.text || '')).join('\n\n---\n\n');
    }
    return String(prepared.text || '');
}

/**
 * Asks the user what to do with an existing Auto-Reformat freeze for the
 * same source content: reuse it (free, instant) or re-run the LLM pass.
 * Escape/Cancel must never trigger a paid LLM run.
 *
 * @param {import('../core/reformat-store.js').ReformatCacheEntry} existing
 * @returns {Promise<'reuse'|'rerun'|'cancel'>}
 */
async function _promptReuseOrRerun(existing) {
    const acceptedDate = existing.acceptedAt ? new Date(existing.acceptedAt).toLocaleString() : 'unknown date';
    const { getCollectionRegistry } = await import('../core/collection-loader.js');
    const registry = getCollectionRegistry();
    // Registry entries may be registry-keyed ("backend:id") — match on the bare ID.
    const liveCollections = (Array.isArray(existing.vectorizedInto) ? existing.vectorizedInto : [])
        .filter(id => registry.some(key => key === id || String(key).endsWith(`:${id}`)));
    const vectorizedLine = liveCollections.length > 0
        ? `Vectorized into ${liveCollections.length} collection(s).`
        : 'Not vectorized into any collection yet.';

    const html = `
        <h3>Already Reformatted</h3>
        <p>This exact content already has a saved Auto-Reformat result:</p>
        <ul style="text-align:left;">
            <li><strong>${StringUtils.escapeHtml(existing.sourceName || 'Unnamed source')}</strong> — ${existing.chunks.length} chunks</li>
            <li>Accepted ${StringUtils.escapeHtml(acceptedDate)}${existing.providerModel ? ` (${StringUtils.escapeHtml(existing.providerModel)})` : ''}</li>
            <li>${vectorizedLine}</li>
        </ul>
        <p><strong>Reuse</strong> is instant and free. <strong>Re-run</strong> invokes the LLM again and
        replaces the saved result when you accept the new one.</p>
    `;

    // Same three-way convention as showTokenizerMismatchModal (core/tokenizer-lock.js):
    // OK/first button → true|1, customButtons → 2+, cancel/Escape → false|null.
    const choice = await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        okButton: 'Reuse saved result',
        cancelButton: 'Cancel',
        customButtons: ['Re-run fresh (uses LLM)'],
        wide: false,
    });

    if (choice === true || choice === 1) return 'reuse';
    if (choice === 2) return 'rerun';
    return 'cancel';
}

/**
 * Runs the Auto-Reformat LLM pass and opens the review modal. Reused for
 * both the initial "Run Auto-Reformat" click and "Re-run Auto-Reformat".
 */
async function runAutoReformat() {
    const source = getSourceData();
    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    invalidateAutoReformat();
    const run = reformatSession.start({ source, contentType: currentContentType, settings: resolveEffectiveSettings(currentSettings) });
    const { contentType, settings: mergedSettings } = run.snapshot;
    const stopButton = '<button id="vectfox_cv_reformat_stop" class="vectfox-btn-secondary">Cancel Auto-Reformat</button>';
    const container = $('#vectfox_cv_reformat_content');
    container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Preparing content...</div>');

    container.append(stopButton);
    try {
        const text = await _resolveReformatSourceText(run.snapshot.source, contentType, mergedSettings);
        run.assertCurrent();
        if (!text.trim()) {
            container.html('<div class="vectfox-cv-error">Could not load content. Please check your selection.</div>');
            return;
        }

        const { getStringHash } = await import('../../../../utils.js');
        run.assertCurrent();
        const sourceHash = getStringHash(text);


        const { getReformatCache } = await import('../core/reformat-store.js');
        run.assertCurrent();
        const existing = getReformatCache(sourceHash);
        if (existing?.chunks?.length) {
            const choice = await _promptReuseOrRerun(existing);
            run.assertCurrent();
            if (choice === 'reuse') {
                currentSettings.reformat = { accepted: true, sourceHash };
                renderReformatSection();
                updateChunkingSection(getContentType(currentContentType));
                toastr.info(`Reusing the saved Auto-Reformat result (${existing.chunks.length} chunks).`, 'VectFox');
                return;
            }
            if (choice === 'cancel') {
                renderReformatSection();
                return;
            }
            // 'rerun' — fall through to a fresh LLM pass. The old entry is left
            // in place: _finalizeReformatAccept overwrites it on accept, and a
            // discarded re-run leaves the old freeze usable.
        }

        container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Running Auto-Reformat...</div>');

        container.append(stopButton);
        const { reformatDocument } = await import('../core/reformat-extractor.js');
        const result = await reformatDocument({
            text,
            contentType,
            abortSignal: run.signal,
            settings: mergedSettings,
            onProgress: (done, total, phase) => {
                if (!run.isCurrent()) return;
                const label = phase === 'link'
                    ? `Running Auto-Reformat — linking pass (${done}/${total})...`
                    : `Running Auto-Reformat — extracting (${done}/${total} batches)...`;
                container.find('.vectfox-cv-loading').html(
                    `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`
                );
            },
        });

        run.assertCurrent();
        if (result.chunks.length === 0) {
            const extra = result.warnings.length ? ` ${result.warnings.join(' ')}` : '';
            container.html(`<div class="vectfox-cv-error">Auto-Reformat produced no entries.${extra}</div>`);
            return;
        }

        renderReformatSection();

        const { openReformatReview } = await import('./reformat-review.js');
        run.assertCurrent();
        const sourceName = source.name || source.filename || source.title || contentType;
        openReformatReview({
            chunks: result.chunks,
            warnings: result.warnings,
            sourceText: text,
            sourceName,
            contentType,
            onAccept: (acceptedRecords) => _finalizeReformatAccept({ run, contentType, acceptedRecords, sourceHash, text, sourceName, mergedSettings, selectionDescriptor: source.selectionDescriptor }),
            onDiscard: () => {
                if (!run.isCurrent()) return;
                reformatSession.cancel();
                renderReformatSection();
            },
            onRerun: () => { if (run.isCurrent()) runAutoReformat(); },
        });
    } catch (e) {
        if (!run.isCurrent() || e?.name === 'AbortError') return;
        console.error('VectFox: Auto-Reformat failed:', e);
        container.html(`<div class="vectfox-cv-error">Auto-Reformat failed: ${e.message}</div>`);
    }
}

/**
 * Persists an accepted Auto-Reformat draft: expands any oversized entity body
 * via the existing adaptive splitter, shapes every physical chunk into the
 * same {text, metadata} form chunkText() itself produces (so nothing
 * downstream needs special-casing), freezes it in reformat-store.js keyed by
 * sourceHash, and flips currentSettings.reformat to accepted.
 */
async function _finalizeReformatAccept({ run, contentType, acceptedRecords, sourceHash, text, sourceName, mergedSettings, selectionDescriptor }) {
    try {
        run.assertCurrent();
        const { expandOversizedChunk } = await import('../core/reformat-extractor.js');
        const { saveReformatCache, getReformatCache } = await import('../core/reformat-store.js');
        const { buildRelationalClause, REFORMAT_SCHEMA_VERSION } = await import('../core/reformat-schema.js');

        const maxBodyChars = mergedSettings.reformat_max_body_chars || 2000;
        const previous = getReformatCache(sourceHash);

        const shapedChunks = [];
        for (const record of acceptedRecords) {
            run.assertCurrent();
            const expanded = await expandOversizedChunk(record, maxBodyChars);
            run.assertCurrent();
            for (const piece of expanded) {
                shapedChunks.push({
                    // affiliation/relationships are otherwise inert metadata (never read by
                    // embedding, search, or the block injected into the roleplay model's
                    // context) — fold them into the stored/embedded text so they actually
                    // reach retrieval. See buildRelationalClause's docstring.
                    text: piece.body + buildRelationalClause(piece.affiliation, piece.relationships),
                    metadata: {
                        chunkIndex: shapedChunks.length,
                        totalChunks: 0, // patched below once the final count is known
                        strategy: 'llm_reformat',
                        provenance: piece.provenance,
                        sourceUrl: run.snapshot.source.url || '',
                        sourceId: piece.sourceId,
                        entry_type: piece.entry_type,
                        name: piece.name,
                        aliases: piece.aliases,
                        affiliation: piece.affiliation,
                        traits: piece.traits,
                        relationships: piece.relationships,
                        keywords: piece.keywords,
                        subChunkIndex: piece.subChunkIndex,
                        subChunkTotal: piece.subChunkTotal,
                    },
                });
            }
        }
        shapedChunks.forEach(c => { c.metadata.totalChunks = shapedChunks.length; });

        const providerModel = `${mergedSettings.reformat_provider || mergedSettings.summarize_provider || 'openrouter'}:${mergedSettings.reformat_model || mergedSettings.summarize_model || ''}`;

        run.assertCurrent();
        if (previous?.chunks?.length) {
            // Re-running Auto-Reformat produces a new, non-deterministic generation.
            // Document/URL/Wiki/Transcript vectorization always mints a brand-new collection per
            // run (there's no "same source → same collection" concept for these types,
            // unlike chat), so re-running can't silently duplicate data inside one
            // collection — but if the PREVIOUS generation was already vectorized into
            // its own collection, that old collection still exists independently.
            // Surface that plainly rather than guessing at which collection to touch.
            toastr.info(
                'This replaces the saved Auto-Reformat draft. If you already vectorized the previous version into a collection, that collection is untouched — delete it via Database Browser if you don\'t want both.',
                'VectFox',
                { timeOut: 10000 },
            );
        }

        if (text.length > 200000) {
            toastr.warning(
                `Auto-Reformat retains the original source text for audit (~${Math.round(text.length / 1024)} KB), adding to your settings storage size. Use "Clear Auto-Reformat originals" in Database Browser if this grows large.`,
                'VectFox',
                { timeOut: 10000 },
            );
        }

        // Stamp this generation's runId onto every chunk so DB-side chunks can
        // be traced back to the freeze that produced them (see reformat-store.js).
        const acceptedAt = Date.now();
        const runId = `${sourceHash}_${acceptedAt}`;
        shapedChunks.forEach(c => { c.metadata.reformatRunId = runId; });

        const { getStringHash: hashString } = await import('../../../../utils.js');
        run.publish(() => {
            saveReformatCache(sourceHash, {
                chunks: shapedChunks,
                originalText: text,
                contentType,
                sourceName,
                providerModel,
                schemaVersion: REFORMAT_SCHEMA_VERSION,
                selectionDescriptor: selectionDescriptor || '',
                acceptedAt,
            });

            // Basket sources also pin the exact page selection, so a later basket
            // edit can warn instead of silently orphaning the accepted result

            currentSettings.reformat = {
                accepted: true,
                sourceHash,
                ...(selectionDescriptor ? { selectionHash: hashString(selectionDescriptor) } : {}),
            };
        });
        toastr.success(`Auto-Reformat accepted: ${shapedChunks.length} chunk(s) ready. Click Vectorize to store them.`, 'VectFox');

        renderReformatSection();
        updateChunkingSection(getContentType(currentContentType));
    } catch (e) {
        if (!run.isCurrent() || e?.name === 'AbortError') return;
        console.error('VectFox: Failed to finalize Auto-Reformat accept:', e);
        toastr.error('Failed to save Auto-Reformat result: ' + e.message, 'VectFox');
    }
}

function updateChunkingSection(type) {
    const strategies = getChunkingStrategies(type.id);
    const defaults = getContentTypeDefaults(type.id);
    const selectedStrategyId = currentSettings.strategy || type.defaultStrategy;
    const isChatType = type.id === 'chat';

    // Default: ensure section is visible. The chat branch below may hide it for the
    // archive+EventBase route; non-chat types always need it visible.
    $('.vectfox-cv-chunking-section').show();

    const strategySelect = $('#vectfox_cv_strategy');
    strategySelect.empty();

    strategies.forEach(s => {
        const selected = s.id === selectedStrategyId;
        strategySelect.append(`<option value="${s.id}" ${selected ? 'selected' : ''}>${s.name}</option>`);
    });

    // Update description
    const currentStrategy = getChunkingStrategy(strategySelect.val());
    $('#vectfox_cv_strategy_desc').text(currentStrategy?.description || '');

    // Get strategy-specific defaults if available
    const strategyDefaults = currentStrategy || {};
    const chunkSize = currentSettings.chunkSize || strategyDefaults.defaultSize || defaults.chunkSize;
    const chunkOverlap = currentSettings.chunkOverlap || strategyDefaults.defaultOverlap || defaults.chunkOverlap;

    // Update size controls values
    $('#vectfox_cv_chunk_size').val(chunkSize);
    $('#vectfox_cv_chunk_size_val').text(chunkSize);
    $('#vectfox_cv_overlap').val(chunkOverlap);
    $('#vectfox_cv_overlap_val').text(chunkOverlap === 0 ? 'Off' : chunkOverlap);

    const batchSize = currentSettings.batchSize || defaults.batchSize || 4;

    $('#vectfox_cv_batch_size').val(batchSize);
    $('#vectfox_cv_batch_size_val').text(batchSize);

    // Chat history now follows EventBase extraction settings from the dedicated GUI,
    // so keep the legacy strategy selector populated for internal compatibility but
    // hide the visible controls only for chat. Other content types still use them.
    // Auto-Reformat, once accepted, IS the final chunk set — the strategy
    // dropdown/size sliders below would be inert, so hide them and say so.
    // Checked before isChatType since the two are mutually exclusive (chat
    // never supports Auto-Reformat) but this ordering keeps the precedence
    // explicit if that ever changes.
    const isReformatActive = isReformatSupportedType() && currentSettings.reformat?.accepted === true;

    $('#vectfox_cv_strategy_select_wrapper').toggle(!isChatType && !isReformatActive);
    if (isReformatActive) {
        $('#vectfox_cv_strategy_desc').text('Chunking handled by Auto-Reformat — see the section above.');
        $('#vectfox_cv_size_controls').hide();
        $('.vectfox-cv-chunking-section').show();
        $('#vectfox_cv_parallel_row').hide();
        return;
    }
    if (isChatType) {
        $('#vectfox_cv_strategy_desc').text('');
        $('#vectfox_cv_size_controls').hide();
        $('.vectfox-cv-chunking-section').show();
        $('#vectfox_cv_parallel_row').show();
        return;
    }

    // Show/hide size controls based on strategy type
    updateSizeControlsVisibility();
}

/**
 * Show/hide size controls based on strategy requirements
 * Unit-based strategies (per_message, per_entry, etc.) don't need size/overlap
 * Text-based strategies (recursive, paragraph, sliding) need them
 */
function updateSizeControlsVisibility() {
    const strategyId = $('#vectfox_cv_strategy').val();
    const strategy = getChunkingStrategy(strategyId);

    const needsSize = strategy?.needsSize ?? false;
    const needsOverlap = strategy?.needsOverlap ?? false;

    const needsMessageBatchControl = strategyId === 'message_batch';

    // Show/hide size controls based on strategy requirements
    const hasAnyControls = needsSize || needsOverlap;
    $('#vectfox_cv_size_controls').toggle(hasAnyControls || needsMessageBatchControl);

    // Show/hide individual controls
    $('#vectfox_cv_chunk_size_row').toggle(needsSize);
    $('#vectfox_cv_overlap_row').toggle(needsOverlap);
    $('#vectfox_cv_batch_size_row').toggle(needsMessageBatchControl);

    // Update description when strategy changes
    $('#vectfox_cv_strategy_desc').text(strategy?.description || '');
}

/**
 * Updates options section based on content type
 */
function updateOptionsSection(type) {
    const container = $('#vectfox_cv_options_content');
    container.empty();

    let html = '';

    // Scope control (for types that support it)
    if (hasFeature(type.id, 'scopeControl')) {
        html += renderScopeOptions(type);
    }

    // Field selection (for character type)
    if (hasFeature(type.id, 'fieldSelection')) {
        html += renderFieldSelection();
    }

    // Text Cleaning settings
    html += renderTextCleaningOptions();

    // Keyword extraction settings (only for types whose ingestion path reads them —
    // EventBase chat ingestion does not, so this is hidden for the chat type).
    if (hasFeature(type.id, 'keywordExtraction')) {
        html += `
            <div class="vectfox-cv-option-row vectfox-cv-keyword-settings">
                <div class="vectfox-cv-keyword-header">
                    <span>Keyword Extraction</span>
                </div>
                <div class="vectfox-cv-keyword-controls">
                    <div class="vectfox-cv-keyword-level">
                        <label for="vectfox_cv_keyword_level">Level:</label>
                        <select id="vectfox_cv_keyword_level" class="vectfox-select">
                            <option value="off" ${currentSettings.keywordLevel === 'off' ? 'selected' : ''}>
                                Off - Manual only
                            </option>
                            <option value="minimal" ${currentSettings.keywordLevel === 'minimal' ? 'selected' : ''}>
                                Minimal - Intro section (5 max)
                            </option>
                            <option value="balanced" ${currentSettings.keywordLevel === 'balanced' || !currentSettings.keywordLevel ? 'selected' : ''}>
                                Balanced - Header area (12 max)
                            </option>
                            <option value="aggressive" ${currentSettings.keywordLevel === 'aggressive' ? 'selected' : ''}>
                                Aggressive - Full text (15 max)
                            </option>
                        </select>
                    </div>
                    <div class="vectfox-cv-keyword-weight">
                        <label for="vectfox_cv_keyword_weight">Base Weight:</label>
                        <input type="number" id="vectfox_cv_keyword_weight"
                               min="0.01" max="3.0" step="0.01"
                               value="${currentSettings.keywordBaseWeight || 1.5}"
                               class="vectfox-input-number">
                        <span class="vectfox-cv-weight-hint">×</span>
                    </div>
                </div>
                <span class="vectfox-cv-option-hint">
                    ${type.id === 'lorebook'
                        ? 'WI trigger keys always included. Auto-extraction adds more based on text frequency.'
                        : 'Higher frequency words get higher weights. Base weight applies to all extracted keywords.'}
                </span>
            </div>
        `;
    }

    // Lorebook-specific: respect disabled entries
    if (hasFeature(type.id, 'respectDisabled')) {
        html += `
            <div class="vectfox-cv-option-row">
                <label class="vectfox-cv-toggle-label">
                    <span>Include Disabled Entries</span>
                    <label class="vectfox-toggle-switch">
                        <input type="checkbox" id="vectfox_cv_include_disabled">
                        <span class="vectfox-toggle-slider"></span>
                    </label>
                </label>
                <span class="vectfox-cv-option-hint">
                    Vectorize entries even if disabled in World Info
                </span>
            </div>
        `;
    }

    container.html(html);
}

/**
 * Renders scope selection options with actual character/chat names
 */
function renderScopeOptions(type) {
    const defaultScope = type.defaults?.scope || 'character';
    const context = getContext();

    // Get current character name (if any)
    const hasCharacter = !!context?.characterId;
    const characterName = context?.name2 || 'No character';

    // Get current chat name (if any)
    const hasChat = !!context?.chatId;
    let chatName = 'No chat';
    if (hasChat) {
        // Try to get a meaningful chat name
        if (typeof chat_metadata !== 'undefined' && chat_metadata?.chat_name) {
            chatName = chat_metadata.chat_name;
        } else {
            chatName = `Chat #${context.chatId}`;
        }
    }

    const scopeData = [
        {
            id: 'character',
            name: hasCharacter ? characterName : 'Character',
            desc: hasCharacter ? `Only with ${characterName}` : 'No character selected',
            icon: 'fa-user',
            enabled: hasCharacter,
        },
        {
            id: 'chat',
            name: hasChat ? 'This Chat' : 'Chat',
            desc: hasChat ? chatName : 'No chat open',
            icon: 'fa-comment',
            enabled: hasChat,
        },
    ];

    return `
        <div class="vectfox-cv-scope-select">
            <label>Scope</label>
            <div class="vectfox-cv-scope-options">
                ${scopeData.map(scope => `
                    <label class="vectfox-cv-scope-option ${scope.id === defaultScope ? 'selected' : ''} ${!scope.enabled ? 'disabled' : ''}">
                        <input type="radio" name="vectfox_cv_scope" value="${scope.id}"
                               ${scope.id === defaultScope ? 'checked' : ''}
                               ${!scope.enabled ? 'disabled' : ''}>
                        <div class="vectfox-cv-scope-card">
                            <i class="fa-solid ${scope.icon}"></i>
                            <span class="vectfox-cv-scope-name">${scope.name}</span>
                            <span class="vectfox-cv-scope-desc">${scope.desc}</span>
                        </div>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders character field selection
 */
function renderFieldSelection() {
    const defaults = getContentTypeDefaults('character');

    return `
        <div class="vectfox-cv-field-select">
            <label>Fields to Vectorize</label>
            <div class="vectfox-cv-field-grid">
                ${CHARACTER_FIELDS.map(field => `
                    <label class="vectfox-cv-field-option">
                        <input type="checkbox" name="vectfox_cv_field"
                               value="${field.id}"
                               ${defaults.fields?.[field.id] ? 'checked' : ''}>
                        <span class="vectfox-cv-field-name">${field.name}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Renders text cleaning options with preset dropdown and manage button
 */
function renderTextCleaningOptions() {
    // Import dynamically to get current settings
    const presets = [
        { id: 'none', name: 'None', desc: 'No cleaning applied' },
        { id: 'html_formatting', name: 'Strip HTML Formatting', desc: 'Removes font, color, bold/italic tags' },
        { id: 'metadata_blocks', name: 'Strip Metadata Blocks', desc: 'Removes hidden divs, details sections' },
        { id: 'ai_reasoning', name: 'Strip AI Reasoning Tags', desc: 'Removes thinking, tucao tags' },
        { id: 'comprehensive', name: 'Comprehensive Clean', desc: 'All formatting + metadata + reasoning' },
        { id: 'nuclear', name: 'Strip All HTML', desc: 'Plain text only' },
        { id: 'mvu_game_maker', name: 'MVU Game Maker', desc: 'Strips MVU engine tags + standard formatting' },
        { id: 'custom', name: 'Custom', desc: 'Your own pattern selection' },
    ];

    const currentPreset = currentSettings.cleaningPreset || getCleaningSettings().selectedPreset || 'custom';

    return `
        <div class="vectfox-cv-option-row vectfox-cv-cleaning-settings">
            <div class="vectfox-cv-cleaning-header">
                <span>Text Cleaning</span>
                <button class="vectfox-btn-icon" id="vectfox_cv_manage_cleaning" title="Manage Cleaning Patterns">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
            <div class="vectfox-cv-cleaning-controls">
                <div class="vectfox-cv-cleaning-preset">
                    <label for="vectfox_cv_cleaning_preset">Preset:</label>
                    <select id="vectfox_cv_cleaning_preset" class="vectfox-select">
                        ${presets.map(p => `
                            <option value="${p.id}" ${p.id === currentPreset ? 'selected' : ''}>
                                ${p.name}
                            </option>
                        `).join('')}
                    </select>
                </div>
            </div>
            <span class="vectfox-cv-option-hint" id="vectfox_cv_cleaning_hint">
                ${presets.find(p => p.id === currentPreset)?.desc || ''}
            </span>
        </div>
    `;
}

// ============================================================================
// EVENT BINDING
// ============================================================================

/**
 * Binds all event handlers
 */
function bindEvents() {
    $('#vectfox_content_vectorizer_modal').on('input.reformat change.reformat', 'input, select, textarea', () => {
        invalidateAutoReformat();
        renderReformatSection();
    }).on('click.reformat', '#vectfox_cv_reformat_stop', () => {
        invalidateAutoReformat();
        renderReformatSection();
        toastr.info('Auto-Reformat cancelled. Previously accepted results were kept.', 'VectFox');
    });
    // Close handlers
    $('#vectfox_cv_close').on('click', closeContentVectorizer);
    $('#vectfox_cv_cancel').on('click', function() {
        if (isVectorizing) {
            stopActiveVectorization();
            return;
        }
        closeContentVectorizer();
    });
    $('#vectfox_content_vectorizer_modal .vectfox-modal-overlay').on('click', function() {
        if (!isVectorizing) closeContentVectorizer();
    });

    // Content type dropdown selection
    $('#vectfox_cv_type_select').on('change', function() {
        const type = $(this).val();

        if (!type) {
            // No selection - hide subsequent sections
            currentContentType = null;
            currentSettings = {};
            $('.vectfox-cv-subsequent').slideUp(200);
            $('#vectfox_cv_type_hint').text('Select a content type to continue');
            return;
        }

        currentContentType = type;
        currentSettings = { ...getContentTypeDefaults(type) };

        // Show type-specific hint
        const typeInfo = getContentType(type);
        $('#vectfox_cv_type_hint').text(typeInfo?.description || '');

        // Show subsequent sections and update UI
        $('.vectfox-cv-subsequent').slideDown(200);
        updateUIForContentType();
    });

    // Start From Message input
    $(document).on('change input', '#vectfox_cv_startfrom', function() {
        const v = parseInt($(this).val(), 10);
        startFromMessage = Number.isFinite(v) && v >= 1 ? v : 1;
        $(this).val(startFromMessage);
    });

    // Collapse toggles
    $('.vectfox-cv-collapse-btn').on('click', function() {
        const target = $(this).data('target');
        const content = $(`#vectfox_cv_${target}_content`);
        const icon = $(this).find('i');

        content.slideToggle(200);
        icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Strategy change
    $('#vectfox_cv_strategy').on('change', function() {
        const strategy = $(this).val();
        const type = getContentType(currentContentType);
        const strategies = getChunkingStrategies(currentContentType);
        const selected = strategies.find(s => s.id === strategy);

        $('#vectfox_cv_strategy_desc').text(selected?.description || '');
        currentSettings.strategy = strategy;
        updateSizeControlsVisibility();
    });

    // Size sliders
    $('#vectfox_cv_chunk_size').on('input', function() {
        const val = $(this).val();
        $('#vectfox_cv_chunk_size_val').text(val);
        currentSettings.chunkSize = parseInt(val);
    });

    $('#vectfox_cv_overlap').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_overlap_val').text(val === 0 ? 'Off' : val);
        currentSettings.chunkOverlap = val;
    });

    $('#vectfox_cv_batch_size').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_batch_size_val').text(val);
        currentSettings.batchSize = val;
    });

    $('#vectfox_cv_parallel_windows').on('input', function() {
        const val = parseInt($(this).val());
        $('#vectfox_cv_parallel_val').text(val);
    });

    // Scope selection
    $(document).on('change', 'input[name="vectfox_cv_scope"]', function() {
        currentSettings.scope = $(this).val();
        $('.vectfox-cv-scope-option').removeClass('selected');
        $(this).closest('.vectfox-cv-scope-option').addClass('selected');
    });

    // Keyword level dropdown
    $(document).on('change', '#vectfox_cv_keyword_level', function() {
        currentSettings.keywordLevel = $(this).val();
    });

    // Keyword base weight
    $(document).on('change', '#vectfox_cv_keyword_weight', function() {
        const value = parseFloat($(this).val());
        currentSettings.keywordBaseWeight = isNaN(value) ? 1.5 : Math.min(3.0, Math.max(0.01, value));
        $(this).val(currentSettings.keywordBaseWeight);
    });

    // Cleaning preset dropdown
    $(document).on('change', '#vectfox_cv_cleaning_preset', function() {
        const presetId = $(this).val();
        currentSettings.cleaningPreset = presetId;

        // Update hint text
        const hints = {
            none: 'No cleaning applied',
            html_formatting: 'Removes font, color, bold/italic tags',
            metadata_blocks: 'Removes hidden divs, details sections',
            ai_reasoning: 'Removes thinking, tucao tags',
            comprehensive: 'All formatting + metadata + reasoning',
            nuclear: 'Plain text only',
            mvu_game_maker: 'Strips MVU engine tags (UpdateVariable, combat_calculation, StoryAnalysis, combat_log) + standard formatting',
            custom: 'Your own pattern selection',
        };
        $('#vectfox_cv_cleaning_hint').text(hints[presetId] || '');

        // Save to extension settings
        saveCleaningPresetToSettings(presetId);
    });

    // Manage cleaning patterns button - opens the standalone Text Cleaning Manager
    // Uses modal-scoped delegation since modal has stopPropagation on all clicks
    $('#vectfox_content_vectorizer_modal').on('click', '#vectfox_cv_manage_cleaning', function(e) {
        e.preventDefault();
        openTextCleaningManager();
    });

    // Preview button
    $('#vectfox_cv_preview_btn').on('click', previewChunks);

    // Continue button (backfill - skips purge, DB dedup handles already-inserted chunks)
    $('#vectfox_cv_continue').on('click', startContinueVectorization);

    // Vectorize button
    $('#vectfox_cv_vectorize').on('click', startVectorization);
}

/**
 * Binds source-specific events
 */
function bindSourceEvents(type) {
    // Source tabs (skip disabled tabs)
    $('.vectfox-cv-source-tab:not([disabled])').on('click', function() {
        if ($(this).prop('disabled')) return;
        const source = $(this).data('source');
        $('.vectfox-cv-source-tab').removeClass('active');
        $(this).addClass('active');
        $('.vectfox-cv-source-panel').hide();
        $(`.vectfox-cv-source-panel[data-panel="${source}"]`).show();

        // Clear sourceData when switching tabs
        invalidateAutoReformat();
        sourceData = null;

        // Always hide chunking for chat uploads — EventBase uses its own window/overlap settings
        if (currentContentType === 'chat') {
            const hideChunking = source === 'upload';
            $('.vectfox-cv-chunking-section').toggle(!hideChunking);
        }
    });

    // Input method tabs (for document type)
    $('.vectfox-cv-input-tab').on('click', function() {
        const method = $(this).data('method');
        $('.vectfox-cv-input-tab').removeClass('active');
        $(this).addClass('active');
        $('.vectfox-cv-input-panel').hide();
        $(`.vectfox-cv-input-panel[data-panel="${method}"]`).show();
    });

    // Upload zone click (all upload zones)
    $('#vectfox_cv_upload_zone, #vectfox_cv_doc_upload_zone, #vectfox_cv_chat_upload_zone').on('click', function(e) {
        // Don't trigger if clicking the input itself
        if (e.target.tagName === 'INPUT') return;
        $(this).find('input[type="file"]').trigger('click');
    });

    // Upload zone drag and drop
    $('#vectfox_cv_upload_zone, #vectfox_cv_doc_upload_zone, #vectfox_cv_chat_upload_zone')
        .on('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).addClass('dragover');
        })
        .on('dragleave', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');
        })
        .on('drop', function(e) {
            e.preventDefault();
            e.stopPropagation();
            $(this).removeClass('dragover');

            const files = e.originalEvent.dataTransfer.files;
            if (files.length > 0) {
                // Get the file input and set the files
                const input = $(this).find('input[type="file"]')[0];
                // Create a new DataTransfer to set files on the input
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(files[0]);
                input.files = dataTransfer.files;
                // Trigger change event to process the file
                $(input).trigger('change');
            }
        });

    // File input change
    $('#vectfox_cv_file_input, #vectfox_cv_doc_file_input').on('change', handleFileUpload);

    // Chat file input change (special handler for chat files)
    $('#vectfox_cv_chat_file_input').on('change', handleChatFileUpload);

    // Clear upload
    $('#vectfox_cv_upload_clear').on('click', clearUpload);
    $('#vectfox_cv_chat_upload_clear').on('click', clearChatUpload);

    // Fetch URL
    $('#vectfox_cv_fetch_url').on('click', fetchUrl);

    // Wiki scraping
    $('#vectfox_cv_scrape_wiki').on('click', scrapeWiki);
    $('#vectfox_cv_wiki_type').on('change', function() {
        const wikiType = $(this).val();
        const type = getContentType('wiki');
        const typeInfo = type.sourceOptions.types.find(t => t.id === wikiType);
        if (typeInfo) {
            $('#vectfox_cv_wiki_url').attr('placeholder', typeInfo.placeholder);
        }
        // Re-check plugin availability
        checkWikiPluginStatus();
    });

    // YouTube fetch
    $('#vectfox_cv_fetch_youtube').on('click', fetchYouTubeTranscript);

    // Source select change - show stats
    $('#vectfox_cv_source_select').on('change', function() {
        const value = $(this).val();
        if (value) {
            loadSourceStats(type.id, value);
        } else {
            $('#vectfox_cv_source_stats').hide();
        }
    });

    // Populate select if needed
    if (type.sourceType === 'select') {
        populateSourceSelect(type);
    }

    // Check wiki plugin availability when wiki type is selected
    if (type.sourceType === 'wiki') {
        checkWikiPluginStatus();
        initWikiLibrarySection();
    }
}

/**
 * Loads and displays stats for the selected source
 */
async function loadSourceStats(contentType, sourceId) {
    const statsContainer = $('#vectfox_cv_source_stats');
    statsContainer.show().html('<div class="vectfox-cv-stats-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading info...</div>');

    try {
        if (contentType === 'lorebook') {
            // Load lorebook info
            const worldInfoModule = await import('../../../../world-info.js');
            const loadWorldInfo = worldInfoModule.loadWorldInfo;

            if (loadWorldInfo) {
                const data = await loadWorldInfo(sourceId);
                const entries = data?.entries ? Object.values(data.entries) : [];
                const enabledEntries = entries.filter(e => !e.disable);
                const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                statsContainer.html(`
                    <div class="vectfox-cv-stats-grid">
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${entries.length}</span>
                            <span class="vectfox-cv-stat-label">Total Entries</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${enabledEntries.length}</span>
                            <span class="vectfox-cv-stat-label">Enabled</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vectfox-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vectfox-cv-stats-info">Lorebook selected</div>');
            }

        } else if (contentType === 'character') {
            // Load character info
            const context = getContext();
            const character = context?.characters?.find(c => c.avatar === sourceId);

            if (character) {
                const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
                const filledFields = fields.filter(f => character[f]?.trim());
                const totalChars = fields.reduce((sum, f) => sum + (character[f]?.length || 0), 0);

                statsContainer.html(`
                    <div class="vectfox-cv-stats-grid">
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${filledFields.length}/${fields.length}</span>
                            <span class="vectfox-cv-stat-label">Fields Used</span>
                        </div>
                        <div class="vectfox-cv-stat">
                            <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                            <span class="vectfox-cv-stat-label">Characters</span>
                        </div>
                    </div>
                `);
            } else {
                statsContainer.html('<div class="vectfox-cv-stats-info">Character selected</div>');
            }
        }
    } catch (e) {
        console.error('VectFox: Failed to load source stats:', e);
        statsContainer.html('<div class="vectfox-cv-stats-info">Selected</div>');
    }
}

/**
 * Populates the source dropdown based on type
 */
async function populateSourceSelect(type) {
    const select = $('#vectfox_cv_source_select');
    select.empty().append('<option value="">-- Select --</option>');

    try {
        if (type.id === 'lorebook') {
            // Import world_names from ST's world-info module (same as legacy)
            try {
                const worldInfoModule = await import('../../../../world-info.js');
                const worldNames = worldInfoModule.world_names || [];

                if (worldNames && worldNames.length > 0) {
                    worldNames.forEach(name => {
                        // Books owned by Fatbody's Lore Router hold its stat/world-state
                        // tracking and must not be vectorized — VectFox would fight Fatbody's
                        // controlled activation. Show them disabled so the user understands why.
                        if (isFatbodyOwnedBook(name)) {
                            select.append(`<option value="${name}" disabled>${name} (managed by Fatbody DnD)</option>`);
                        } else {
                            select.append(`<option value="${name}">${name}</option>`);
                        }
                    });
                } else {
                    select.append('<option value="" disabled>No lorebooks found</option>');
                }
            } catch (importError) {
                console.warn('VectFox: Could not import world-info module:', importError);
                select.append('<option value="" disabled>Could not load lorebooks</option>');
            }

        } else if (type.id === 'character') {
            // Get available characters from context
            const context = getContext();
            const characters = context?.characters || [];

            if (characters.length > 0) {
                // Add current character at top if available
                if (context?.characterId) {
                    const currentChar = characters.find(c => c.avatar === context.characterId);
                    if (currentChar) {
                        select.append(`<option value="${StringUtils.escapeHtml(currentChar.avatar)}" selected>📌 ${StringUtils.escapeHtml(currentChar.name)} (current)</option>`);
                    }
                }

                // Add all other characters
                characters.forEach(char => {
                    // Skip if already added as current
                    if (char.avatar === context?.characterId) return;
                    select.append(`<option value="${StringUtils.escapeHtml(char.avatar)}">${StringUtils.escapeHtml(char.name)}</option>`);
                });
            } else {
                select.append('<option value="" disabled>No characters found</option>');
            }
        }
    } catch (e) {
        console.error('VectFox: Failed to populate source select:', e);
        select.append('<option value="" disabled>Error loading sources</option>');
    }
}

// ============================================================================
// FILE HANDLING
// ============================================================================

/**
 * Handles file upload (lorebook JSON, character PNG/JSON)
 */
function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();

    // PNG character cards need special handling (embedded JSON in tEXt chunk)
    if (ext === 'png') {
        handleCharacterPngUpload(file);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;

        // For lorebook JSON, parse and validate
        if (currentContentType === 'lorebook' && ext === 'json') {
            try {
                const data = JSON.parse(content);
                // ST lorebook format has entries object
                if (data.entries) {
                    const entries = Object.values(data.entries).filter(e => e.content);
                    invalidateAutoReformat();
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: entries,
                        entries: entries,
                        name: file.name.replace(/\.[^/.]+$/, ''),
                    };

                    // Show stats
                    const enabledCount = entries.filter(e => !e.disable).length;
                    const totalChars = entries.reduce((sum, e) => sum + (e.content?.length || 0), 0);

                    $('#vectfox_cv_upload_zone').hide();
                    $('#vectfox_cv_upload_info').show();
                    $('#vectfox_cv_upload_filename').text(file.name);

                    toastr.success(`Loaded lorebook: ${entries.length} entries (${enabledCount} enabled)`, 'VectFox');
                } else {
                    throw new Error('Invalid lorebook format - missing entries');
                }
            } catch (err) {
                toastr.error(`Failed to parse lorebook: ${err.message}`);
                return;
            }
        } else if (currentContentType === 'character' && ext === 'json') {
            // Character JSON file
            try {
                const data = JSON.parse(content);
                // Look for character data fields
                if (data.name || data.description || data.personality) {
                    invalidateAutoReformat();
                    sourceData = {
                        type: 'file',
                        filename: file.name,
                        content: data,
                        character: data,
                        name: data.name || file.name.replace(/\.[^/.]+$/, ''),
                    };

                    $('#vectfox_cv_upload_zone').hide();
                    $('#vectfox_cv_upload_info').show();
                    $('#vectfox_cv_upload_filename').text(`${data.name || file.name}`);

                    toastr.success(`Loaded character: ${data.name || 'Unknown'}`, 'VectFox');
                } else {
                    throw new Error('Invalid character format - missing name/description');
                }
            } catch (err) {
                toastr.error(`Failed to parse character: ${err.message}`);
                return;
            }
        } else {
            // Generic file upload
            invalidateAutoReformat();
            sourceData = {
                type: 'file',
                filename: file.name,
                content: content,
            };

            $('#vectfox_cv_upload_zone').hide();
            $('#vectfox_cv_upload_info').show();
            $('#vectfox_cv_upload_filename').text(file.name);

            // Auto-fill document name
            if (currentContentType === 'document') {
                $('#vectfox_cv_doc_name').val(file.name.replace(/\.[^/.]+$/, ''));
            }

            toastr.success(`Loaded: ${file.name}`, 'VectFox');
        }
    };

    reader.readAsText(file);
}

/**
 * Handles PNG character card upload
 * PNG character cards have JSON data embedded in the tEXt chunk with keyword "chara"
 */
async function handleCharacterPngUpload(file) {
    try {
        // Read PNG as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // Extract character data from PNG tEXt chunk
        const characterData = extractCharaFromPng(bytes);

        if (!characterData) {
            throw new Error('No character data found in PNG');
        }

        invalidateAutoReformat();
        sourceData = {
            type: 'file',
            filename: file.name,
            content: characterData,
            character: characterData,
            name: characterData.name || file.name.replace(/\.[^/.]+$/, ''),
        };

        $('#vectfox_cv_upload_zone').hide();
        $('#vectfox_cv_upload_info').show();
        $('#vectfox_cv_upload_filename').text(`${characterData.name || file.name}`);

        // Show character stats
        const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        const filledFields = fields.filter(f => characterData[f]?.trim());
        const totalChars = fields.reduce((sum, f) => sum + (characterData[f]?.length || 0), 0);

        toastr.success(`Loaded character: ${characterData.name} (${filledFields.length} fields, ${(totalChars/1000).toFixed(1)}k chars)`, 'VectFox');

    } catch (err) {
        console.error('VectFox: PNG parse error:', err);
        toastr.error(`Failed to parse character PNG: ${err.message}`);
    }
}

/**
 * Extracts character data from PNG tEXt chunk
 * Character cards store JSON data base64-encoded in a tEXt chunk with keyword "chara"
 * @param {Uint8Array} bytes - PNG file bytes
 * @returns {object|null} Parsed character data or null
 */
function extractCharaFromPng(bytes) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== pngSignature[i]) {
            throw new Error('Not a valid PNG file');
        }
    }

    // Read chunks
    let offset = 8; // Skip signature

    while (offset < bytes.length) {
        // Read chunk length (4 bytes, big endian)
        const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
                       (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += 4;

        // Read chunk type (4 bytes ASCII)
        const type = String.fromCharCode(bytes[offset], bytes[offset + 1],
                                         bytes[offset + 2], bytes[offset + 3]);
        offset += 4;

        if (type === 'tEXt') {
            // tEXt chunk: keyword (null-terminated) + text data
            const dataStart = offset;
            const dataEnd = offset + length;

            // Find null terminator for keyword
            let nullPos = dataStart;
            while (nullPos < dataEnd && bytes[nullPos] !== 0) {
                nullPos++;
            }

            const keyword = new TextDecoder().decode(bytes.slice(dataStart, nullPos));

            if (keyword === 'chara') {
                // Get the base64 data after the null terminator
                const base64Data = new TextDecoder().decode(bytes.slice(nullPos + 1, dataEnd));

                // Decode base64 to JSON
                try {
                    const jsonStr = atob(base64Data);
                    const charData = JSON.parse(jsonStr);

                    // Handle V2 format (data wrapped in 'data' object)
                    if (charData.spec === 'chara_card_v2' && charData.data) {
                        return charData.data;
                    }

                    return charData;
                } catch (e) {
                    console.error('VectFox: Failed to decode character data:', e);
                    throw new Error('Invalid character data in PNG');
                }
            }
        }

        // Skip chunk data and CRC (4 bytes)
        offset += length + 4;

        // Safety check for IEND
        if (type === 'IEND') break;
    }

    return null;
}

/**
 * Clears uploaded file
 */
function clearUpload() {
    invalidateAutoReformat();
    sourceData = null;
    $('#vectfox_cv_upload_zone').show();
    $('#vectfox_cv_upload_info').hide();
    $('#vectfox_cv_file_input, #vectfox_cv_doc_file_input').val('');
}

/**
 * Fetches content from URL
 */
async function fetchUrl() {
    const url = $('#vectfox_cv_url_input').val().trim();
    if (!url) {
        toastr.warning('Please enter a URL');
        return;
    }

    // Validate URL format
    try {
        new URL(url);
    } catch {
        toastr.warning('Please enter a valid URL (including http:// or https://)');
        return;
    }

    const status = $('#vectfox_cv_url_status');
    const preview = $('#vectfox_cv_url_preview');
    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching...');
    preview.hide();

    try {
        // Use ST's readability endpoint if available
        const response = await fetch('/api/serpapi/visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const content = data.content || data.text || '';

        if (!content || content.length < 50) {
            throw new Error('No meaningful content found on page');
        }

        invalidateAutoReformat();
        sourceData = {
            type: 'url',
            url: url,
            content: content,
            title: data.title || url,
        };

        status.html('');

        // Show preview
        $('#vectfox_cv_url_title').text(sourceData.title);
        $('#vectfox_cv_url_chars').text(content.length.toLocaleString());
        preview.show();

        toastr.success(`Fetched ${content.length.toLocaleString()} characters`, 'VectFox');

    } catch (e) {
        console.error('VectFox: URL fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
        toastr.error('Failed to fetch URL: ' + e.message);
    }
}

// ============================================================================
// WIKI SCRAPING
// ============================================================================

/**
 * Shows whether the optional Fandom Scraper plugin is installed.
 * Scraping runs in the browser via the built-in scraper either way — the
 * plugin is only a fallback for wikis that block browser access, so this
 * never disables the scrape button.
 */
async function checkWikiPluginStatus() {
    const statusEl = $('#vectfox_cv_wiki_plugin_status');
    const wikiType = $('#vectfox_cv_wiki_type').val() || 'fandom';

    // e621 uses its own CORS-open JSON API — no plugin exists for it, so
    // don't probe and don't advertise a fallback that can't help.
    if (wikiType === 'e621') {
        statusEl.html(`
            <i class="fa-solid fa-check-circle" style="color: var(--vectfox-success);"></i>
            <span>Built-in browser scraper ready (no plugin needed for e621)</span>
        `);
        return;
    }

    const isAvailable = await isWikiPluginAvailable(wikiType);

    if (isAvailable) {
        statusEl.html(`
            <i class="fa-solid fa-check-circle" style="color: var(--vectfox-success);"></i>
            <span>Built-in browser scraper ready (Fandom Scraper plugin available as fallback)</span>
        `);
    } else {
        const type = getContentType('wiki');
        statusEl.html(`
            <i class="fa-solid fa-circle-info"></i>
            <span>Built-in browser scraper ready. Optional:</span>
            <a href="${type.sourceOptions.pluginUrl}" target="_blank" rel="noopener" class="vectfox-cv-plugin-link">
                fallback plugin
            </a>
            <span>for wikis that block browser access</span>
        `);
    }
}

/**
 * Install hint shown only after the built-in scraper was actually blocked
 * by a wiki and no fallback plugin is installed.
 */
function renderPluginHint() {
    const type = getContentType('wiki');
    return `
        <div class="vectfox-cv-wiki-plugin-warning">
            <i class="fa-solid fa-exclamation-triangle" style="color: var(--vectfox-warning);"></i>
            <span>This wiki blocks browser scraping — install the Fandom Scraper plugin to scrape it</span>
            <a href="${type.sourceOptions.pluginUrl}" target="_blank" rel="noopener" class="vectfox-cv-plugin-link">
                <i class="fa-solid fa-external-link"></i> Install Plugin
            </a>
        </div>
    `;
}

/**
 * Scrapes in session-only mode when the Wiki Library is unavailable.
 */
async function scrapeWiki() {
    if (wikiLibrary.isBusy()) { wikiLibrary.cancelHard(); return; }
    const wikiType = $('#vectfox_cv_wiki_type').val();
    const url = $('#vectfox_cv_wiki_url').val().trim();
    const filter = $('#vectfox_cv_wiki_filter').val().trim();
    if (!url && wikiType !== 'e621') { toastr.warning('Please enter a wiki URL or ID'); return; }
    if (wikiType === 'e621' && !await callGenericPopup(
        '<p>This downloads the full e621 wiki corpus and can take several minutes. Continue?</p>', POPUP_TYPE.CONFIRM)) return;
    const status = $('#vectfox_cv_wiki_status');
    const button = $('#vectfox_cv_scrape_wiki');
    button.text('Cancel');
    status.text('Fetching wiki content…');
    $('#vectfox_cv_wiki_preview').hide();
    try {
        const result = await wikiLibrary.acquireWiki({ wikiType, url, filter, kind: 'full', persistent: false });
        if (!result.source?.pageCount) throw new Error('No content found');
        invalidateAutoReformat();
        sourceData = result.source;
        showWikiPreview(sourceData.pages, sourceData.content);
        status.text(result.warning);
        toastr.warning(result.warning, 'VectFox');
    } catch (error) {
        status.text(error.code === 'aborted' ? 'Scrape cancelled' : `Wiki task failed: ${error.message}`);
    } finally {
        button.text('Scrape');
    }
}
/**
 * Renders the shared wiki preview panel (page/char counts + title list).
 * Page titles are remote-controlled strings — build the list with .text()
 * so they can never be interpreted as HTML.
 */
function showWikiPreview(pages, combinedContent) {
    $('#vectfox_cv_wiki_title').text(`${pages.length} page(s) scraped`);
    $('#vectfox_cv_wiki_pages').text(pages.length);
    $('#vectfox_cv_wiki_chars').text(combinedContent.length.toLocaleString());

    const pageList = $('#vectfox_cv_wiki_page_list').empty();
    for (const page of pages) {
        pageList.append($('<li>').text(String(page.title)));
    }
    $('#vectfox_cv_wiki_pages_details').prop('open', pages.length <= 15);
    $('#vectfox_cv_wiki_preview').show();
}

// ============================================================================
// WIKI LIBRARY SECTION
// ============================================================================
// The persistent scrape flow: Index Titles / Fetch Everything / Stop & Keep /
// Cancel / Resume, with a live list of results as they land. Everything runs
// through core/wiki-library-service.js so pages survive stops, cancels, and
// reloads. The legacy one-shot scrapeWiki() above remains only as the
// degraded path when IndexedDB is unavailable.

let wikiLibraryUnsubs = [];
let wikiLiveTitles = [];
let wikiLiveRenderQueued = false;
let wikiLibraryAvailable = null; // null = not probed yet
let wikiSourceMode = 'scrape'; // 'scrape' | 'basket'
let stashedScrapeSourceData = null; // scrape sourceData parked while basket mode is active
let currentBasketSelectionHash = null; // hash of the materialized basket's selectionDescriptor

function teardownWikiLibraryEvents() {
    for (const unsub of wikiLibraryUnsubs) {
        try { unsub(); } catch { /* already gone */ }
    }
    wikiLibraryUnsubs = [];
}

/**
 * Wires the Wiki Library controls of the wiki source section. Called from
 * bindSourceEvents each time the wiki section is (re)rendered.
 */
async function initWikiLibrarySection() {
    teardownWikiLibraryEvents();
    wikiLiveTitles = [];

    if (wikiLibraryAvailable === null) {
        wikiLibraryAvailable = await wikiLibrary.isStoreAvailable();
    }
    if (!wikiLibraryAvailable) {
        // Degraded mode: the legacy in-memory one-shot flow
        $('#vectfox_cv_wiki_library_actions').hide();
        $('#vectfox_cv_wiki_legacy_actions').show();
        $('#vectfox_cv_wiki_status').html('<i class="fa-solid fa-triangle-exclamation"></i> Browser storage unavailable — scrapes will not be saved (legacy mode).');
        return;
    }

    $('#vectfox_cv_index_titles').on('click', () => runWikiLibraryTask('index'));
    $('#vectfox_cv_fetch_everything').on('click', () => runWikiLibraryTask('full'));
    $('#vectfox_cv_resume_indexing').on('click', () => runWikiLibraryTask('resume'));
    $('#vectfox_cv_stop_keep').on('click', () => {
        wikiLibrary.stopAndKeep();
        $('#vectfox_cv_wiki_status').html('<i class="fa-solid fa-spinner fa-spin"></i> Stopping after the current batch (results are kept)…');
    });
    $('#vectfox_cv_cancel_scrape').on('click', () => wikiLibrary.cancelHard());
    $('#vectfox_cv_open_library').on('click', async () => {
        const { openWikiLibrary } = await import('./wiki-library.js');
        await openWikiLibrary();
    });
    $('#vectfox_cv_wiki_type').on('change', updateWikiButtonsForType);
    $('#vectfox_cv_wiki_url').on('change', () => { refreshWikiLibraryPanel(); });

    $('input[name="vectfox_cv_wiki_source_mode"]').on('change', function() {
        setWikiSourceMode(this.value);
    });
    $(`input[name="vectfox_cv_wiki_source_mode"][value="${wikiSourceMode}"]`).prop('checked', true);

    wikiLibraryUnsubs.push(wikiLibrary.on('pages-added', onWikiPagesEvent));
    wikiLibraryUnsubs.push(wikiLibrary.on('pages-fetched', onWikiPagesEvent));
    wikiLibraryUnsubs.push(wikiLibrary.on('task-status', onWikiTaskStatus));
    wikiLibraryUnsubs.push(wikiLibrary.on('library-updated', onWikiLibraryUpdated));
    wikiLibraryUnsubs.push(wikiLibrary.on('basket-changed', onWikiBasketChanged));

    updateWikiButtonsForType();
    setWikiRunningUi(wikiLibrary.isBusy());
    refreshWikiLibraryPanel();
    refreshWikiBasketLabel();
}

/** e621 has no cheap titles-only mode — bodies arrive with the listing. */
function updateWikiButtonsForType() {
    const isE621 = $('#vectfox_cv_wiki_type').val() === 'e621';
    $('#vectfox_cv_index_titles').toggle(!isE621);
    refreshWikiLibraryPanel();
}

function setWikiRunningUi(running) {
    $('#vectfox_cv_wiki_library_actions').toggle(!running);
    $('#vectfox_cv_wiki_running_actions').toggle(!!running);
}

/** Streams the last few landed titles into the live list, throttled. */
function onWikiPagesEvent(event) {
    for (const record of event.records ?? []) {
        wikiLiveTitles.push(record.title);
    }
    if (wikiLiveTitles.length > 8) {
        wikiLiveTitles = wikiLiveTitles.slice(-8);
    }
    if (wikiLiveRenderQueued) {
        return;
    }
    wikiLiveRenderQueued = true;
    setTimeout(() => {
        wikiLiveRenderQueued = false;
        const list = $('#vectfox_cv_wiki_live_list').empty();
        for (const title of wikiLiveTitles) {
            list.append($('<li>').text(String(title)));
        }
        $('#vectfox_cv_wiki_live').show();
    }, 250);
}

function onWikiTaskStatus({ task }) {
    const status = $('#vectfox_cv_wiki_status');
    if (task) {
        setWikiRunningUi(true);
        if (task.phase === 'titles') {
            status.html(`<i class="fa-solid fa-spinner fa-spin"></i> Indexing pages… ${task.done} found`);
        } else if (task.phase === 'content') {
            status.html(`<i class="fa-solid fa-spinner fa-spin"></i> Fetching content ${task.done}/${task.total}…`);
        }
    } else {
        setWikiRunningUi(false);
        refreshWikiLibraryPanel();
    }
}

function onWikiLibraryUpdated({ library }) {
    if (library) {
        $('#vectfox_cv_wiki_live_counts').text(
            `${(library.titleCount ?? 0).toLocaleString()} titles / ${(library.fetchedCount ?? 0).toLocaleString()} fetched in library`);
        $('#vectfox_cv_wiki_live').show();
    }
}

/**
 * Finds the stored library matching the section's current wikiType + URL
 * input, tolerating the /api.php vs /w/api.php ambiguity by checking every
 * endpoint candidate.
 */
async function findWikiLibraryForInput(wikiType, url) {
    if (!url && wikiType !== 'e621') {
        return null;
    }
    const candidates = new Set();
    try {
        if (wikiType === 'e621') {
            candidates.add(wikiLibrary.deriveLibraryIdentity('e621', resolveE621Base(url)).id);
        } else {
            for (const apiUrl of buildApiCandidates(wikiType, url)) {
                candidates.add(wikiLibrary.deriveLibraryIdentity(wikiType, apiUrl).id);
            }
        }
    } catch {
        return null;
    }
    const libraries = await wikiLibrary.listLibraries();
    return libraries.find(lib => candidates.has(lib.id) || (url && lib.inputUrl === url)) ?? null;
}

/** Refreshes the Resume button and stored-counts line for the current input. */
async function refreshWikiLibraryPanel() {
    if (!wikiLibraryAvailable) {
        return;
    }
    const resumeBtn = $('#vectfox_cv_resume_indexing');
    try {
        const wikiType = $('#vectfox_cv_wiki_type').val();
        const url = $('#vectfox_cv_wiki_url').val()?.trim() ?? '';
        const library = await findWikiLibraryForInput(wikiType, url);
        if (library) {
            onWikiLibraryUpdated({ library });
        }
        if (wikiLibrary.isResumable(library)) {
            resumeBtn.data('libraryId', library.id).show();
        } else {
            resumeBtn.hide();
        }
    } catch {
        resumeBtn.hide();
    }
}

/**
 * Builds the legacy wiki sourceData shape from a library's fetched pages,
 * optionally narrowed by the section's title filter (same regex semantics
 * as scrape-time filtering).
 */
async function buildWikiSourceDataFromLibrary(libraryId, filter) {
    const source = await wikiLibrary.materializeWikiSource(libraryId, filter);
    if (!source?.pageCount) return false;
    invalidateAutoReformat();
    sourceData = source;
    showWikiPreview(source.pages, source.content);
    return true;
}
/**
 * Runs an Index Titles / Fetch Everything / Resume task through the Wiki
 * Library service, with plugin fallback when the browser is CORS-blocked.
 *
 * @param {('index'|'full'|'resume')} kind
 */
async function runWikiLibraryTask(kind) {
    const wikiType = $('#vectfox_cv_wiki_type').val();
    const url = $('#vectfox_cv_wiki_url').val().trim();
    const filter = $('#vectfox_cv_wiki_filter').val().trim();

    if (!url && wikiType !== 'e621') {
        toastr.warning('Please enter a wiki URL or ID');
        return;
    }
    if (wikiLibrary.isBusy()) {
        toastr.warning('A Wiki Library task is already running — stop it first.');
        return;
    }

    const status = $('#vectfox_cv_wiki_status');
    $('#vectfox_cv_wiki_preview').hide();
    wikiLiveTitles = [];
    $('#vectfox_cv_wiki_live_list').empty();
    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Contacting wiki…');

    try {
        // e621's only walk mode downloads the whole corpus — confirm the cost
        // once, before the first walk (resume/complete walks skip the dialog)
        if (wikiType === 'e621' && kind !== 'resume') {
            const libraryId = wikiLibrary.deriveLibraryIdentity('e621', resolveE621Base(url)).id;
            const estimate = await wikiLibrary.estimateFullWalk(libraryId);
            if (estimate.requests > 0) {
                const minutes = Math.max(1, Math.round(estimate.estMs / 60000));
                const confirmed = await callGenericPopup(
                    `<p>Indexing the e621 wiki downloads its full corpus: roughly <b>${estimate.requests}</b> requests over <b>~${minutes} minutes</b> (the site asks for ≤1 request/second).</p>
                     <p>Progress is saved continuously — you can <b>Stop &amp; Keep</b> at any time and resume later. For a single known tag, use the Wiki Library's exact-title quick lookup instead.</p>
                     <p>Start the walk?</p>`,
                    POPUP_TYPE.CONFIRM);
                if (!confirmed) {
                    status.html('');
                    return;
                }
            }
        }

        let result;
        if (kind === 'resume') {
            result = await wikiLibrary.resumeEnumeration($('#vectfox_cv_resume_indexing').data('libraryId'));
        } else {
            result = await wikiLibrary.acquireWiki({
                wikiType, url, filter, kind,
                confirmFullDownload: () => callGenericPopup(
                    '<p>The browser could not index titles. The fallback plugin downloads full page content. Continue with that larger download?</p>',
                    POPUP_TYPE.CONFIRM),
            });
        }

        if (result.declined) { status.text('Stopped without starting the larger download.'); return; }
        if (result.source?.pageCount && (!result.stopped || result.plugin || !result.saved)) {
            invalidateAutoReformat();
            sourceData = result.source;
            showWikiPreview(sourceData.pages, sourceData.content);
            status.text(result.warning || (result.stopped ? 'Stopped and kept the plugin result.' : ''));
            if (!result.saved) toastr.warning(result.warning, 'VectFox');
            else toastr.success(`Scraped ${sourceData.pageCount} page(s)`, 'VectFox');
            return;
        }
        const library = result.libraryId ? await wikiLibrary.getLibrary(result.libraryId) : null;
        if (result.stopped) {
            status.html(`<i class="fa-solid fa-circle-check"></i> Stopped — ${(library?.titleCount ?? 0).toLocaleString()} pages kept in the library. Resume when ready.`);
            toastr.info(`Stopped and kept ${(library?.titleCount ?? 0).toLocaleString()} pages`, 'VectFox');
        } else if (kind === 'full' || wikiType === 'e621') {
            const built = await buildWikiSourceDataFromLibrary(result.libraryId, filter);
            status.html('');
            if (built) {
                toastr.success(`Scraped ${sourceData.pageCount} page(s), ${sourceData.content.length.toLocaleString()} chars`, 'VectFox');
            } else {
                status.html('<i class="fa-solid fa-circle-info"></i> Nothing matched the filter — adjust it or browse the Wiki Library.');
            }
        } else {
            status.html(`<i class="fa-solid fa-circle-check"></i> ${(library?.titleCount ?? 0).toLocaleString()} titles indexed — pick pages in the Wiki Library, or Fetch Everything.`);
            toastr.success(`Indexed ${(library?.titleCount ?? 0).toLocaleString()} titles`, 'VectFox');
        }
    } catch (e) {
        if (e instanceof WikiScrapeError && e.code === 'aborted') {
            status.html('<i class="fa-solid fa-ban"></i> Cancelled — pages already saved were kept in the library.');
        } else if (e?.code === 'busy') {
            toastr.warning(e.message);

        } else {
            console.error('VectFox: Wiki Library task failed:', e);
            status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
            if (shouldFallbackToPlugin(e)) {
                status.append(renderPluginHint());
            }
            toastr.error('Wiki task failed: ' + e.message);
        }
    } finally {
        refreshWikiLibraryPanel();
    }
}

/** Updates the basket radio label with live page/wiki counts. */
async function refreshWikiBasketLabel() {
    if (!wikiLibraryAvailable) {
        return;
    }
    try {
        const rows = await wikiLibrary.getBasket();
        const wikis = new Set(rows.map(r => r.libraryId)).size;
        $('#vectfox_cv_wiki_basket_label').text(rows.length === 0
            ? 'Selection basket (empty)'
            : `Selection basket (${rows.length} page${rows.length === 1 ? '' : 's'}, ${wikis} wiki${wikis === 1 ? '' : 's'})`);
    } catch { /* store unavailable */ }
}

/** Keeps a basket-mode source live-synced with basket edits. */
async function onWikiBasketChanged() {
    await refreshWikiBasketLabel();
    if (wikiSourceMode === 'basket') {
        await applyBasketAsSource({ promptForUnfetched: false, quiet: true });
    }
}

/** Switches the wiki source between the latest scrape and the basket. */
async function setWikiSourceMode(mode) {
    if (mode === wikiSourceMode) {
        return;
    }
    wikiSourceMode = mode;
    if (mode === 'basket') {
        if (sourceData?.type === 'wiki' && sourceData.wikiType !== 'library') {
            stashedScrapeSourceData = sourceData;
        }
        await applyBasketAsSource();
    } else {
        currentBasketSelectionHash = null;
        invalidateAutoReformat();
        sourceData = stashedScrapeSourceData;
        stashedScrapeSourceData = null;
        if (sourceData?.pages) {
            showWikiPreview(sourceData.pages, sourceData.content);
        } else {
            $('#vectfox_cv_wiki_preview').hide();
        }
        renderReformatSection();
    }
}

/**
 * Materializes the selection basket into the module sourceData (the same
 * shape a scrape produces, so vectorization and Auto-Reformat need no
 * special-casing), offering to fetch content for pages that are title-only.
 *
 * @param {object} [options]
 * @param {boolean} [options.promptForUnfetched] - Ask before fetching missing content
 * @param {boolean} [options.quiet] - Suppress info toasts (live re-sync path)
 * @returns {Promise<boolean>} True when sourceData was set
 */
async function applyBasketAsSource({ promptForUnfetched = true, quiet = false } = {}) {
    const basket = await wikiLibrary.materializeBasket();
    await refreshWikiBasketLabel();

    if (basket.pageCount === 0 && basket.unfetchedKeys.length === 0) {
        if (!quiet) {
            toastr.info('The basket is empty — pick pages in the Wiki Library first', 'VectFox');
        }
        invalidateAutoReformat();
        sourceData = null;
        $('#vectfox_cv_wiki_preview').hide();
        return false;
    }

    if (basket.unfetchedKeys.length > 0 && promptForUnfetched) {
        const confirmed = await callGenericPopup(
            `<p><b>${basket.unfetchedKeys.length}</b> selected page(s) have no content yet — only their titles are indexed.</p><p>Fetch their content now?</p>`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Fetch content', cancelButton: 'Use fetched pages only' });
        if (confirmed) {
            if (wikiLibrary.isBusy()) {
                toastr.warning('A Wiki Library task is already running — stop it first.');
            } else {
                try {
                    const result = await wikiLibrary.fetchContentForKeys(basket.unfetchedKeys);
                    toastr.success(`Fetched content for ${result.fetched} page(s)`, 'VectFox');
                } catch (e) {
                    toastr.error('Content fetch failed: ' + (e.message ?? e), 'VectFox');
                }
            }
            return applyBasketAsSource({ promptForUnfetched: false, quiet });
        }
    }

    if (basket.pageCount === 0) {
        if (!quiet) {
            toastr.warning('None of the basket pages have content yet — fetch content first', 'VectFox');
        }
        invalidateAutoReformat();
        sourceData = null;
        $('#vectfox_cv_wiki_preview').hide();
        return false;
    }

    invalidateAutoReformat();
    sourceData = {
        type: 'wiki',
        wikiType: 'library',
        url: '',
        content: basket.combinedContent,
        pages: basket.pages,
        pageCount: basket.pageCount,
        name: basket.name,
        selectionDescriptor: basket.selectionDescriptor,
    };
    const { getStringHash } = await import('../../../../utils.js');
    currentBasketSelectionHash = getStringHash(basket.selectionDescriptor);
    showWikiPreview(basket.pages, basket.combinedContent);
    renderReformatSection();
    return true;
}

/**
 * Entry point for the Wiki Library modal's "Use basket in Vectorizer":
 * ensures the vectorizer is open on the wiki type with basket mode selected,
 * then materializes the basket as the source.
 */
export async function useBasketAsWikiSource() {
    if ($('#vectfox_content_vectorizer_modal').length === 0) {
        openContentVectorizer('wiki');
    } else if (currentContentType !== 'wiki') {
        $('#vectfox_content_vectorizer_modal').remove();
        openContentVectorizer('wiki');
    }
    wikiSourceMode = 'basket';
    $('input[name="vectfox_cv_wiki_source_mode"][value="basket"]').prop('checked', true);
    await applyBasketAsSource();
}

// ============================================================================
// YOUTUBE TRANSCRIPT
// ============================================================================

/**
 * Fetches YouTube transcript
 */
async function fetchYouTubeTranscript() {
    const url = $('#vectfox_cv_youtube_url').val().trim();
    const lang = $('#vectfox_cv_youtube_lang').val().trim();

    if (!url) {
        toastr.warning('Please enter a YouTube URL or video ID');
        return;
    }

    const videoId = parseYouTubeId(url);
    if (!videoId) {
        toastr.warning('Could not parse YouTube video ID');
        return;
    }

    const status = $('#vectfox_cv_youtube_status');
    const preview = $('#vectfox_cv_youtube_preview');
    const fetchBtn = $('#vectfox_cv_fetch_youtube');

    status.html('<i class="fa-solid fa-spinner fa-spin"></i> Fetching transcript...');
    preview.hide();
    fetchBtn.prop('disabled', true);

    try {
        const response = await fetch('/api/search/transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: videoId, lang: lang || undefined }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }

        const transcript = await response.text();

        if (!transcript || transcript.length < 50) {
            throw new Error('No transcript available for this video');
        }

        invalidateAutoReformat();
        sourceData = {
            type: 'youtube',
            videoId: videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            content: transcript,
            lang: lang || 'auto',
            name: `YouTube-${videoId}`,
        };

        status.html('');
        fetchBtn.prop('disabled', false);

        // Show preview with estimated duration (assuming ~150 words/min speaking rate, ~5 chars/word)
        const estimatedMinutes = Math.round(transcript.length / 750);
        $('#vectfox_cv_youtube_title').text(`Transcript loaded (${videoId})`);
        $('#vectfox_cv_youtube_chars').text(transcript.length.toLocaleString());
        $('#vectfox_cv_youtube_duration').text(`~${estimatedMinutes}`);
        preview.show();

        toastr.success(`Fetched transcript: ${transcript.length.toLocaleString()} characters`, 'VectFox');

    } catch (e) {
        console.error('VectFox: YouTube fetch failed:', e);
        status.html(`<i class="fa-solid fa-times" style="color: var(--vectfox-danger);"></i> ${e.message}`);
        fetchBtn.prop('disabled', false);
        toastr.error('Failed to fetch transcript: ' + e.message);
    }
}

/**
 * Parses YouTube video ID from URL or ID string
 */
function parseYouTubeId(url) {
    // If already looks like an ID (11 chars, alphanumeric + _ -)
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }

    // Parse from various YouTube URL formats
    const regex = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|&v(?:i)?=))([^#&?]*).*/;
    const match = url.match(regex);
    return (match?.length && match[1]) ? match[1] : null;
}

// ============================================================================
// CHAT FILE HANDLING
// ============================================================================

/**
 * Parse the character name from a SillyTavern export filename.
 * Pattern: "{CharacterName} - YYYY-MM-DD@HHhMMmSSs.{ext}"
 * Falls back to the full stem when the pattern doesn't match.
 * CJK and other Unicode chars survive unchanged.
 */
function extractCharNameFromArchiveFilename(filename) {
    const stem = filename.replace(/\.(jsonl|json|txt)$/i, '');
    const m = stem.match(/^(.*?)\s+-\s+\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s$/);
    return (m ? m[1] : stem).trim();
}

/**
 * Compute a hex SHA-1 digest of text via SubtleCrypto.
 * Used as a stable, content-derived archive UUID when the file lacks chat_metadata.integrity.
 * @param {string} text
 * @returns {Promise<string>}
 */
async function sha1Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Handles chat file upload (.txt, .jsonl, .json)
 * Supports SillyTavern JSONL backup format (first line = metadata, rest = messages)
 */
async function handleChatFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(event) {
        const content = event.target.result;
        const ext = file.name.split('.').pop().toLowerCase();

        let messages = [];
        let metadata = null;
        let parseError = null;

        try {
            if (ext === 'jsonl') {
                // SillyTavern JSONL format:
                // Line 1: metadata object with user_name, character_name, create_date, chat_metadata
                // Lines 2+: message objects with name, is_user, is_system, send_date, mes, extra
                const lines = content.split('\n').filter(l => l.trim());

                for (let i = 0; i < lines.length; i++) {
                    const parsed = JSON.parse(lines[i]);

                    // First line is usually metadata (has chat_metadata or user_name fields)
                    if (i === 0 && (parsed.chat_metadata || parsed.user_name || parsed.character_name)) {
                        metadata = parsed;
                        continue;
                    }

                    // Skip system messages and lines without content
                    if (parsed.is_system) continue;
                    if (!parsed.mes && !parsed.text && !parsed.content) continue;

                    // Normalize message format
                    messages.push({
                        name: parsed.name || (parsed.is_user ? 'User' : 'Assistant'),
                        mes: parsed.mes || parsed.text || parsed.content || '',
                        is_user: parsed.is_user || false,
                        send_date: parsed.send_date,
                    });
                }

            } else if (ext === 'json') {
                // Could be ST chat export or array of messages
                const data = JSON.parse(content);

                if (Array.isArray(data)) {
                    // Array of messages — skip system messages (parity with .jsonl handling)
                    messages = data
                        .filter(m => !m.is_system && (m.mes || m.text || m.content))
                        .map(m => ({
                            name: m.name || (m.is_user ? 'User' : 'Assistant'),
                            mes: m.mes || m.text || m.content || '',
                            is_user: m.is_user || false,
                            send_date: m.send_date,
                        }));
                } else if (data.chat || data.messages) {
                    // Object with chat/messages array — skip system messages
                    const arr = data.chat || data.messages;
                    metadata = { user_name: data.user_name, character_name: data.character_name };
                    messages = arr
                        .filter(m => !m.is_system && (m.mes || m.text || m.content))
                        .map(m => ({
                            name: m.name || (m.is_user ? 'User' : 'Assistant'),
                            mes: m.mes || m.text || m.content || '',
                            is_user: m.is_user || false,
                            send_date: m.send_date,
                        }));
                } else if (data.mes || data.text || data.content) {
                    // Single message object
                    messages = [{
                        name: data.name || 'Message',
                        mes: data.mes || data.text || data.content || '',
                        is_user: data.is_user || false,
                    }];
                }

            } else if (ext === 'txt') {
                // Plain text - try to detect chat format
                // Check for "Name: message" format (common in chat logs)
                const chatPattern = /^(.+?):\s*(.+)$/gm;
                const matches = [...content.matchAll(chatPattern)];

                if (matches.length > 2) {
                    // Looks like a chat log
                    messages = matches.map(m => ({
                        name: m[1].trim(),
                        mes: m[2].trim(),
                        is_user: /^(you|user|me|myself)$/i.test(m[1].trim()),
                    }));
                } else {
                    // Plain text, treat as single content block
                    messages = [{ mes: content, name: 'Document', is_user: false }];
                }
            }
        } catch (err) {
            parseError = err;
            console.error('VectFox: Chat file parse error:', err);
        }

        if (parseError || messages.length === 0) {
            toastr.error(`Failed to parse chat file: ${parseError?.message || 'No messages found'}`);
            return;
        }

        // Determine character name from metadata or first non-user message
        let characterName = metadata?.character_name || 'Unknown';
        if (characterName === 'Unknown') {
            const firstCharMessage = messages.find(m => !m.is_user);
            if (firstCharMessage?.name) characterName = firstCharMessage.name;
        }

        // Derive a stable archive UUID for EventBase ingestion.
        // Priority: chat_metadata.integrity (jsonl only) → SHA-1 of raw file content.
        const integrity = metadata?.chat_metadata?.integrity;
        const archiveUUID = integrity || await sha1Hex(content);
        if (!integrity) {
            console.warn(`[VectFox] Archive "${file.name}" has no chat_metadata.integrity — using SHA-1 hash as UUID`);
        }

        const filenameCharName = extractCharNameFromArchiveFilename(file.name)
            || metadata?.character_name
            || 'archive';

        // Store as sourceData
        invalidateAutoReformat();
        sourceData = {
            type: 'file',
            filename: file.name,
            content: messages,
            messages: messages,
            metadata: metadata,
            characterName: characterName,
            archiveUUID,
            filenameCharName,
        };

        // Show upload info
        $('#vectfox_cv_chat_upload_zone').hide();
        $('#vectfox_cv_chat_upload_info').show();
        $('#vectfox_cv_chat_upload_filename').text(file.name);

        // Show stats
        const totalChars = messages.reduce((sum, m) => sum + (m.mes?.length || 0), 0);
        const userCount = messages.filter(m => m.is_user).length;
        const charCount = messages.filter(m => !m.is_user).length;

        $('#vectfox_cv_chat_upload_stats').show().html(`
            <div class="vectfox-cv-stats-grid">
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${messages.length}</span>
                    <span class="vectfox-cv-stat-label">Messages</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${characterName}</span>
                    <span class="vectfox-cv-stat-label">Character</span>
                </div>
                <div class="vectfox-cv-stat">
                    <span class="vectfox-cv-stat-value">${(totalChars / 1000).toFixed(1)}k</span>
                    <span class="vectfox-cv-stat-label">Characters</span>
                </div>
            </div>
        `);

        toastr.success(`Loaded ${messages.length} messages from ${file.name}`, 'VectFox');
    };

    reader.readAsText(file);
}

/**
 * Clears chat upload
 */
function clearChatUpload() {
    invalidateAutoReformat();
    sourceData = null;
    $('#vectfox_cv_chat_upload_zone').show();
    $('#vectfox_cv_chat_upload_info').hide();
    $('#vectfox_cv_chat_upload_stats').hide();
    $('#vectfox_cv_chat_file_input').val('');
}

// ============================================================================
// PREVIEW & VECTORIZATION
// ============================================================================

/**
 * Previews how content will be chunked
 */
async function previewChunks() {
    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // EventBase is the exclusive chat pipeline — chat content is processed
    // by LLM event extraction at vectorize time, not chunked synchronously,
    // so there's nothing meaningful to preview. Mirrors the production gate
    // at startVectorization() so chat never reaches the chunk-prepare path.
    if (currentContentType === 'chat') {
        $('.vectfox-cv-preview-section').show();
        $('#vectfox_cv_preview_content').html(
            '<div class="vectfox-cv-info">' +
            'Chat content is processed by EventBase (LLM event extraction) ' +
            'rather than chunked. Click <strong>Vectorize</strong> to run extraction — ' +
            'there is no synchronous chunk preview for chat.' +
            '</div>'
        );
        return;
    }

    // Auto-Reformat, once accepted, already IS the final chunk set — nothing
    // to mechanically re-chunk. Show the frozen result instead of running
    // chunkText(), mirroring the chat/EventBase special case above.
    if (isReformatSupportedType() && currentSettings.reformat?.accepted) {
        $('.vectfox-cv-preview-section').show();
        const reformatContainer = $('#vectfox_cv_preview_content');
        reformatContainer.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading Auto-Reformat result...</div>');
        try {
            const { getReformatCache } = await import('../core/reformat-store.js');
            const frozen = getReformatCache(currentSettings.reformat.sourceHash);
            const chunks = frozen?.chunks || [];
            if (chunks.length === 0) {
                reformatContainer.html('<div class="vectfox-cv-error">No frozen Auto-Reformat chunks found — try Re-running Auto-Reformat above.</div>');
                return;
            }
            const totalChars = chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
            const avgChars = Math.round(totalChars / chunks.length);
            reformatContainer.html(`
                <div class="vectfox-cv-preview-stats">
                    <span><strong>${chunks.length}</strong> chunks (Auto-Reformat)</span>
                    <span>~<strong>${avgChars}</strong> chars avg</span>
                </div>
                <div class="vectfox-cv-preview-list">
                    ${chunks.slice(0, 10).map((chunk, i) => {
                        const label = `[${chunk.metadata?.entry_type || 'entry'}] ${chunk.metadata?.name || ''}: `;
                        return `
                        <div class="vectfox-cv-preview-chunk">
                            <span class="vectfox-cv-preview-num">#${i + 1}</span>
                            <span class="vectfox-cv-preview-text">${StringUtils.escapeHtml(label)}${StringUtils.escapeHtml(chunk.text.substring(0, 120))}${chunk.text.length > 120 ? '...' : ''}</span>
                            <span class="vectfox-cv-preview-size">${chunk.text.length} chars</span>
                        </div>
                    `}).join('')}
                    ${chunks.length > 10 ? `<div class="vectfox-cv-preview-more">...and ${chunks.length - 10} more</div>` : ''}
                </div>
            `);
        } catch (e) {
            console.error('VectFox: Auto-Reformat preview failed:', e);
            reformatContainer.html(`<div class="vectfox-cv-error">Preview failed: ${e.message}</div>`);
        }
        return;
    }

    // Show preview section
    $('.vectfox-cv-preview-section').show();
    const container = $('#vectfox_cv_preview_content');
    container.html('<div class="vectfox-cv-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating preview...</div>');

    try {
        // Import modules for content resolution and chunking
        const { chunkText } = await import('../core/chunking.js');
        const { resolveAndPrepareContent } = await import('../core/content-vectorization.js');

        // Resolve and prepare content (handles 'select' type sources like lorebooks)
        const prepared = await resolveAndPrepareContent(currentContentType, source, currentSettings);
        const contentText = prepared.text;

        if (!contentText || (Array.isArray(contentText) && contentText.length === 0)) {
            container.html('<div class="vectfox-cv-error">Could not load content. Please check your selection.</div>');
            return;
        }

        const chunks = await chunkText(contentText, {
            strategy: currentSettings.strategy || type.defaultStrategy,
            chunkSize: currentSettings.chunkSize || type.defaults.chunkSize,
            chunkOverlap: currentSettings.chunkOverlap || type.defaults.chunkOverlap,
            batchSize: currentSettings.batchSize || 4,
        });

        // Handle empty or undefined chunks
        if (!chunks || chunks.length === 0) {
            container.html('<div class="vectfox-cv-error">No chunks generated. Content may be too short or empty.</div>');
            return;
        }

        // Calculate total chars for average
        const totalChars = Array.isArray(contentText)
            ? contentText.reduce((sum, t) => sum + (t?.length || 0), 0)
            : contentText.length;
        const avgChars = Math.round(totalChars / chunks.length);

        container.html(`
            <div class="vectfox-cv-preview-stats">
                <span><strong>${chunks.length}</strong> chunks</span>
                <span>~<strong>${avgChars}</strong> chars avg</span>
            </div>
            <div class="vectfox-cv-preview-list">
                ${chunks.slice(0, 10).map((chunk, i) => {
                    const chunkText = chunk.text || chunk;
                    return `
                    <div class="vectfox-cv-preview-chunk">
                        <span class="vectfox-cv-preview-num">#${i + 1}</span>
                        <span class="vectfox-cv-preview-text">${StringUtils.escapeHtml(chunkText.substring(0, 150))}${chunkText.length > 150 ? '...' : ''}</span>
                        <span class="vectfox-cv-preview-size">${chunkText.length} chars</span>
                    </div>
                `}).join('')}
                ${chunks.length > 10 ? `<div class="vectfox-cv-preview-more">...and ${chunks.length - 10} more</div>` : ''}
            </div>
        `);

    } catch (e) {
        console.error('VectFox: Preview failed:', e);
        container.html(`<div class="vectfox-cv-error">Preview failed: ${e.message}</div>`);
    }
}

/**
 * Gets the source data based on current selections
 */
function getSourceData() {
    const type = getContentType(currentContentType);

    // If we already have sourceData from file upload or URL fetch, use it
    if (sourceData) {
        return sourceData;
    }

    switch (type.id) {
        case 'document': {
            // Check for paste content
            const pasteContent = $('#vectfox_cv_paste_text').val()?.trim();
            if (pasteContent) {
                return {
                    type: 'paste',
                    content: pasteContent,
                    name: $('#vectfox_cv_doc_name').val() || 'Pasted Document',
                };
            }
            break;
        }

        case 'lorebook': {
            const selectVal = $('#vectfox_cv_source_select').val();
            if (selectVal) {
                return {
                    type: 'select',
                    id: selectVal,
                    name: selectVal,
                };
            }
            break;
        }

        case 'character': {
            const selectVal = $('#vectfox_cv_source_select').val();
            if (selectVal) {
                const context = getContext();
                const char = context?.characters?.find(c => c.avatar === selectVal);
                return {
                    type: 'select',
                    id: selectVal,
                    name: char?.name || selectVal,
                };
            }
            break;
        }

        case 'chat': {
            // Check which tab is active
            const activeTab = $('.vectfox-cv-chat-source .vectfox-cv-source-tab.active').data('source');

            if (activeTab === 'current') {
                // Use current chat
                const context = getContext();
                if (context?.chatId && context?.chat?.length > 0) {
                    return {
                        type: 'current',
                        id: context.chatId,
                        name: context.name2 || 'Chat',
                        content: context.chat,
                    };
                }
            }
            // If upload tab is active but no file loaded, sourceData will be null
            // and we'll fall through to return null
            break;
        }

        case 'url': {
            // URL type should have sourceData set by fetchUrl()
            // If not, check if URL input has a value (user hasn't clicked fetch yet)
            const urlInput = $('#vectfox_cv_url_input').val()?.trim();
            if (urlInput) {
                toastr.warning('Please click "Fetch" to load the URL content first');
            }
            break;
        }

        case 'wiki': {
            // Wiki type should have sourceData set by scrapeWiki()
            const wikiUrl = $('#vectfox_cv_wiki_url').val()?.trim();
            if (wikiUrl) {
                toastr.warning('Please click "Scrape Wiki" to load the content first');
            }
            break;
        }

        case 'youtube': {
            // YouTube type should have sourceData set by fetchYouTubeTranscript()
            const ytUrl = $('#vectfox_cv_youtube_url').val()?.trim();
            if (ytUrl) {
                toastr.warning('Please click "Fetch" to load the transcript first');
            }
            break;
        }
    }

    return null;
}

/**
 * Runs vectorization without purging existing vectors (continue/backfill mode).
 * The DB's hash-based deduplication automatically skips already-inserted chunks.
 * If no vectors exist yet, delegates to the normal startVectorization flow.
 */
async function startContinueVectorization() {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    const source = getSourceData();
    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // currentSettings only carries content-type defaults — merge global VECTFOX settings
    // so the user's summarize_model / API key (set in Core → LLM Summarization) is visible.
    const mergedSettings = resolveEffectiveSettings(currentSettings);
    console.log('[VectFox] LLM config check (vectorize-content):', {
        provider: mergedSettings.summarize_provider,
        model: mergedSettings.summarize_model,
        hasOpenRouterKey: !!getOpenRouterApiKey(mergedSettings),
        hasVllmUrl: !!mergedSettings.summarize_vllm_url,
    });
    const llmCheck = validateLLMConfig(mergedSettings);
    if (!llmCheck.ok) {
        toastr.error(
            `${llmCheck.reason} Open VECTFOX → Core → LLM Summarization & EventBase Extraction and fill in the required fields.`,
            'Configuration required',
            { timeOut: 8000 }
        );
        return;
    }

    // If no vectors exist yet, just run the normal vectorization
    if (currentContentType === 'chat' && (source.type === 'current' || source.type === 'file')) {
        return _runEventBaseBackfill();
    }
    // (dead code guard — left in place so chunk path below still compiles)
    if (false) {
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);
            if (!existing.hasVectors || existing.chunkCount === 0) {
                return startVectorization();
            }
        } catch (e) {
            // If check fails, fall through to backfill path
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());
    hideVectorizerForProgress();

    try {
        const { vectorizeContent } = await import('../core/content-vectorization.js');
        // Merge global VECTFOX settings (vector_backend, source, model, etc.) into currentSettings,
        // which by itself is only the content-type defaults. Without this, the collection-ID builder
        // sees `settings.vector_backend` as undefined and drops the backend segment from the name.
        const mergedSettings = resolveEffectiveSettings(currentSettings);
        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: mergedSettings,
            abortSignal: activeVectorizeAbortController.signal,
            continueMode: true,
            startFromMessage,
        });
        if (result.chunkCount === 0) {
            // Already up to date — message shown by vectorizeContent
        } else {
            toastr.success(`Inserted ${result.chunkCount} new chunks`, 'VectFox');
        }
        closeContentVectorizer();
        if (currentContentType === 'lorebook') {
            const { refreshWIStatus } = await import('./ui-manager.js');
            await refreshWIStatus();
        }
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectFox');
            return;
        }
        console.error('VectFox: Continue vectorization failed:', e);
        toastr.error('Vectorization failed: ' + e.message, 'VectFox');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Runs EventBase ingestion for the current chat (live) or an uploaded archive file.
 * Called by startVectorization / continueVectorization for all chat content types.
 */
async function _runEventBaseBackfill({ resetCaches = false } = {}) {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    console.log(`[EventBase] _runEventBaseBackfill: starting... (resetCaches=${resetCaches})`);

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());

    // Touch devices only — desktop behavior is left exactly as it was. On mobile the
    // vectorizer is a full-screen modal that covers the progress panel, and the
    // workflow's own show() runs deep inside runEventBaseIngestion (after cache checks
    // and several early-return paths). So here we show the panel upfront and fade the
    // modal out: the bottom-sheet appears immediately and the Action-tab "Progress"
    // button always has a panel to reopen, even on the workflow's quick-exit paths
    // (no messages / last window already extracted). On desktop none of this runs —
    // the panel is shown by the workflow exactly as before, in the corner, with the
    // modal left open. (hideVectorizerForProgress() is itself touch-gated.)
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        progressTracker.show('EventBase Extraction', 0, 'Windows');
    }
    hideVectorizerForProgress();

    try {
        const { runEventBaseIngestion } = await import('../core/eventbase-workflow.js');
        const { chunkText } = await import('../core/chunking.js');
        const context = getContext();
        const settings = extension_settings.vectfox || {};
        const source = getSourceData();

        // Vectorize button = fresh start. Drop BOTH "already-extracted" caches for
        // this chat so ingestion re-runs from the chosen Start-From message instead
        // of fast-forwarding. Clears the stale-tip trap: a tip left over from a
        // previously-deleted collection makes the tip-based fast-forward skip every
        // window → "0 events extracted". Continue passes resetCaches=false to keep
        // the caches and only backfill new messages.
        const maybeResetCaches = async (uuid) => {
            if (!resetCaches || !uuid) return;
            // Routes through prepareForFreshExtraction (single source of truth for
            // "user wants fresh re-extraction"). The returned { skipTipFallback: true }
            // is also threaded into vectorizeAll / runEventBaseIngestion below via the
            // `resetCaches` truthiness — keeping both legs of the dual-mechanism fix
            // (clear caches + bypass Qdrant tip fallback) coordinated through one call.
            const { prepareForFreshExtraction } = await import('../core/eventbase-store.js');
            await prepareForFreshExtraction(uuid);
        };

        let messages, chatUUID, collectionIdOverride = null; // only used by archive route

        if (source?.type === 'file') {
            // Archive upload route — .jsonl / .json / .txt
            if (!source.messages?.length) {
                toastr.warning('Archive contains no usable messages', 'EventBase');
                return;
            }
            const allMessages = source.messages.filter(m => m.mes && m.mes.trim().length > 0);
            messages = allMessages;
            if (startFromMessage > 1) {
                const sliceIdx = Math.min(startFromMessage - 1, allMessages.length);
                console.log(`[EventBase] Archive start-from message ${startFromMessage} — skipping first ${sliceIdx} messages, ${allMessages.length - sliceIdx} remaining`);
                messages = allMessages.slice(sliceIdx);
            }
            chatUUID = source.archiveUUID;
            collectionIdOverride = buildArchiveEventCollectionId({
                filenameCharName: source.filenameCharName,
                archiveUUID: source.archiveUUID,
                backend: settings.vector_backend,
            });
            await maybeResetCaches(chatUUID);
            console.log(`[EventBase] Archive upload route — collection: ${collectionIdOverride}, messages: ${messages.length}`);

            const parallelWindows = parseInt($('#vectfox_cv_parallel_windows').val()) || 1;
            const result = await runEventBaseIngestion({
                messages,
                chatUUID,
                settings,
                abortSignal: activeVectorizeAbortController.signal,
                parallelWindows,
                collectionIdOverride,
                // When the caller cleared the caches (Reset & Vectorize popup), also
                // bypass the tip-based fallback in the workflow — otherwise the workflow
                // re-derives the tip from Qdrant contents and silently fast-forwards past
                // everything we wanted re-extracted. See 2026-05-30 bug report.
                skipTipFallback: resetCaches,
            });

            if (activeVectorizeAbortController?.signal?.aborted) {
                progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
                toastr.info('EventBase ingestion stopped', 'VectFox');
            } else {
                progressTracker.complete(true, `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows`);
                toastr.success(`EventBase: extracted ${result.eventsExtracted} events across ${result.windowsProcessed} windows`, 'VectFox');
                closeContentVectorizer();
            }
        } else {
            // Live chat route — delegate entirely to vectorizeAll (same path as Sync Chat button)
            console.log('[EventBase] Context chat length:', context.chat?.length);
            if (!Array.isArray(context.chat) || context.chat.length === 0) {
                toastr.warning('No chat messages to process', 'EventBase');
                return;
            }

            chatUUID = getChatUUID();
            await maybeResetCaches(chatUUID);

            // Window-size-change warning. The window fingerprint dedup cache is
            // window-size-dependent (see eventbase-store.js#windowFingerprint), so
            // changing window size silently invalidates every cached fingerprint
            // and triggers full re-extraction with duplicate-coverage events.
            // Warn the user before they unknowingly pay that cost.
            //
            // The two checks below (`checkWindowSizeChanged` and `prepareForFreshExtraction`)
            // are the single source of truth for "did size change?" and "prep for fresh
            // re-extraction" — DO NOT inline these. Two bugs on 2026-05-30 came from
            // popups inlining incompatible versions of this logic.
            const { checkWindowSizeChanged, prepareForFreshExtraction } = await import('../core/eventbase-store.js');
            const sizeCheck = checkWindowSizeChanged(chatUUID, Math.max(2, settings.eventbase_window_size || 6));
            let freshExtractionOpts = null;
            if (sizeCheck.changed) {
                const estimatedWindows = Math.max(0, Math.floor(
                    context.chat.filter(m => m.mes && m.mes.trim().length > 0).length / sizeCheck.newSize
                ));
                const proceed = await callGenericPopup(
                    `<div style="text-align: left;">
                        <p><strong>Window size changed</strong> since the last extraction on this chat (was <strong>${sizeCheck.oldSize}</strong>, now <strong>${sizeCheck.newSize}</strong>).</p>
                        <p>The dedup cache is window-size-dependent, so Continue will re-extract from message ${startFromMessage || 1} at the new window size.</p>
                        <p style="margin-top: 10px;">Estimated cost: <strong>~${estimatedWindows} LLM calls</strong>. Existing events will not be deleted, so the collection will contain overlapping-coverage events at both sizes.</p>
                        <p style="margin-top: 10px;">Proceed anyway?</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    {
                        okButton: `Proceed (re-extract at window=${sizeCheck.newSize})`,
                        cancelButton: 'Cancel',
                    },
                );
                if (!proceed) {
                    progressTracker.complete(false, 'Cancelled — window size mismatch');
                    toastr.info('Continue cancelled', 'VectFox');
                    return;
                }
                // Stamp the new window size NOW, not at run-end. The workflow's
                // own setLastUsedWindowSize at the end of runEventBaseIngestion
                // only fires when the run completes AND windowsProcessed > 0 —
                // if the run dies partway (plugin error, abort, network failure)
                // the stamp never lands and this popup fires again on every
                // subsequent Continue, even though the user already explicitly
                // acknowledged the cost. Stamping at the Proceed click ties the
                // mark to user intent, not to run success. The workflow's
                // end-of-run stamp is still useful for non-popup paths (no-op
                // here since it'd just write the same value).
                // See 2026-05-30 bug report — user clicked Proceed multiple
                // times because intermediate runs failed without updating the
                // stamp.
                const { setLastUsedWindowSize } = await import('../core/eventbase-store.js');
                setLastUsedWindowSize(chatUUID, sizeCheck.newSize);
                console.log(`[EventBase] Window-size-change Proceed: stamped lastUsedWindowSize=${sizeCheck.newSize} for ${chatUUID} (user intent locked in regardless of run outcome)`);
                // Single shared entry point for "user said yes to fresh re-extraction".
                // Clears local caches + returns { skipTipFallback: true } to propagate.
                freshExtractionOpts = await prepareForFreshExtraction(chatUUID);
            }

            const legacyStrategy = currentSettings.strategy || 'per_message';
            const legacyBatchSize = Number(currentSettings.batchSize) || 4;
            const legacyChunks = await chunkText(context.chat.filter(m => m.mes && m.mes.trim().length > 0), {
                strategy: legacyStrategy,
                chunkSize: currentSettings.chunkSize || 1000,
                chunkOverlap: currentSettings.chunkOverlap || 200,
                batchSize: legacyBatchSize,
            });
            const legacyTotalChunks = Array.isArray(legacyChunks) ? legacyChunks.length : 0;
            const parallelWindows = parseInt($('#vectfox_cv_parallel_windows').val()) || 1;

            await vectorizeAll(settings, legacyBatchSize, activeVectorizeAbortController.signal, {
                startFromMessage,
                parallelWindows,
                progressPlan: {
                    strategy: legacyStrategy,
                    batchSize: legacyBatchSize,
                    totalChunks: legacyTotalChunks,
                },
                // Bypass the tip-based fallback inside runEventBaseIngestion when EITHER:
                // (a) the caller cleared the caches via Reset & Vectorize popup
                //     (resetCaches=true → maybeResetCaches at top of function already ran), OR
                // (b) the user proceeded through the window-size-change popup above
                //     (prepareForFreshExtraction returned { skipTipFallback: true }).
                // In both cases the user explicitly asked for re-extraction and the
                // Qdrant-side tip would silently fast-forward past everything. See
                // 2026-05-30 bug reports.
                skipTipFallback: resetCaches || !!freshExtractionOpts?.skipTipFallback,
            });

            if (!activeVectorizeAbortController?.signal?.aborted) {
                closeContentVectorizer();
            }
        }
    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');
        if (isStopped) {
            toastr.info('EventBase ingestion stopped', 'VectFox');
            console.log('[EventBase] Ingestion stopped by user');
            return;
        }
        // Insert failed after 3 retries — surface the underlying Qdrant error in a
        // popup so the user can see WHY (rate-limit / disk full / collection
        // schema mismatch / etc). A toast is too short for the multi-line errors
        // Qdrant tends to return; a popup gives the user something to copy and
        // share when reporting the problem. See plans/eventbase-extract-insert-pipeline.md §3.4.
        if (e?.code === 'insert_failed_max_retries') {
            console.error('[EventBase] Insert failed after 3 retries:', e);
            await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Vectorization stopped — database insert failed</strong></p>
                    <p>VectFox tried 3 times to write a batch of events to the vector store and the database rejected every attempt. Your collection is consistent (no partial writes), and the next run will pick up where this one stopped.</p>
                    <p>Underlying error:</p>
                    <pre style="white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;">${StringUtils.escapeHtml(e.message)}</pre>
                </div>`,
                POPUP_TYPE.TEXT,
                '',
                { okButton: 'Close' },
            );
            return;
        }
        // Silent insert loss detected — events made it through the workflow but
        // the count stored in Qdrant is smaller than expected. This is the
        // last-line defense against data-loss bugs in the layers beneath us
        // (hash collisions, plugin-side rejection, etc). Show the user the
        // counts so they know to investigate before relying on the collection.
        if (e?.code === 'insert_verification_failed') {
            console.error('[EventBase] Insert verification failed:', e);
            await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Vectorization stopped — silent data loss detected</strong></p>
                    <p>The number of events stored in the database is smaller than the number VectFox tried to insert. Some events were dropped between the workflow and Qdrant without any error being raised. <strong>Your collection is incomplete</strong> and should not be trusted until this is resolved.</p>
                    <p>This is usually one of: (a) a hash collision (two events colliding to the same point ID, where Qdrant treats the second as an overwrite of the first), (b) the Similharity plugin silently rejecting a payload field, or (c) a Qdrant capacity / network issue under the gateway.</p>
                    <p>Details:</p>
                    <pre style="white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;">${StringUtils.escapeHtml(e.message)}</pre>
                    <p>Suggested next step: delete this collection and re-vectorize after the fix. The console has more details.</p>
                </div>`,
                POPUP_TYPE.TEXT,
                '',
                { okButton: 'Close' },
            );
            return;
        }
        console.error('[EventBase] Backfill failed:', e);
        toastr.error('EventBase ingestion failed: ' + e.message, 'VectFox');
    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

/**
 * Starts the vectorization process
 */
async function startVectorization() {
    if (isVectorizing) return;

    syncStartFromMessageFromUI();

    const type = getContentType(currentContentType);
    const source = getSourceData();

    if (!source) {
        toastr.warning('Please select or enter content first');
        return;
    }

    // Defense in depth: refuse to vectorize a Fatbody-owned lorebook even if the
    // selection bypassed the (disabled) dropdown option — e.g. a file/programmatic path.
    // Those books are Fatbody's stat/world-state tracking; VectFox must leave them alone.
    if (currentContentType === 'lorebook' && isFatbodyOwnedBook(source.id || source.name)) {
        toastr.warning(
            `"${source.name || source.id}" is managed by the Fatbody DnD Framework (stat tracking) and cannot be vectorized.`,
            'VectFox',
            { timeOut: 8000 },
        );
        return;
    }

    // All vectorization paths (EventBase for chat, chunk pipeline for non-chat) eventually
    // make LLM calls that share the summarize_* settings. Fail fast with a clear message
    // rather than letting it blow up mid-ingest. Merge global settings so the user's
    // summarize_model / API key set in Core → LLM Summarization is visible here.
    const mergedSettings = resolveEffectiveSettings(currentSettings);
    console.log('[VectFox] LLM config check (start-vectorization):', {
        provider: mergedSettings.summarize_provider,
        model: mergedSettings.summarize_model,
        hasOpenRouterKey: !!getOpenRouterApiKey(mergedSettings),
        hasVllmUrl: !!mergedSettings.summarize_vllm_url,
    });
    const llmCheck = validateLLMConfig(mergedSettings);
    if (!llmCheck.ok) {
        toastr.error(
            `${llmCheck.reason} Open VECTFOX → Core → LLM Summarization & EventBase Extraction and fill in the required fields.`,
            'Configuration required',
            { timeOut: 8000 }
        );
        return;
    }

    // An accepted Auto-Reformat is frozen to a hash of the prepared source
    // text. If the source drifted since accept (a changed basket selection,
    // an edited document), the core pipeline would silently fall back to
    // mechanical chunking — confirm that explicitly instead.
    if (currentSettings.reformat?.accepted && isReformatSupportedType()) {
        try {
            const preparedText = await _resolveReformatSourceText(source);
            const { getStringHash } = await import('../../../../utils.js');
            if (getStringHash(preparedText) !== currentSettings.reformat.sourceHash) {
                const proceed = await callGenericPopup(
                    `<div style="text-align: left;">
                        <p><strong>The content changed since Auto-Reformat was accepted.</strong></p>
                        <p>The accepted entries no longer match this source (for example, the page selection changed), so they cannot be used for this run.</p>
                        <p style="margin-top: 10px;">Proceed with mechanical chunking instead, or cancel and re-run Auto-Reformat.</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    { okButton: 'Chunk mechanically', cancelButton: 'Cancel' },
                );
                if (!proceed) {
                    toastr.info('Vectorize cancelled', 'VectFox');
                    return;
                }
                currentSettings.reformat = null;
                renderReformatSection();
            }
        } catch (e) {
            console.warn('VectFox: Could not verify Auto-Reformat freshness:', e);
        }
    }

    // EventBase is the exclusive path for chat — always redirect through EventBase ingestion pipeline.
    // The Vectorize button is the "fresh start" action: it resets the extraction caches so ingestion
    // re-runs from the chosen Start-From message. Confirm first when prior extraction state exists,
    // since the reset re-extracts (LLM cost) what may already be vectorized — use Continue to backfill
    // without resetting. No prompt on a never-vectorized chat (nothing to reset).
    if (currentContentType === 'chat' && (source.type === 'current' || source.type === 'file')) {
        const resetUUID = source.type === 'file' ? source.archiveUUID : getChatUUID();
        if (await _hasPriorExtractionState(resetUUID)) {
            const proceed = await callGenericPopup(
                `<div style="text-align: left;">
                    <p><strong>Re-vectorize from scratch?</strong></p>
                    <p>This resets the extraction progress for this chat and re-extracts from message ${startFromMessage || 1} onward. Existing events are not deleted, so you may get overlapping-coverage events.</p>
                    <p style="margin-top: 10px;">To add only new messages without re-extracting, use <strong>Continue</strong> instead.</p>
                </div>`,
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: 'Reset & Vectorize', cancelButton: 'Cancel' },
            );
            if (!proceed) {
                toastr.info('Vectorize cancelled', 'VectFox');
                return;
            }
        }
        return _runEventBaseBackfill({ resetCaches: true });
    }

    // Check if vectors already exist for this content (chat specifically)
    if (currentContentType === 'chat' && source.type === 'current') {
        try {
            const { doesChatHaveVectors } = await import('../core/collection-loader.js');
            const existing = await doesChatHaveVectors(currentSettings);

            if (existing.hasVectors && existing.chunkCount > 0) {
                const confirmed = await callGenericPopup(
                    `<div style="text-align: center;">
                        <p>This chat already has <strong>${existing.chunkCount} chunks</strong> vectorized.</p>
                        <p style="margin-top: 10px;">What would you like to do?</p>
                    </div>`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    {
                        okButton: 'Replace All',
                        cancelButton: 'Cancel',
                    }
                );

                if (!confirmed) {
                    return;
                }

                // User wants to replace - purge existing first
                const { purgeVectorIndex } = await import('../core/core-vector-api.js');
                const { unregisterCollection } = await import('../core/collection-loader.js');
                await purgeVectorIndex(existing.collectionId, currentSettings);
                unregisterCollection(existing.collectionId);
                toastr.info('Cleared existing vectors', 'VectFox');
            }
        } catch (e) {
            console.warn('VectFox: Could not check for existing vectors:', e);
            // Continue anyway
        }
    }

    isVectorizing = true;
    activeVectorizeAbortController = new AbortController();
    updateVectorizeButtonState(true);
    progressTracker.setCancelHandler(() => stopActiveVectorization());
    hideVectorizerForProgress();

    try {
        // Import the appropriate handler
        const { vectorizeContent } = await import('../core/content-vectorization.js');

        // Merge global VECTFOX settings (vector_backend, source, model, etc.) into currentSettings.
        const mergedSettings = resolveEffectiveSettings(currentSettings);
        const result = await vectorizeContent({
            contentType: currentContentType,
            source: source,
            settings: mergedSettings,
            abortSignal: activeVectorizeAbortController.signal,
            startFromMessage,
        });

        toastr.success(`Vectorized ${result.chunkCount} chunks`, 'VectFox');
        renderCollections();
        closeContentVectorizer();

        // After lorebook vectorization, refresh the WI status so the checkbox
        // auto-enables if the new collection is now active (global scope or chat-locked).
        if (currentContentType === 'lorebook') {
            const { refreshWIStatus } = await import('./ui-manager.js');
            await refreshWIStatus();
        }

    } catch (e) {
        const isStopped = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('stopped by user');

        if (isStopped) {
            toastr.info('Vectorization stopped', 'VectFox');
            return;
        }

        console.error('VectFox: Vectorization failed:', e);

        // Check for dimension mismatch error and provide helpful guidance
        if (e.message.includes('dimension mismatch') || e.message.includes('Vector dimension error')) {
            toastr.error(
                'Vector dimension mismatch detected. You likely switched embedding models. ' +
                'Please delete this collection in Database Browser and try again.',
                'VECTFOX - Dimension Mismatch',
                { timeOut: 10000 }
            );
        } else {
            toastr.error('Vectorization failed: ' + e.message, 'VectFox');
        }

    } finally {
        progressTracker.clearCancelHandler();
        isVectorizing = false;
        activeVectorizeAbortController = null;
        updateVectorizeButtonState(false);
    }
}

// ============================================================================
// TEXT CLEANING MANAGEMENT
// ============================================================================

/**
 * Saves the cleaning preset to extension settings
 */
async function saveCleaningPresetToSettings(presetId) {
    const { saveCleaningSettings, getCleaningSettings } = await import('../core/text-cleaning.js');
    const settings = getCleaningSettings();
    settings.selectedPreset = presetId;
    saveCleaningSettings(settings);
    saveSettingsDebounced();
}

// Note: Text cleaning management is now handled by the standalone Text Cleaning Manager
// accessible from the Actions panel. The openTextCleaningManager() function is imported
// from './text-cleaning-manager.js' and used by the gear button in the Content Vectorizer.


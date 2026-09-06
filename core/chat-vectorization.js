/**
 * ============================================================================
 * VECTFOX CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { createChunkSelection, buildSearchQuery } from './chunk-retrieval-selection.js';
import { applyQueryKeywordBoost as boostQueryKeywords } from './chunk-query-keywords.js';

import { getCurrentChatId, is_send_press, setExtensionPrompt, substituteParams, extension_prompts } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash as calculateHash } from '../../../../utils.js';
import './chunking.js';
import { extractChatKeywords } from './keyword-boost.js';
import './text-cleaning.js';
import {
    getSavedHashes,
    queryCollection,
} from './core-vector-api.js';
import { isBackendAvailable } from '../backends/backend-manager.js';
import { getCollectionRegistry, isCollectionEmpty } from './collection-loader.js';
import { isCollectionEnabled, filterActiveCollections } from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { buildSearchContext, filterChunksByConditions, processChunkLinks } from './conditional-activation.js';
import { getChunkMetadata, getCollectionMeta } from './collection-metadata.js';

import { setLastSearchDebug } from '../ui/search-debug.js';
import { addTrace, recordChunkFate } from './retrieval-diagnostics.js';
import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG, RETRIEVAL_TIMEOUT_MS } from './constants.js';
import AsyncUtils from '../utils/async-utils.js';
import { log } from './log.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    COLLECTION_PREFIXES,
    INTERNAL_COLLECTION_IDS,
    parseCollectionId,
    parseRegistryKey,
    getRegistryBackend,
} from './collection-ids.js';

// Host adapter: effects and live reads stay at their original selection stages.
const chunkSelection = createChunkSelection({
    host: {
        calculateHash, substituteParams, getCollectionRegistry, isCollectionEmpty,
        isCollectionEnabled, filterActiveCollections, getChunkMetadata, getContext,
        getCurrentChatId, getRequestHeaders, log, trackChunkActivation,
        fetch: (...args) => fetch(...args),
        getActivationHistory: () => window.VectFox_ActivationHistory,
        notifyStart: (...args) => toastr.info(...args),
        notifyResult: (...args) => toastr.success(...args),
        publishSearch: data => { window.VectFox_LastSearch = data; },
    },
    queries: { queryCollection, getSavedHashes },
    rules: { extractChatKeywords, buildSearchContext, filterChunksByConditions,
        processChunkLinks, parseRegistryKey, COLLECTION_PREFIXES, INTERNAL_COLLECTION_IDS },
});

// Compatibility export used by production diagnostics.
export function applyQueryKeywordBoost(chunks, queryKeywordTexts, debugData = null) {
    return boostQueryKeywords(chunks, queryKeywordTexts, debugData, getChunkMetadata);
}

export { getChatUUID, parseCollectionId, parseRegistryKey };

/**
 * Tracks chunk activation for frequency/cooldown conditions
 * @param {number} hash Chunk hash
 * @param {number} messageCount Current message count
 */
function trackChunkActivation(hash, messageCount) {
    if (!window.VectFox_ActivationHistory) {
        window.VectFox_ActivationHistory = {};
    }

    const history = window.VectFox_ActivationHistory[hash] || { count: 0, lastActivation: null };
    window.VectFox_ActivationHistory[hash] = {
        count: history.count + 1,
        lastActivation: messageCount
    };
}

/**
 * Synchronizes chat with vector index using simple FIFO queue
 *
 * How it works:
 * 1. Get all messages, get all vectorized hashes from DB
 * 2. Queue = messages not yet in DB (by hash)
 * 3. Process batch: take message, chunk it, insert chunks, remove from queue
 * 4. Repeat until queue empty
 *
 * @param {object} settings VECTFOX settings
 * @param {number} batchSize Number of messages to process per call
 * @returns {Promise<object>} Progress info
 */
export async function synchronizeChat(settings, batchSize = 5, triggerEvent = null) {
    log.lifecycle(`[AutoSync] synchronizeChat: invoked (trigger=${triggerEvent || 'unknown'})`);

    const chatId = getCurrentChatId();
    if (!chatId) {
        log.lifecycle('[AutoSync] BAIL: no chatId');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const uuid = getChatUUID();
    if (!uuid) {
        log.lifecycle('[AutoSync] BAIL: no chatUUID');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Find EventBase collections registered for this chat and check the per-collection auto-sync flag
    const { findEventBaseCollectionIdsForChat } = await import('./eventbase-store.js');
    const { isCollectionAutoSyncEnabled } = await import('./collection-metadata.js');
    const backend = getRegistryBackend(settings?.vector_backend);
    const eventbaseCollections = findEventBaseCollectionIdsForChat(uuid, backend);
    // Metadata is keyed by the registry-key form ("backend:id"), matching the
    // write paths (eventbase-workflow.js, content-vectorization.js, ui-manager.js).
    if (log.enabled('lifecycle')) {
        const flagPerCollection = eventbaseCollections.map(({ registryKey }) => `${registryKey}=${isCollectionAutoSyncEnabled(registryKey)}`);
        log.lifecycle(`[AutoSync] uuid=${uuid}, backend=${backend}, eventbaseCollections=${eventbaseCollections.length}, autoSyncFlags=[${flagPerCollection.join(', ')}]`);
    }
    const autoSyncEnabled = eventbaseCollections.some(({ registryKey }) => isCollectionAutoSyncEnabled(registryKey));

    if (!autoSyncEnabled) {
        log.lifecycle('[AutoSync] BAIL: no collection has autoSync=true');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const context = getContext();
    if (!Array.isArray(context.chat)) {
        log.lifecycle('[AutoSync] BAIL: context.chat is not an array');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    const { runEventBaseIngestion } = await import('./eventbase-workflow.js');
    const messages = context.chat.filter(m => m.mes && m.mes.trim().length > 0);
    log.lifecycle(`[AutoSync] calling runEventBaseIngestion: messages=${messages.length}`);
    let result;
    try {
        result = await runEventBaseIngestion({
            messages,
            chatUUID: uuid,
            settings,
            isAutoSync: true,
            // Suppress the popup when the trigger was the user sending a message —
            // the popup should only appear after the AI's reply, not mid-generation.
            // MESSAGE_RECEIVED (and edits/swipes/deletes) still get the popup.
            suppressAutoSyncPopup: triggerEvent === 'MESSAGE_SENT',
        });
    } catch (err) {
        // A retired/unknown model (extraction OR embedding) would otherwise be
        // swallowed by ST's ModuleWorkerWrapper and silently re-fail every message.
        // Warn the user once and pause auto-sync so the loop stops until they fix it.
        const { isInvalidModelConfigError, notifyInvalidModel, pauseAutoSyncForChat } = await import('./model-config-notifier.js');
        if (isInvalidModelConfigError(err)) {
            notifyInvalidModel(err.message);
            await pauseAutoSyncForChat(uuid, backend);
            return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
        }
        throw err;
    }
    log.lifecycle(`[AutoSync] runEventBaseIngestion result:`, result);

    return {
        remaining: 0,
        messagesProcessed: result.eventsExtracted,
        chunksCreated: result.eventsExtracted,
    };
}

// ============================================================================
// REARRANGE CHAT PIPELINE - Helper Functions
// ============================================================================
// These functions break down the rearrangeChat logic into discrete stages
// for better maintainability and testability.
// ============================================================================

/**
 * Builds the nested prompt structure with context and XML tags at each level.
 * Groups chunks by collection and applies wrapping in this order:
 * 1. Global wrapper (outermost)
 * 2. Collection wrapper (groups chunks from same collection)
 * 3. Chunk wrapper (innermost, per-chunk)
 *
 * @param {object[]} chunks Chunks to inject
 * @param {object} settings VECTFOX settings
 * @returns {string} Formatted injection text
 */
function buildNestedInjectionText(chunks, settings) {
    // Group chunks by collection
    const byCollection = new Map();
    for (const chunk of chunks) {
        const collId = chunk.collectionId || 'unknown';
        if (!byCollection.has(collId)) {
            byCollection.set(collId, []);
        }
        byCollection.get(collId).push(chunk);
    }

    // Build collection blocks
    const collectionBlocks = [];

    for (const [collectionId, collChunks] of byCollection) {
        // Get collection metadata for context/xmlTag
        const collMeta = getCollectionMeta(collectionId) || {};
        const collContext = collMeta.context ? substituteParams(collMeta.context) : '';
        const collXmlTag = collMeta.xmlTag || '';

        // Build chunk texts with per-chunk wrapping
        const chunkTexts = collChunks.map(chunk => {
            const chunkMeta = getChunkMetadata(chunk.hash) || {};
            const dbMeta = chunk.metadata || {};
            // Backend payload is source of truth; ext_settings is the legacy fallback.
            const rawContext = dbMeta.context || chunkMeta.context;
            const chunkContext = rawContext ? substituteParams(rawContext) : '';
            const chunkXmlTag = dbMeta.xmlTag || chunkMeta.xmlTag || '';
            const text = chunk.text || '(text not available)';

            // Build chunk with optional wrapping
            let chunkBlock = '';

            if (chunkContext) {
                chunkBlock += chunkContext + '\n';
            }

            if (chunkXmlTag) {
                chunkBlock += `<${chunkXmlTag}>\n${text}\n</${chunkXmlTag}>`;
            } else {
                chunkBlock += text;
            }

            return chunkBlock;
        });

        // Join chunks within this collection
        let collectionBlock = chunkTexts.join('\n\n');

        // Apply collection-level wrapping
        if (collContext) {
            collectionBlock = collContext + '\n\n' + collectionBlock;
        }

        if (collXmlTag) {
            collectionBlock = `<${collXmlTag}>\n${collectionBlock}\n</${collXmlTag}>`;
        }

        collectionBlocks.push(collectionBlock);
    }

    // Join all collection blocks
    let fullText = collectionBlocks.join('\n\n');

    // Apply global-level wrapping
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    const globalXmlTag = settings.rag_xml_tag || '';

    if (globalContext) {
        fullText = globalContext + '\n\n' + fullText;
    }

    if (globalXmlTag) {
        fullText = `<${globalXmlTag}>\n${fullText}\n</${globalXmlTag}>`;
    }

    return fullText;
}

/**
 * Resolves the effective injection position for a chunk using cascade:
 * chunk → collection → global
 * @param {object} chunk Chunk with collectionId
 * @param {object} settings VECTFOX settings
 * @returns {{position: number, depth: number}} Resolved position and depth
 */
function resolveChunkInjectionPosition(chunk, settings) {
    const chunkMeta = getChunkMetadata(chunk.hash) || {};
    const dbMeta = chunk.metadata || {};
    const collMeta = getCollectionMeta(chunk.collectionId) || {};

    // Cascade: chunk (backend payload → ext_settings fallback) → collection → global
    const position = dbMeta.position ?? chunkMeta.position ?? collMeta.position ?? settings.position ?? 0;
    const depth = dbMeta.depth ?? chunkMeta.depth ?? collMeta.depth ?? settings.depth ?? 2;

    return { position, depth };
}

/**
 * Stage 8: Format and inject chunks into prompt
 * Supports per-chunk/per-collection injection positions via cascade resolution.
 * Groups chunks by their resolved position+depth and creates separate injections.
 *
 * @param {object[]} chunksToInject Chunks to inject
 * @param {object} settings VECTFOX settings
 * @param {object} debugData Debug tracking object
 * @returns {{verified: boolean, text: string}} Injection result
 */
function injectChunksIntoPrompt(chunksToInject, settings, debugData) {
    const injectionDebug = log.domainEnabled('injection');
    // Control print: Log chunks QUEUED for injection (not yet injected)
    if (injectionDebug) {
        log.domain('injection', 'trace', `[VECTFOX Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
        log.domain('injection', 'trace', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        let emptyTextCount = 0;
        chunksToInject.forEach((chunk, idx) => {
            const textLength = chunk.text?.length || 0;
            const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
            if (!hasValidText) emptyTextCount++;

            log.domain('injection', 'trace', `  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
            log.domain('injection', 'trace', `      Hash: ${chunk.hash}`);
            log.domain('injection', 'trace', `      Score: ${chunk.score?.toFixed(4)}`);
            log.domain('injection', 'trace', `      Collection: ${chunk.collectionId}`);
            log.domain('injection', 'trace', `      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
            log.domain('injection', 'trace', `      Text preview: "${chunk.text?.substring(0, 120)}${textLength > 120 ? '...' : ''}"`);
            log.domain('injection', 'trace', '      ─────────────────────────────────────────────────────────────────');
        });
        if (emptyTextCount > 0) {
            log.warn(`[VECTFOX Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
        }
        log.domain('injection', 'trace', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    // Group chunks by resolved injection position+depth
    const positionGroups = new Map(); // "position:depth" → chunks[]

    for (const chunk of chunksToInject) {
        const { position, depth } = resolveChunkInjectionPosition(chunk, settings);
        const key = `${position}:${depth}`;

        if (!positionGroups.has(key)) {
            positionGroups.set(key, { position, depth, chunks: [] });
        }
        positionGroups.get(key).chunks.push(chunk);
    }

    // If all chunks go to the same position, use the simple single-injection path
    if (positionGroups.size === 1) {
        const [_, group] = [...positionGroups.entries()][0];
        const insertedText = buildNestedInjectionText(group.chunks, settings);

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection text preview: "${insertedText.substring(0, 200)}${insertedText.length > 200 ? '...' : ''}"`);
        }

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
            log.domain('injection', 'trace', `[VECTFOX Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
                exists: !!verifiedPrompt,
                valueLength: verifiedPrompt?.value?.length,
                position: verifiedPrompt?.position,
                depth: verifiedPrompt?.depth,
                valuePreview: verifiedPrompt?.value?.substring(0, 100)
            });
        }

        if (!injectionVerified) {
            log.warn('VectFox: ⚠️ Injection verification failed!', {
                expected: insertedText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...',
                promptExists: !!verifiedPrompt
            });
        }

        // Record final fate for injected chunks
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId
            });
        });

        return { verified: injectionVerified, text: insertedText };
    }

    // Multiple injection positions - create separate extension prompts for each
    if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        const groupSettings = { ...settings, rag_context: '', rag_xml_tag: '' };
        const groupText = buildNestedInjectionText(group.chunks, groupSettings);

        if (injectionDebug) {
            log.domain('injection', 'trace', `[VECTFOX Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
            group.chunks.forEach((chunk, idx) => {
                log.domain('injection', 'trace', `    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
            });
        }

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

        if (!verified) {
            log.warn(`VectFox: ⚠️ Injection verification failed for position ${key}`, {
                tag,
                expected: groupText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...'
            });
            allVerified = false;
        }

        // Record fates
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId,
                position: group.position,
                depth: group.depth
            });
        });

        allTexts.push(groupText);
        groupIndex++;
    }

    if (injectionDebug) log.domain('injection', 'trace', `[VECTFOX Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

    return {
        verified: allVerified,
        text: allTexts.join('\n\n---\n\n') // Combine for debug output
    };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Searches for and injects relevant past messages from ALL enabled collections
 * This includes chat collections (if enabled_chats is true) AND any other
 * enabled collections like lorebooks, documents, character files, etc.
 *
 * @param {object[]} chat Current chat messages
 * @param {object} settings VECTFOX settings
 * @param {string} type Generation type
 */
export async function rearrangeChat(chat, settings, type, { dryRun = false, testMessage = null } = {}) {
    log.lifecycle(`🐰 VectFox: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0}${dryRun ? ', dryRun=true' : ''})`);

    try {
        // === EARLY EXITS ===
        if (!dryRun && type === 'quiet') {
            log.trace('VectFox: Skipping quiet prompt');
            return;
        }

        // Clear extension prompts (main + any position-specific tags from previous run)
        if (!dryRun) {
            setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
            for (let i = 0; i < 10; i++) {
                const posTag = `${EXTENSION_PROMPT_TAG}_pos${i}`;
                if (extension_prompts[posTag]) {
                    setExtensionPrompt(posTag, '', 0, 0, false);
                }
            }
        }

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            log.trace('VectFox: No chat selected');
            return dryRun ? { injectionText: null, chunkCount: 0 } : undefined;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (!dryRun && minChatLength > 0 && chat.length < minChatLength) {
            log.warn(`⚠️ VectFox: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            log.lifecycle(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // EventBase workflow: Phase A — skipped in dryRun (EventBase has its own dry-run path).
        if (!dryRun) {
            const queryText = buildSearchQuery(chat, settings, substituteParams);
            if (queryText) {
                const { runEventBaseRetrieval } = await import('./eventbase-workflow.js');
                // Bound retrieval so a hung embedding/query can't freeze the turn.
                // Soft timeout: on expiry the message proceeds WITHOUT EventBase
                // injection; the orphaned request is reaped by ST's server-side
                // timeout. Non-fatal — a thrown timeout/error must not break
                // generation. See core/constants.js::RETRIEVAL_TIMEOUT_MS.
                try {
                    await AsyncUtils.timeout(
                        runEventBaseRetrieval({
                            chat,
                            searchText: queryText,
                            settings,
                            chatUUID: getChatUUID(),
                        }),
                        RETRIEVAL_TIMEOUT_MS,
                        'EventBase retrieval timed out',
                    );
                } catch (error) {
                    log.error('VectFox EventBase: retrieval error (non-fatal, message sends without event memory):', error);
                }
            } else {
                // Empty query — clear any stale injection from a previous generation.
                const { setExtensionPrompt } = await import('../../../../../script.js');
                const { EXTENSION_PROMPT_TAG } = await import('./constants.js');
                setExtensionPrompt(`${EXTENSION_PROMPT_TAG}_eventbase`, '', settings.position, settings.depth, false);
            }
        } // end if (!dryRun) EventBase block

        const selection = await chunkSelection.select({ chat, settings, generationType: type, testMessage });
        if (selection.status !== 'selected') {
            if (!dryRun) return;
            return {
                injectionText: null, chunkCount: 0,
                ...(selection.status === 'noCollections' ? { noCollections: true } : {}),
                ...(selection.status === 'noActive' ? { noActive: true } : {}),
            };
        }
        const { chunks: chunksToInject, skippedDuplicates, diagnostics: debugData } = selection;

        if (chunksToInject.length === 0) {
            log.lifecycle('ℹ️ VectFox: All retrieved chunks already in context, nothing to inject');
            log.verbose(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
            log.lifecycle('[VectFox] Injection blocked: All retrieved chunks are already present in the current chat context. Adjust temporal decay or query depth if you want older messages.');
            debugData.stages.injected = [];
            debugData.stats.actuallyInjected = 0;
            debugData.stats.skippedDuplicates = skippedDuplicates.length;
            addTrace(debugData, 'injection', 'PIPELINE COMPLETE - NO INJECTION NEEDED', {
                reason: 'All chunks already in current context',
                skippedCount: skippedDuplicates.length
            });
            setLastSearchDebug(debugData);
            return dryRun ? { injectionText: null, chunkCount: 0, allDuplicates: true } : undefined;
        }

        log.verbose(`[VECTFOX Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === STAGE 10: Inject into prompt (or return dry-run result) ===
        if (dryRun) {
            const injectionText = buildNestedInjectionText(chunksToInject, settings);
            setLastSearchDebug(debugData);
            return { injectionText, chunkCount: chunksToInject.length };
        }

        const injection = injectChunksIntoPrompt(chunksToInject, settings, debugData);

        log.lifecycle(`\n✅ VectFox: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        log.verbose(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        log.verbose(`   Total characters injected: ${injection.text.length}\n`);

        // Finalize debug data
        debugData.stages.injected = chunksToInject;
        debugData.stats.actuallyInjected = chunksToInject.length;
        debugData.stats.skippedDuplicates = skippedDuplicates.length;
        debugData.injection = {
            verified: injection.verified,
            text: injection.text,
            position: settings.position,
            depth: settings.depth,
            promptTag: EXTENSION_PROMPT_TAG,
            charCount: injection.text.length
        };

        addTrace(debugData, 'final', 'PIPELINE COMPLETE - SUCCESS', {
            injectedCount: chunksToInject.length,
            skippedDuplicates: skippedDuplicates.length,
            injectedHashes: chunksToInject.map(c => c.hash),
            totalTokens: injection.text.length,
            position: settings.position,
            depth: settings.depth,
            verified: injection.verified
        });

        setLastSearchDebug(debugData);
        log.lifecycle(`VectFox: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectFox');
        log.error('VectFox: Failed to rearrange chat', error);
    }
}

/**
 * Vectorizes entire chat
 * @param {object} settings VECTFOX settings
 * @param {number} batchSize Batch size
 */
export async function vectorizeAll(settings, batchSize, abortSignal = null, {
    startFromMessage = 1,
    parallelWindows = 1,
    progressPlan = null,
    skipTipFallback = false,
} = {}) {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        // Pre-flight check: verify backend is available before starting
        const backendName = settings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, settings);
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            log.error(`VectFox: Backend ${backendName} failed health check before vectorization`);
            return;
        }

        if (abortSignal?.aborted) {
            return;
        }
        if (is_send_press) {
            toastr.info('Message generation is in progress.', 'Vectorization aborted');
            throw new Error('Message generation in progress');
        }

        const context = getContext();
        if (!Array.isArray(context.chat)) return;

        const allMessages = context.chat.filter(m => m.mes && m.mes.trim().length > 0);
        const messages = startFromMessage > 1
            ? allMessages.slice(Math.min(startFromMessage - 1, allMessages.length))
            : allMessages;

        const { runEventBaseIngestion } = await import('./eventbase-workflow.js');
        const result = await runEventBaseIngestion({
            messages,
            chatUUID: getChatUUID(),
            settings,
            abortSignal,
            isAutoSync: false,
            parallelWindows,
            progressPlan,
            skipTipFallback,
        });

        if (chatId !== getCurrentChatId()) {
            progressTracker.complete(false, 'Chat changed during vectorization');
            throw new Error('Chat changed');
        }

        if (abortSignal?.aborted) {
            progressTracker.complete(false, `Stopped — saved ${result.eventsExtracted} events from ${result.windowsProcessed} windows so far`);
            return;
        }

        progressTracker.complete(true, `EventBase: extracted ${result.eventsExtracted} events from ${result.windowsProcessed} windows`);
        toastr.success(`EventBase: extracted ${result.eventsExtracted} events across ${result.windowsProcessed} windows`, 'VectFox');
        log.lifecycle(`VectFox: ✅ Vectorization complete — ${result.eventsExtracted} events, ${result.windowsProcessed} windows processed, ${result.windowsSkipped} skipped`);
    } catch (error) {
        log.error('VectFox: Failed to vectorize all', error);
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed');
        const { isInvalidModelConfigError, notifyInvalidModel } = await import('./model-config-notifier.js');
        if (isInvalidModelConfigError(error)) {
            notifyInvalidModel(error.message);
        } else {
            toastr.error(`Vectorization failed: ${error.message}`, 'VectFox');
        }
    }
}

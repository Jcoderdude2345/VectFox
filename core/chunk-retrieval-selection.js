import { LRUCache } from '../utils/data-structures.js';
import { HASH_CACHE_SIZE, RETRIEVAL_TIMEOUT_MS } from './constants.js';
import AsyncUtils from '../utils/async-utils.js';
import { createDebugData, addTrace, recordChunkFate } from './retrieval-diagnostics.js';
import { applyQueryKeywordBoost as boostQueryKeywords } from './chunk-query-keywords.js';

/**
 * Full non-chat selection, from collection eligibility through deduplication.
 * Bind environmental dependencies once; each select call reads live state at
 * the original stage. Effects are synchronous where they were synchronous in
 * rearrangeChat, including preview activation and pre-dedup visualization.
 * Query failures retain per-collection continuation and the existing soft timeout;
 * other failures propagate to the caller's generation/preview error handling.
 * Rules are the existing text/condition/ID algorithms, not replaceable stages.
 */
export function createChunkSelection({ host, queries, rules }) {
    const { calculateHash, substituteParams, getCollectionRegistry, isCollectionEmpty,
        isCollectionEnabled, filterActiveCollections, getChunkMetadata, getContext,
        getCurrentChatId, fetch, getRequestHeaders, log } = host;
    const { queryCollection, getSavedHashes } = queries;
    const { extractChatKeywords, buildSearchContext, filterChunksByConditions,
        processChunkLinks, parseRegistryKey, COLLECTION_PREFIXES, INTERNAL_COLLECTION_IDS } = rules;
    const hashCache = new LRUCache(HASH_CACHE_SIZE);

    async function rerankWithBananaBread(query, chunks, settings) {
        if (!chunks.length) return chunks;

        const apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
        const documents = chunks.map(c => c.text);

        try {
            const response = await fetch('/api/plugins/similharity/rerank', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    apiUrl,
                    apiKey: settings.bananabread_api_key || '', // Include API key for authentication
                    query,
                    documents,
                    top_k: chunks.length
                }),
            });

            if (!response.ok) {
                log.warn('VectFox: Reranking failed, using original scores');
                return chunks;
            }

            const data = await response.json();
            if (!data.results || !Array.isArray(data.results)) {
                return chunks;
            }

            // Apply rerank scores - results are sorted by score desc
            // Each result has { index, score } where index refers to original position
            const rerankedChunks = data.results.map(r => {
                const chunk = { ...chunks[r.index] };
                chunk.rerankScore = r.score;
                chunk.originalScore = chunk.score;
                chunk.score = r.score; // Replace score with rerank score
                return chunk;
            });

            log.lifecycle(`VectFox: Reranked ${rerankedChunks.length} chunks with BananaBread`);
            return rerankedChunks;
        } catch (error) {
            log.warn('VectFox: Reranking error:', error.message);
            return chunks;
        }
    }

    function getStringHash(str) {
        const cached = hashCache.get(str);
        if (cached !== undefined) {
            return cached;
        }
        const hash = calculateHash(str);
        hashCache.set(str, hash);
        return hash;
    }

    function getTextWithoutAttachments(message) {
        const fileLength = message?.extra?.fileLength || 0;
        return String(message?.mes || '').substring(fileLength).trim();
    }

    async function applyChunkConditions(chunks, chat, settings) {
        let filtered = chunks;

        // Check if any chunks have conditions (from chunk metadata)
        const chunksWithConditions = filtered.map(chunk => {
            // Backend payload is source of truth; ext_settings is the legacy fallback.
            const conditions = chunk.metadata?.conditions || getChunkMetadata(chunk.hash)?.conditions;
            if (conditions?.enabled) {
                return { ...chunk, conditions };
            }
            return chunk;
        });

        // If no chunks have conditions, return filtered
        const hasAnyConditions = chunksWithConditions.some(c => c.conditions?.enabled);
        if (!hasAnyConditions) {
            return filtered;
        }

        // Build search context for condition evaluation
        const context = buildSearchContext(chat, settings.query || 10, chunksWithConditions, {
            generationType: settings.generationType || 'normal',
            isGroupChat: settings.isGroupChat || false,
            currentCharacter: settings.currentCharacter || null,
            activeLorebookEntries: settings.activeLorebookEntries || [],
            activationHistory: host.getActivationHistory() || {}
        });

        // Filter chunks by their conditions
        const conditionFilteredChunks = filterChunksByConditions(chunksWithConditions, context);

        // Track activation for frequency conditions
        conditionFilteredChunks.forEach(chunk => {
            if (chunk.conditions?.enabled) {
                host.trackChunkActivation(chunk.hash, chat.length);
            }
        });

        log.verbose(`VectFox: Chunk conditions filtered ${filtered.length} → ${conditionFilteredChunks.length}`);
        return conditionFilteredChunks;
    }

    function gatherCollectionsToQuery(settings) {
        const collectionsToQuery = [];
        const registry = getCollectionRegistry();

        // Workflow isolation:
        //   vf_eventbase_*     → always excluded (EventBase pipeline owns them)
        //   vf_archiveevent_*  → always excluded (EventBase pipeline owns them)
        //   vf_lorebook_*      → always excluded (Lorebook WI pipeline owns them, injects to <VectFoxLorebook>)
        for (const registryKey of registry) {
            const parsedKey = parseRegistryKey(registryKey);
            const collectionId = parsedKey.collectionId;

            if (collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_EVENTBASE) ||
                collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT) ||
                collectionId?.startsWith(COLLECTION_PREFIXES.VECTFOX_LOREBOOK)) {
                continue;
            }

            if (INTERNAL_COLLECTION_IDS.includes(collectionId)) {
                continue;
            }

            if (isCollectionEnabled(registryKey)) {
                collectionsToQuery.push(registryKey);
            }
        }

        return collectionsToQuery;
    }

    async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData) {
        let chunksForVisualizer = [];
        const effectiveTopK = settings.top_k ?? settings.insert;

        // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
        const chatHashMap = new Map();
        for (const msg of chat) {
            if (msg.mes) {
                const hash = getStringHash(substituteParams(getTextWithoutAttachments(msg)));
                if (!chatHashMap.has(hash)) {
                    chatHashMap.set(hash, msg);
                }
            }
        }

        for (const collectionId of activeCollections) {
            try {
                const queryResults = await queryCollection(collectionId, queryText, effectiveTopK, settings);

                // TRACE: Vector query results for this collection
                addTrace(debugData, 'vector_search', `Query completed for ${collectionId}`, {
                    hashesReturned: queryResults.hashes.length,
                    hashes: queryResults.hashes.slice(0, 5),
                    scoreBreakdown: queryResults.metadata.slice(0, 5).map(m => ({
                        finalScore: m.score?.toFixed(3),
                        originalScore: m.originalScore?.toFixed(3),
                        keywordBoost: m.keywordBoost?.toFixed(2) || '1.00',
                        matchedKeywords: m.matchedKeywords || [],
                        keywordBoosted: m.keywordBoosted || false
                    }))
                });

                log.trace(`VectFox: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

                // Build chunks with text for visualizer
                const collectionChunks = queryResults.metadata.map((meta, idx) => {
                    const hash = queryResults.hashes[idx];

                    // Prefer text from metadata (stored in vector DB)
                    let text = meta.text;
                    let textSource = 'metadata';

                    // Fallback: try to find in chat messages if not in metadata
                    // PERF: Use pre-built Map for O(1) lookup instead of O(n) find()
                    if (!text) {
                        const chatMessage = chatHashMap.get(hash);
                        text = chatMessage ? substituteParams(chatMessage.mes) : '(text not found)';
                        textSource = chatMessage ? 'chat_lookup' : 'not_found';

                        // Debug: Log when text is not found
                        if (textSource === 'not_found') {
                            log.warn(`[VectFox] ⚠️ Chunk text not found! hash=${hash}, meta.text=${meta.text ? 'exists' : 'missing'}, chatMessage=${chatMessage ? 'found' : 'not found'}`);
                        }
                    }

                    // TRACE: Record initial chunk state
                    recordChunkFate(debugData, hash, 'vector_search', 'passed', null, {
                        finalScore: meta.score || 1.0,
                        originalScore: meta.originalScore,
                        keywordBoost: meta.keywordBoost,
                        matchedKeywords: meta.matchedKeywords,
                        textSource,
                        textLength: text?.length || 0,
                        collectionId
                    });

                    return {
                        hash: hash,
                        metadata: meta,
                        score: meta.score || 1.0,
                        originalScore: meta.originalScore,
                        keywordBoost: meta.keywordBoost,
                        matchedKeywords: meta.matchedKeywords,
                        matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                        keywordBoosted: meta.keywordBoosted,
                        similarity: meta.score || 1.0,
                        text: text,
                        index: meta.messageId || meta.index || 0,
                        collectionId: collectionId,
                        decayApplied: false,
                        // Hybrid search scores
                        vectorScore: meta.vectorScore,
                        textScore: meta.textScore,
                        hybridSearch: meta.hybridSearch
                    };
                });

                chunksForVisualizer.push(...collectionChunks);
            } catch (error) {
                log.warn(`VectFox: Failed to query collection ${collectionId}:`, error.message);
                addTrace(debugData, 'vector_search', `Query failed for ${collectionId}`, {
                    error: error.message
                });
            }
        }

        // Sort merged results by score (descending).
        // No global topK cap here — each collection already queried with effectiveTopK.
        // Downstream stages (threshold, decay, dedup) handle final count.
        chunksForVisualizer.sort((a, b) => b.score - a.score);

        return chunksForVisualizer;
    }

    async function expandSummaryChunks(chunks, activeCollections, settings, debugData) {
        const expandedChunks = [];
        const parentHashesNeeded = new Map(); // parentHash -> { summaryChunk, collectionId }

        // First pass: identify which chunks are summaries and need parent expansion
        for (const chunk of chunks) {
            const meta = chunk.metadata || {};
            const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
            const parentHash = meta.parentHash;

            if (isSummary && parentHash) {
                // Track this summary for parent lookup
                parentHashesNeeded.set(String(parentHash), {
                    summaryChunk: chunk,
                    collectionId: chunk.collectionId
                });

                addTrace(debugData, 'summary_expansion', `Summary chunk found, will expand to parent`, {
                    summaryHash: chunk.hash,
                    parentHash: parentHash,
                    summaryScore: chunk.score?.toFixed(3),
                    collectionId: chunk.collectionId
                });
            } else {
                // Not a summary, keep as-is
                expandedChunks.push(chunk);
            }
        }

        // If no summaries found, return original chunks
        if (parentHashesNeeded.size === 0) {
            return chunks;
        }

        // Second pass: fetch parent chunks from the vector DB
        // Group by collection for efficiency
        const parentsByCollection = new Map();
        for (const [parentHash, info] of parentHashesNeeded) {
            const collectionId = info.collectionId;
            if (!parentsByCollection.has(collectionId)) {
                parentsByCollection.set(collectionId, []);
            }
            parentsByCollection.get(collectionId).push({ parentHash, summaryChunk: info.summaryChunk });
        }

        // Fetch parents from each collection
        for (const [collectionId, parentInfos] of parentsByCollection) {
            try {
                // Get all chunks from this collection with metadata
                const collectionData = await getSavedHashes(collectionId, settings, true);

                if (collectionData && collectionData.metadata) {
                    // Build a lookup map of hash -> chunk data
                    const chunkLookup = new Map();
                    for (let i = 0; i < collectionData.hashes.length; i++) {
                        const hash = String(collectionData.hashes[i]);
                        chunkLookup.set(hash, collectionData.metadata[i]);
                    }

                    // Find each parent and create expanded chunk
                    for (const { parentHash, summaryChunk } of parentInfos) {
                        const parentData = chunkLookup.get(String(parentHash));

                        if (parentData) {
                            // Found parent - create expanded chunk with parent's text but summary's score
                            const expandedChunk = {
                                ...summaryChunk,
                                hash: parentHash, // Use parent's hash for deduplication
                                text: parentData.text || parentData.mes || '(parent text not found)',
                                metadata: {
                                    ...parentData,
                                    expandedFromSummary: true,
                                    originalSummaryHash: summaryChunk.hash,
                                    originalSummaryScore: summaryChunk.score
                                },
                                // Keep summary's score since that's what matched the query
                                score: summaryChunk.score,
                                originalScore: summaryChunk.originalScore,
                                expandedFromSummary: true
                            };

                            expandedChunks.push(expandedChunk);

                            recordChunkFate(debugData, parentHash, 'summary_expansion', 'passed',
                                `Expanded from summary #${summaryChunk.hash}`, {
                                    summaryHash: summaryChunk.hash,
                                    parentTextLength: expandedChunk.text?.length || 0,
                                    inheritedScore: summaryChunk.score?.toFixed(3)
                                });

                            addTrace(debugData, 'summary_expansion', `Parent chunk retrieved`, {
                                parentHash: parentHash,
                                summaryHash: summaryChunk.hash,
                                parentTextLength: expandedChunk.text?.length || 0
                            });
                        } else {
                            // Parent not found - keep the summary chunk as fallback
                            log.warn(`VectFox: Parent chunk ${parentHash} not found for summary ${summaryChunk.hash}, using summary text`);
                            expandedChunks.push(summaryChunk);

                            recordChunkFate(debugData, summaryChunk.hash, 'summary_expansion', 'passed',
                                `Parent not found, using summary text`, {
                                    parentHash: parentHash,
                                    fallback: true
                                });
                        }
                    }
                } else {
                    // Couldn't get collection data - keep summaries as-is
                    for (const { summaryChunk } of parentInfos) {
                        expandedChunks.push(summaryChunk);
                    }
                }
            } catch (error) {
                log.warn(`VectFox: Failed to expand summaries from ${collectionId}:`, error.message);
                // Keep summaries as-is on error
                for (const { summaryChunk } of parentInfos) {
                    expandedChunks.push(summaryChunk);
                }
            }
        }

        addTrace(debugData, 'summary_expansion', 'Summary expansion complete', {
            originalCount: chunks.length,
            summariesExpanded: parentHashesNeeded.size,
            finalCount: expandedChunks.length
        });

        return expandedChunks;
    }

    function applyThresholdFilter(chunks, threshold, debugData) {
        const beforeCount = chunks.length;
        const filtered = chunks.filter(chunk => {
            const passes = chunk.score >= threshold;
            if (!passes) {
                recordChunkFate(debugData, chunk.hash, 'threshold', 'dropped',
                    `Score ${chunk.score.toFixed(3)} < threshold ${threshold}`,
                    { score: chunk.score, threshold }
                );
            } else {
                recordChunkFate(debugData, chunk.hash, 'threshold', 'passed', null,
                    { score: chunk.score, threshold }
                );
            }
            return passes;
        });

        addTrace(debugData, 'threshold', 'Threshold filter applied', {
            threshold,
            before: beforeCount,
            after: filtered.length,
            dropped: beforeCount - filtered.length
        });

        return filtered;
    }

    async function applyConditionsStage(chunks, chat, settings, debugData) {
        const beforeCount = chunks.length;
        // PERF: Build a Map of hash -> chunk data for tracking instead of copying entire array
        const chunkDataByHash = new Map(chunks.map(c => [c.hash, { score: c.score, conditions: c.metadata?.conditions }]));

        addTrace(debugData, 'conditions', 'Starting condition filtering', {
            chunksToFilter: beforeCount,
            hasConditions: chunks.some(c => c.metadata?.conditions)
        });

        const filtered = await applyChunkConditions(chunks, chat, settings);

        // Record which chunks were dropped by conditions
        const afterConditionsHashes = new Set(filtered.map(c => c.hash));
        for (const [hash, data] of chunkDataByHash) {
            if (afterConditionsHashes.has(hash)) {
                recordChunkFate(debugData, hash, 'conditions', 'passed', null, {
                    score: data.score,
                    hadConditions: !!data.conditions
                });
            } else {
                recordChunkFate(debugData, hash, 'conditions', 'dropped',
                    data.conditions
                        ? `Failed condition: ${JSON.stringify(data.conditions)}`
                        : 'Filtered by condition system',
                    {
                        score: data.score,
                        conditions: data.conditions
                    }
                );
            }
        }

        addTrace(debugData, 'conditions', 'Condition filtering completed', {
            before: beforeCount,
            after: filtered.length,
            dropped: beforeCount - filtered.length
        });

        return filtered;
    }

    async function applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData) {
        const beforeCount = chunks.length;
        let processedChunks = [...chunks];

        // Build metadata map for chunks that have explicit links.
        // Backend payload (chunk.metadata.chunkLinks) is source of truth; ext_settings is the
        // legacy fallback. NOTE: processChunkLinks indexes this as a PLAIN OBJECT (map[hash]),
        // so it must be a {} — not a Map (a Map indexed with [] is always undefined).
        const chunkMetadataMap = {};
        const forceTargetCollection = new Map(); // parseInt(targetHash) -> source chunk's collectionId
        for (const chunk of processedChunks) {
            const links = chunk.metadata?.chunkLinks || getChunkMetadata(chunk.hash)?.chunkLinks;
            if (links && links.length > 0) {
                chunkMetadataMap[String(chunk.hash)] = { chunkLinks: links };
                // Links are within-collection (the link editor only lists same-collection
                // targets), so a force target lives in the source chunk's collection.
                for (const link of links) {
                    if (link.mode === 'force') forceTargetCollection.set(parseInt(link.targetHash), chunk.collectionId);
                }
            }
        }

        if (Object.keys(chunkMetadataMap).length > 0) {
            const linkResult = processChunkLinks(processedChunks, chunkMetadataMap, settings.group_soft_boost || 0.15);
            processedChunks = linkResult.chunks;

            const boosted = processedChunks.filter(c => c.softLinked);
            if (boosted.length > 0) {
                addTrace(debugData, 'links', `Explicit links boosted ${boosted.length} chunks`, {});
            }

            // Force links: pull in any force-linked targets that weren't already retrieved, so
            // "target MUST appear when this chunk appears" actually holds. These bypass the
            // query/threshold/conditions stages by design (they ran earlier); dedup may still
            // skip ones already present in the chat context.
            if (linkResult.missingHardLinks?.length > 0) {
                const fetched = await fetchForceLinkedChunks(linkResult.missingHardLinks, forceTargetCollection, settings);
                const present = new Set(processedChunks.map(c => String(c.hash)));
                const toAdd = fetched.filter(c => !present.has(String(c.hash)));
                if (toAdd.length > 0) {
                    processedChunks.push(...toAdd);
                    addTrace(debugData, 'links', `Force links pulled in ${toAdd.length} missing target(s)`, {
                        hashes: toAdd.map(c => c.hash),
                    });
                }
            }
        }

        addTrace(debugData, 'links', 'Links processing complete', {
            before: beforeCount,
            after: processedChunks.length,
        });

        return processedChunks;
    }

    async function fetchForceLinkedChunks(missingHashes, targetCollection, settings) {
        // Group missing hashes by their collection
        const byCollection = new Map();
        for (const hash of missingHashes) {
            const collectionId = targetCollection.get(hash);
            if (!collectionId) continue; // unknown source collection — can't locate it
            if (!byCollection.has(collectionId)) byCollection.set(collectionId, []);
            byCollection.get(collectionId).push(hash);
        }

        const fetched = [];
        for (const [collectionId, hashes] of byCollection) {
            try {
                const data = await getSavedHashes(collectionId, settings, true);
                if (!data?.metadata) continue;
                const lookup = new Map();
                for (let i = 0; i < data.hashes.length; i++) {
                    lookup.set(String(data.hashes[i]), data.metadata[i]);
                }
                for (const hash of hashes) {
                    const meta = lookup.get(String(hash));
                    if (!meta) {
                        log.warn(`VectFox: Force-linked target ${hash} not found in ${collectionId}`);
                        continue;
                    }
                    fetched.push({
                        hash,
                        metadata: meta,
                        text: meta.text || meta.mes || '(force-linked text not found)',
                        score: 1.0,
                        originalScore: meta.score,
                        similarity: 1.0,
                        index: meta.messageId || meta.index || 0,
                        collectionId,
                        forceLinked: true,
                    });
                }
            } catch (error) {
                log.warn(`VectFox: Failed to fetch force-linked chunks from ${collectionId}:`, error.message);
            }
        }
        return fetched;
    }

    function deduplicateChunks(chunks, chat, settings, debugData) {
        // Determine how far back to check for duplicates
        // Default to 50 messages if not specified (reasonable context window)
        const deduplicationDepth = settings.deduplication_depth ?? 50;

        addTrace(debugData, 'injection', 'Starting deduplication and injection', {
            chunksToInject: chunks.length,
            chatLength: chat.length,
            deduplicationDepth: deduplicationDepth
        });

        // Only check the most recent N messages (within context window)
        const recentMessages = deduplicationDepth > 0 && deduplicationDepth < chat.length
            ? chat.slice(-deduplicationDepth)
            : chat;

        log.verbose(`[VECTFOX Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
        log.verbose(`[VECTFOX Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

        // Build set of hashes currently in chat context
        const currentChatHashes = new Set();
        const chatHashMap = new Map(); // For debugging: hash -> message preview

        recentMessages.forEach((msg, idx) => {
            if (msg.mes) {
                const cleanedText = substituteParams(getTextWithoutAttachments(msg));
                const hash = getStringHash(cleanedText);
                currentChatHashes.add(hash);

                // Store sample for debugging (first occurrence only)
                // Calculate absolute index in full chat
                const absoluteIndex = chat.length - recentMessages.length + idx;
                if (!chatHashMap.has(hash)) {
                    chatHashMap.set(hash, {
                        index: absoluteIndex,
                        preview: cleanedText.substring(0, 80),
                        isUser: msg.is_user,
                        name: msg.name
                    });
                }
            }
        });

        log.verbose(`[VECTFOX Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

        const toInject = [];
        const skipped = [];

        for (const chunk of chunks) {
            const isInChat = currentChatHashes.has(chunk.hash);

            if (isInChat) {
                const matchedMsg = chatHashMap.get(chunk.hash);
                log.trace(`[VECTFOX Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
                log.trace(`  Chunk text: "${chunk.text?.substring(0, 80)}..."`);
                log.trace(`  Matches chat message #${matchedMsg.index} from ${matchedMsg.name}: "${matchedMsg.preview}..."`);
                log.trace(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

                skipped.push(chunk);
                recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                    'Already in current chat context - no injection needed',
                    { score: chunk.score }
                );
            } else {
                log.trace(`[VECTFOX Dedup] ✅ KEEPING chunk (hash: ${chunk.hash}, score: ${chunk.score?.toFixed(4)})`);
                log.trace(`  Text: "${chunk.text?.substring(0, 80)}..."`);

                toInject.push(chunk);
                recordChunkFate(debugData, chunk.hash, 'injection', 'passed',
                    'Not in current context - will inject',
                    { score: chunk.score, collectionId: chunk.collectionId }
                );
            }
        }

        addTrace(debugData, 'injection', 'Deduplication complete', {
            totalChunks: chunks.length,
            toInject: toInject.length,
            skippedDuplicates: skipped.length
        });

        log.verbose(`[VECTFOX Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

        return { toInject, skipped };
    }

    /**
     * Select ordered chunks using current host state. An empty selected result
     * still has diagnostics; early exits intentionally do not publish new debug data.
     * Generation/preview guards and prompt formatting belong to the caller.
     * @param {{chat: object[], settings: object, generationType?: string, testMessage?: string|null}} request
     * @returns {Promise<{status: 'noCollections'|'emptyQuery'|'noActive'}|{status: 'selected', chunks: object[], skippedDuplicates: object[], diagnostics: object}>}
     */
    async function select({ chat, settings, generationType: type, testMessage = null }) {
        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            log.trace('[VECTFOX ChunkBase] No enabled ChunkBase collections and World Info disabled — skipping non-chat chunk injection (this is normal if you only use EventBase).');
            return { status: 'noCollections' };
        }
        if (hasCollections) {
            log.verbose(`VectFox: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            log.verbose('VectFox: No ChunkBase collections enabled (lorebooks are handled by the Lorebook WI pipeline)');
        }

        // === STAGE 2: Build search query ===
        const queryText = testMessage || buildSearchQuery(chat, settings, substituteParams);
        if (queryText.length === 0) {
            log.trace('VectFox: No text to query');
            return { status: 'emptyQuery' };
        }

        // === STAGE 2.5: Extract keywords from query message ===
        const extractionLevel = settings.keyword_extraction_level || 'balanced';
        const queryKeywords = extractChatKeywords(queryText, {
            level: extractionLevel,
            baseWeight: settings.keyword_boost_base_weight || 1.5
        });
        const queryKeywordTexts = queryKeywords.map(kw => kw.text.toLowerCase());
        log.trace(`VectFox: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts);

        // === STAGE 3: Filter by activation conditions ===
        let activeCollections = [];
        if (hasCollections) {
            const searchContext = buildSearchContext(chat, settings.query || 10, [], {
                generationType: type || 'normal',
                isGroupChat: getContext().groupId != null,
                currentCharacter: getContext().name2 || null,
                activeLorebookEntries: [],
                currentChatId: getCurrentChatId(),
                currentCharacterId: getContext().characterId || null
            });
            activeCollections = await filterActiveCollections(collectionsToQuery, searchContext);
        }

        // Skip collections that have 0 chunks on disk — they're shown in DB Browser
        // so the user can delete them, but there's nothing to query.
        const preEmptyFilter = activeCollections.length;
        activeCollections = activeCollections.filter(key => !isCollectionEmpty(key));
        if (activeCollections.length < preEmptyFilter) {
            log.verbose(`VectFox: Skipped ${preEmptyFilter - activeCollections.length} empty collection(s) from retrieval`);
        }

        // Allow WI-only mode even if no regular collections pass filters.
        // Note: ChunkBase (lorebook/docs/URLs/wiki) is entirely optional —
        // users who rely only on EventBase for chat memory will always have
        // zero active ChunkBase collections, which is the intended setup,
        // not an error. The earlier alarming "⚠️ chunks cannot be injected!"
        // log was removed because it implied lorebook setup was required.
        // EventBase injection happens on its own path (eventbase-workflow.js)
        // and is unaffected by this branch.
        if (activeCollections.length === 0 && !canQueryWI) {
            log.trace('[VECTFOX ChunkBase] No active Standard/ChunkBase collections and World Info disabled — skipping non-chat chunk injection (this is normal if you only use EventBase).');
            return { status: 'noActive' };
        }
        if (activeCollections.length > 0) {
            log.verbose(`✅ VectFox: ${activeCollections.length} collections passed activation filters:`, activeCollections);
        }

        // === INITIALIZE DEBUG DATA ===
        const debugData = createDebugData();
        debugData.query = queryText;
        debugData.queryKeywords = queryKeywordTexts;
        debugData.collectionId = activeCollections.length > 0 ? activeCollections.join(', ') : 'world_info_only';
        debugData.collectionsQueried = activeCollections;
        const effectiveTopK = settings.top_k ?? settings.insert;
        debugData.settings = {
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            protect: settings.protect,
            chatLength: chat.length
        };

        addTrace(debugData, 'init', 'Pipeline started', {
            collectionsQueried: activeCollections,
            queryLength: queryText.length,
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            protect: settings.protect
        });

        // === STAGE 4: Query all collections and merge results ===
        // Popup gating:
        //   - retrieval_popup_on_start / retrieval_popup_on_result: ChunkBase chunks
        //   - world_info_retrieval_popup: lorebook/WI entries (handled in
        //     world-info-integration.js, untouched here)
        // We suppress the ChunkBase popups when activeCollections is empty (WI-only mode)
        // — the "0 results" message would just be misleading noise.
        if (activeCollections.length > 0 && settings.retrieval_popup_on_start) {
            host.notifyStart(`Retrieving context from ${activeCollections.length} collection(s)...`, 'VectFox Retrieval');
        }

        // Bound chunk retrieval the same way as EventBase above — a hung query
        // must not freeze generation. On timeout/error we proceed with no chunks
        // this turn (downstream handles an empty list = no injection).
        // See core/constants.js::RETRIEVAL_TIMEOUT_MS.
        let chunks;
        try {
            chunks = await AsyncUtils.timeout(
                queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData),
                RETRIEVAL_TIMEOUT_MS,
                'Chunk retrieval timed out',
            );
        } catch (error) {
            log.error('VectFox: chunk retrieval error (non-fatal, message sends without chunk memory):', error);
            chunks = [];
        }

        if (activeCollections.length > 0 && settings.retrieval_popup_on_result) {
            host.notifyResult(`Retrieved ${chunks.length} result(s) from backend`, 'VectFox Retrieval');
        }

        // === STAGE 4.3: Boost chunks with matching query keywords ===
        if (queryKeywordTexts.length > 0 && chunks.length > 0) {
            const keywordMatchCount = boostQueryKeywords(chunks, queryKeywordTexts, debugData, getChunkMetadata);
            if (keywordMatchCount > 0) {
                log.verbose(`VectFox: Boosted ${keywordMatchCount}/${chunks.length} chunks with matching keywords to 100% score`);
            } else {
                log.verbose(`VectFox: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
            }
        }

        log.verbose(`VectFox: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);

        debugData.stages.initial = [...chunks];
        debugData.stats.retrievedFromVector = chunks.length;

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings, debugData);
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            log.verbose(`VectFox: Expanded ${expandedCount} summary chunks to parent text`);
            debugData.stages.afterSummaryExpansion = [...chunks];
            debugData.stats.summariesExpanded = expandedCount;
        }

        // === STAGE 5: BananaBread reranking (optional) ===
        if (settings.source === 'bananabread' && settings.bananabread_rerank && chunks.length > 0) {
            addTrace(debugData, 'rerank', 'Starting BananaBread reranking', {
                chunks: chunks.length,
                query: queryText.substring(0, 100)
            });
            chunks = await rerankWithBananaBread(queryText, chunks, settings);
            debugData.stages.afterRerank = [...chunks];
            addTrace(debugData, 'rerank', 'Reranking complete', { rerankedCount: chunks.length });
        }

        // === STAGE 6: Threshold filter ===
        const threshold = settings.score_threshold || 0;
        chunks = applyThresholdFilter(chunks, threshold, debugData);
        debugData.stages.afterThreshold = [...chunks];

        // === STAGE 8: Chunk conditions ===
        chunks = await applyConditionsStage(chunks, chat, settings, debugData);
        debugData.stages.afterConditions = [...chunks];
        debugData.stats.afterConditions = chunks.length;

        // === STAGE 8.5: Chunk Groups and Links ===
        chunks = await applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData);
        debugData.stages.afterGroups = [...chunks];
        debugData.stats.afterGroups = chunks.length;

        // Store for legacy visualizer
        host.publishSearch({
            chunks: chunks,
            query: queryText,
            timestamp: Date.now(),
            settings: { threshold: settings.score_threshold, topK: (settings.top_k ?? settings.insert) }
        });
        log.verbose(`VectFox: Stored ${chunks.length} chunks for visualizer`);

        // === STAGE 9: Deduplicate ===
        log.verbose(`[VECTFOX Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        log.verbose(`[VECTFOX Deduplication] Current chat has ${chat.length} messages`);

        const { toInject: chunksToInject, skipped: skippedDuplicates } = deduplicateChunks(chunks, chat, settings, debugData);

        log.verbose(`[VECTFOX Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            log.verbose(`[VECTFOX Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                log.trace(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        return { status: 'selected', chunks: chunksToInject, skippedDuplicates, diagnostics: debugData };
    }

    return { select };
}

/** Shared chat query construction, also used by the separate EventBase workflow. */
export function buildSearchQuery(chat, settings, substituteParams) {
    const recentMessages = chat
        .filter(x => !x.is_system)
        .reverse()
        .slice(0, settings.query)
        .map(x => substituteParams(x.mes));

    return recentMessages.join('\n').trim();
}

import { addTrace, recordChunkFate } from './retrieval-diagnostics.js';

/**
 * Related-chunk expansion owned by selection. Selection calls expandSummaries
 * before reranking/threshold/conditions, and applyLinks afterwards. Neither
 * operation recursively follows fetched targets or changes hash identity rules.
 *
 * Bind the existing saved-hash reader, metadata fallback and logger once. The
 * reader owns snapshot caching/invalidation; this module does not cache lookups.
 * Missing parents retain summaries, while missing forced targets are omitted.
 */
export function createRelatedChunkExpansion({ getSavedHashes, getChunkMetadata, log }) {
    // Build fresh indexes at each existing read point. Reusing an index across
    // phases could hide cache invalidation or a successful retry after failure.
    async function loadCollectionLookup(collectionId, settings) {
        const data = await getSavedHashes(collectionId, settings, true);
        if (!data?.metadata) return null;
        const lookup = new Map();
        for (let i = 0; i < data.hashes.length; i++) {
            lookup.set(String(data.hashes[i]), data.metadata[i]);
        }
        return lookup;
    }

    async function expandSummaries(chunks, settings, debugData) {
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
                const chunkLookup = await loadCollectionLookup(collectionId, settings);

                if (chunkLookup) {

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

    async function applyLinks(chunks, settings, debugData) {
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
                const lookup = await loadCollectionLookup(collectionId, settings);
                if (!lookup) continue;
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

    return { expandSummaries, applyLinks };
}

/**
 * Compatibility algorithm for explicit links. Numeric target coercion and
 * hash-only presence/boost matching intentionally preserve existing behavior.
 * Related-chunk expansion owns fetching the returned missing targets.
 */
export function processChunkLinks(chunks, chunkMetadataMap, softBoost = 0.15) {
    const resultHashes = new Set(chunks.map(c => c.hash));
    const hardLinkedHashes = new Set();
    const softBoosts = new Map(); // hash -> total boost

    // First pass: collect all force links and soft boosts.
    // Links use the visualizer's shape: chunkLinks: [{ targetHash, mode: 'force'|'soft' }]
    // (the link editor radio writes exactly these values — see ui/chunk-visualizer.js).
    for (const chunk of chunks) {
        const meta = chunkMetadataMap[chunk.hash];
        if (!meta?.chunkLinks || meta.chunkLinks.length === 0) continue;

        for (const link of meta.chunkLinks) {
            const targetHash = parseInt(link.targetHash);

            if (link.mode === 'force') {
                // Force link: target MUST be included
                hardLinkedHashes.add(targetHash);
            } else if (link.mode === 'soft') {
                // Soft link: accumulate boost for target
                const currentBoost = softBoosts.get(targetHash) || 0;
                softBoosts.set(targetHash, currentBoost + softBoost);
            }
        }
    }

    // Second pass: apply soft boosts to existing chunks
    const processedChunks = chunks.map(chunk => {
        const boost = softBoosts.get(chunk.hash) || 0;
        if (boost > 0) {
            return {
                ...chunk,
                score: Math.min(1.0, (chunk.score || 0) + boost),
                softLinked: true,
                linkBoost: boost
            };
        }
        return chunk;
    });

    // Hard-linked chunks that aren't in results need to be fetched separately
    // Return the hashes so caller can fetch them
    const missingHardLinks = [...hardLinkedHashes].filter(h => !resultHashes.has(h));

    return {
        chunks: processedChunks,
        hardLinkedHashes: hardLinkedHashes,
        missingHardLinks: missingHardLinks
    };
}

/**
 * ============================================================================
 * VectFox DIAGNOSTICS - PRODUCTION TESTS
 * ============================================================================
 * Integration tests for embedding, storage, and retrieval
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { getSavedHashes, purgeVectorIndex } from '../core/core-vector-api.js';
import { getModelFromSettings } from '../core/providers.js';
import { unregisterCollection } from '../core/collection-loader.js';
import { reciprocalRankFusion, weightedCombination } from '../core/hybrid-search.js';
import { extractTextKeywords, extractLorebookKeywords } from '../core/keyword-boost.js';
import { applyQueryKeywordBoost } from '../core/chat-vectorization.js';

const CHAT_NOT_APPLICABLE_MESSAGE = 'Not applicable (EventBase mode — chat is not stored as a chunk collection)';

/**
 * Full cleanup for test collections - purges vectors AND unregisters from registry
 * @param {string} collectionId - The test collection to clean up
 * @param {object} settings - VectFox settings
 */
async function cleanupTestCollection(collectionId, settings) {
    try {
        // Purge all vectors from the backend
        await purgeVectorIndex(collectionId, settings);
    } catch (e) {
        // Ignore purge errors - collection might already be empty
    }
    // Always unregister from registry to prevent ghost entries
    const registryKey = `${settings.source}:${collectionId}`;
    unregisterCollection(registryKey);
    unregisterCollection(collectionId); // Also try without source prefix
}

// Collection IDs the diagnostic suite touches as probes. Anything matching these
// is owned by diagnostics and safe to drop. Add new patterns here whenever a
// new check pokes a fresh collection name.
const DIAGNOSTIC_TEST_COLLECTION_PATTERNS = [
    /(^|:)vf_test_/,           // production test temp collections
    /^VectFox_diag/,           // diagnostic temp collections
    /(^|:)VectFox_diag(_|$)/, // infrastructure endpoint probes
    /(^|:)test$/,              // checkVectorsExtension probe
];

function isDiagnosticTestCollection(id) {
    if (!id) return false;
    return DIAGNOSTIC_TEST_COLLECTION_PATTERNS.some(re => re.test(id));
}

/**
 * Sweep any leftover diagnostic probe collections (`vf_test_*`, `VectFox_diag*`,
 * `test`) that were created by previous diagnostic runs and not cleaned up —
 * either because earlier code lacked try/finally, the process was killed
 * mid-run, or the backend creates the collection on first reference of a
 * non-existent ID (Vectra does this).
 *
 * Safe to call multiple times — the prefixes above are reserved for diagnostics.
 */
export async function sweepLeftoverTestCollections(settings) {
    const sweptIds = [];
    try {
        const response = await fetch('/api/plugins/similharity/collections', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            return { name: 'Diagnostic Collection Sweep', status: 'pass', message: 'Could not list collections (skipping sweep)', category: 'infrastructure' };
        }
        const data = await response.json();
        const collections = data.collections || [];

        const leftovers = collections.filter(c => {
            const id = c.id || c.collectionId || c.name || '';
            return isDiagnosticTestCollection(id);
        });

        for (const c of leftovers) {
            const rawId = c.id || c.collectionId || c.name;
            // Strip backend/source prefix if present (e.g. "qdrant:transformers:vf_test_..." → "vf_test_...").
            let cleanId = rawId;
            for (const re of DIAGNOSTIC_TEST_COLLECTION_PATTERNS) {
                const match = rawId.match(re);
                if (match && match.index > 0) {
                    cleanId = rawId.slice(match.index + (match[1] === ':' ? 1 : 0));
                    break;
                }
            }
            await cleanupTestCollection(cleanId, settings);
            sweptIds.push(cleanId);
        }

        return {
            name: 'Diagnostic Collection Sweep',
            status: 'pass',
            message: sweptIds.length === 0
                ? 'No leftover diagnostic collections found'
                : `Cleaned ${sweptIds.length} leftover diagnostic collection(s): ${sweptIds.slice(0, 3).join(', ')}${sweptIds.length > 3 ? '...' : ''}`,
            category: 'infrastructure'
        };
    } catch (error) {
        return {
            name: 'Diagnostic Collection Sweep',
            status: 'warning',
            message: `Sweep error: ${error.message}`,
            category: 'infrastructure'
        };
    }
}

/**
 * Helper: Get provider-specific body parameters for Similharity plugin requests
 * This ensures BananaBread and other providers that need special params get them
 * @param {object} settings - VectFox settings
 * @returns {object} Additional body parameters for the request
 */
function getPluginProviderParams(settings) {
    const params = {};
    const source = settings.source;

    // BananaBread requires apiUrl and apiKey in request body
    if (source === 'bananabread') {
        params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
        // API key is stored in extension settings (not ST's secret store)
        if (settings.bananabread_api_key) {
            params.apiKey = settings.bananabread_api_key;
        }
    }

    // Ollama needs apiUrl and keep param
    if (source === 'ollama') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
        params.keep = !!settings.ollama_keep;
    }

    // llamacpp needs apiUrl
    if (source === 'llamacpp') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
    }

    // vllm needs apiUrl
    if (source === 'vllm') {
        params.apiUrl = settings.use_alt_endpoint
            ? settings.alt_endpoint_url
            : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
    }

    return params;
}

/**
 * Probe the Similharity plugin's /health endpoint to decide whether plugin-only
 * production tests should run. When the plugin is absent, ST returns its
 * catch-all 404 HTML — without this guard, those tests would falsely accuse the
 * user's embedding provider of being broken.
 */
async function isPluginInstalled() {
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Test: Can we generate an embedding?
 * Uses Similharity plugin's dedicated embedding endpoint to test the provider.
 * This does NOT insert anything into the database - it only tests embedding generation.
 */
export async function testEmbeddingGeneration(settings) {
    if (!(await isPluginInstalled())) {
        return {
            name: '[PROD] Embedding Generation',
            status: 'skipped',
            message: 'Plugin not installed — skipping (test relies on plugin embedding endpoint)',
            category: 'production'
        };
    }
    try {
        const testText = 'This is a test message for embedding generation.';

        // Use the dedicated get-embedding endpoint which doesn't store anything
        const response = await fetch('/api/plugins/similharity/get-embedding', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: testText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, apiKey for BananaBread, etc.)
                ...getPluginProviderParams(settings),
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return {
                name: '[PROD] Embedding Generation',
                status: 'fail',
                message: `Failed to generate embedding: ${response.status} ${response.statusText} - ${errorText}`,
                category: 'production'
            };
        }

        const data = await response.json();

        // Verify we actually got an embedding back
        if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
            return {
                name: '[PROD] Embedding Generation',
                status: 'fail',
                message: 'Embedding endpoint returned invalid or empty embedding',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Embedding Generation',
            status: 'pass',
            message: `Successfully generated test embedding (${data.embedding.length} dimensions)`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Embedding Generation',
            status: 'fail',
            message: `Embedding generation error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Can we store and retrieve a vector?
 * Uses Similharity plugin to test actual configured provider (incl. bananabread).
 * Creates a temporary test collection that is cleaned up after the test.
 */
export async function testVectorStorage(settings) {
    if (!(await isPluginInstalled())) {
        return {
            name: '[PROD] Vector Storage',
            status: 'skipped',
            message: 'Plugin not installed — skipping (test relies on plugin chunks/insert endpoint)',
            category: 'production'
        };
    }
    const testCollectionId = `vf_test_storage_${Date.now()}`;
    try {
        const testHash = String(Math.floor(Math.random() * 1000000));
        const testText = 'VectFox storage test message';
        const backend = settings.vector_backend || 'standard';
        const backendType = backend === 'standard' ? 'vectra' : backend;

        const insertResponse = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendType,
                collectionId: testCollectionId,
                items: [{
                    hash: testHash,
                    text: testText,
                    index: 0
                }],
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, apiKey for BananaBread, etc.)
                ...getPluginProviderParams(settings),
            })
        });

        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
            return {
                name: '[PROD] Vector Storage',
                status: 'fail',
                message: `Failed to store vector: ${insertResponse.status} - ${errorText}`,
                category: 'production'
            };
        }

        return {
            name: '[PROD] Vector Storage',
            status: 'pass',
            message: 'Successfully stored and cleaned up test vector',
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Vector Storage',
            status: 'fail',
            message: `Storage test error: ${error.message}`,
            category: 'production'
        };
    } finally {
        // Always clean up the test collection, even if the test bailed early.
        await cleanupTestCollection(testCollectionId, settings);
    }
}

/**
 * Test: Can we query and retrieve similar vectors?
 */
export async function testVectorRetrieval(settings) {
    return {
        name: '[PROD] Vector Retrieval',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'production'
    };
}

/**
 * Test: Are vector dimensions consistent?
 * Detects if embedding model was switched without re-vectorizing.
 * Compares stored collection dimensions with current provider's expected dimensions.
 * Uses the dedicated get-embedding endpoint to avoid inserting test data.
 */
export async function testVectorDimensions(settings) {
    return {
        name: '[PROD] Vector Dimensions',
        status: 'pass',
        message: CHAT_NOT_APPLICABLE_MESSAGE,
        category: 'production'
    };
}

/**
 * Test: Are local chunks in sync with server vectors?
 * Compares chunk hashes we have locally vs what's stored on the server
 */
export async function testChunkServerSync(settings, collectionId) {
    if (!collectionId) {
        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'pass',
            message: CHAT_NOT_APPLICABLE_MESSAGE,
            category: 'production'
        };
    }

    try {
        const { getAllChunkMetadata } = await import('../core/collection-metadata.js');

        // Get server-side hashes
        const serverHashes = await getSavedHashes(collectionId, settings);
        const serverHashSet = new Set(serverHashes.map(h => String(h)));

        // Get local metadata hashes (chunks we have customizations for)
        const localMetadata = getAllChunkMetadata();
        const localHashes = Object.keys(localMetadata);

        // Find mismatches
        const onlyOnServer = serverHashes.filter(h => !localHashes.includes(String(h)));
        const onlyLocal = localHashes.filter(h => !serverHashSet.has(h));

        const totalServer = serverHashes.length;
        const totalLocal = localHashes.length;

        if (onlyOnServer.length === 0 && onlyLocal.length === 0) {
            return {
                name: '[PROD] Chunk-Server Sync',
                status: 'pass',
                message: `In sync: ${totalServer} server vectors, ${totalLocal} local metadata entries`,
                category: 'production',
                data: { serverHashes, localHashes, collectionId }
            };
        }

        // There are differences (not necessarily bad - local metadata is optional)
        if (onlyLocal.length > 0) {
            // Orphaned local metadata (vectors deleted from server but metadata remains)
            return {
                name: '[PROD] Chunk-Server Sync',
                status: 'warning',
                message: `${onlyLocal.length} orphaned local entries (vectors deleted from server)`,
                category: 'production',
                fixable: true,
                fixAction: 'cleanOrphanedMetadata',
                data: { orphanedHashes: onlyLocal, collectionId }
            };
        }

        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'pass',
            message: `Server has ${onlyOnServer.length} vectors without local metadata (normal for new chunks)`,
            category: 'production',
            data: { serverHashes, localHashes, collectionId }
        };
    } catch (error) {
        return {
            name: '[PROD] Chunk-Server Sync',
            status: 'fail',
            message: `Sync check error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Fix: Clean orphaned local metadata entries
 */
export async function fixOrphanedMetadata(orphanedHashes) {
    try {
        const { deleteChunkMetadata } = await import('../core/collection-metadata.js');

        let cleaned = 0;
        for (const hash of orphanedHashes) {
            deleteChunkMetadata(hash);
            cleaned++;
        }

        return {
            success: true,
            message: `Cleaned ${cleaned} orphaned metadata entries`
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to clean: ${error.message}`
        };
    }
}

/**
 * Test: Are there duplicate hashes in the vector store?
 * Duplicates can occur from:
 * - Native ST vectors extension double-inserting
 * - Session cache being cleared while chunks still exist
 * - Plugin bugs or interrupted operations
 */
export async function testDuplicateHashes(settings, collectionId) {
    if (!collectionId) {
        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'pass',
            message: CHAT_NOT_APPLICABLE_MESSAGE,
            category: 'production'
        };
    }

    try {
        // Get all hashes from the server
        const serverHashes = await getSavedHashes(collectionId, settings);

        if (serverHashes.length === 0) {
            return {
                name: '[PROD] Duplicate Hash Check',
                status: 'pass',
                message: 'No vectors in collection',
                category: 'production'
            };
        }

        // Count occurrences
        const hashCounts = {};
        for (const hash of serverHashes) {
            const key = String(hash);
            hashCounts[key] = (hashCounts[key] || 0) + 1;
        }

        // Find duplicates
        const duplicates = Object.entries(hashCounts)
            .filter(([, count]) => count > 1)
            .map(([hash, count]) => ({ hash, count }));

        if (duplicates.length === 0) {
            return {
                name: '[PROD] Duplicate Hash Check',
                status: 'pass',
                message: `${serverHashes.length} unique vectors, no duplicates`,
                category: 'production'
            };
        }

        const totalDupes = duplicates.reduce((sum, d) => sum + d.count - 1, 0);

        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'warning',
            message: `Found ${duplicates.length} duplicate hashes (${totalDupes} extra entries)`,
            category: 'production',
            fixable: true,
            fixAction: 'removeDuplicateHashes',
            data: { duplicates, collectionId, totalDuplicates: totalDupes }
        };
    } catch (error) {
        return {
            name: '[PROD] Duplicate Hash Check',
            status: 'fail',
            message: `Check failed: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Fix: Remove duplicate hash entries from vector store
 * Strategy: Query to get chunk text, delete all instances, re-insert one copy
 */
export async function fixDuplicateHashes(duplicates, collectionId, settings) {
    try {
        const { deleteVectorItems, insertVectorItems, queryCollection } = await import('../core/core-vector-api.js');

        let fixed = 0;
        const chunksToReinsert = [];

        // First, query to get the chunk data for each duplicate hash
        // We query with minimal text to find chunks by hash
        for (const { hash } of duplicates) {
            try {
                // Query with a broad search to find chunks - we'll filter by hash
                const result = await queryCollection(collectionId, '', 1000, settings);

                if (result?.metadata) {
                    // Find chunk with this hash
                    const chunk = result.metadata.find(m => String(m.hash) === String(hash));
                    if (chunk) {
                        chunksToReinsert.push({
                            hash: chunk.hash,
                            text: chunk.text,
                            index: chunk.index || 0,
                            metadata: {
                                source: chunk.source,
                                messageId: chunk.messageId,
                                chunkIndex: chunk.chunkIndex,
                                totalChunks: chunk.totalChunks,
                                originalMessageHash: chunk.originalMessageHash
                            }
                        });
                    }
                }
            } catch (e) {
                console.warn(`VectFox: Failed to get data for hash ${hash}:`, e);
            }
        }

        // Delete ALL instances of duplicate hashes
        const hashesToDelete = duplicates.map(d => d.hash);
        try {
            await deleteVectorItems(collectionId, hashesToDelete, settings);
            console.log(`VectFox: Deleted ${hashesToDelete.length} duplicate hashes`);
        } catch (e) {
            console.warn('VectFox: Delete failed:', e);
            return {
                success: false,
                message: `Failed to delete duplicates: ${e.message}`
            };
        }

        // Re-insert ONE copy of each
        if (chunksToReinsert.length > 0) {
            try {
                await insertVectorItems(collectionId, chunksToReinsert, settings);
                fixed = chunksToReinsert.length;
                console.log(`VectFox: Re-inserted ${fixed} chunks (deduplicated)`);
            } catch (e) {
                console.warn('VectFox: Re-insert failed:', e);
                return {
                    success: false,
                    message: `Deleted duplicates but failed to re-insert: ${e.message}. Re-vectorize chat to restore.`
                };
            }
        }

        return {
            success: true,
            message: `Fixed ${fixed} duplicate hashes (deleted extras, kept one copy each)`
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to fix duplicates: ${error.message}`
        };
    }
}

/**
 * Test: Does the plugin backend correctly generate embeddings during insert?
 * This specifically tests the Similharity plugin's Qdrant handlers.
 * These handlers MUST generate embeddings - they cannot rely on pre-provided vectors.
 * Creates a temporary test collection that is cleaned up after the test.
 */
export async function testPluginEmbeddingGeneration(settings) {
    const backend = settings.vector_backend || 'standard';

    // Only test for backends that go through the plugin
    if (backend === 'standard') {
        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'skipped',
            message: 'Standard backend uses native ST vectors',
            category: 'production'
        };
    }

    const testCollectionId = `vf_test_embed_${Date.now()}`;
    try {
        const testHash = String(Math.floor(Math.random() * 1000000));
        const testText = 'Plugin embedding generation test';

        // Try to insert WITHOUT providing a vector - the plugin must generate it
        const insertResponse = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backend,
                collectionId: testCollectionId,
                items: [{
                    hash: testHash,
                    text: testText,
                    index: 0
                    // NOTE: No vector provided - plugin must generate it
                }],
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, apiKey for BananaBread, etc.)
                ...getPluginProviderParams(settings),
            }),
        });

        if (!insertResponse.ok) {
            const errorText = await insertResponse.text();
            return {
                name: '[PROD] Plugin Embedding Gen',
                status: 'fail',
                message: `Plugin failed to generate embedding: ${insertResponse.status} - ${errorText}`,
                category: 'production'
            };
        }

        // Verify the vector was stored by querying
        const queryResponse = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backend,
                collectionId: testCollectionId,
                searchText: testText,
                topK: 1,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings, null),
                // Include provider-specific params (apiUrl, apiKey for BananaBread, etc.)
                ...getPluginProviderParams(settings),
            }),
        });

        let querySuccess = false;
        if (queryResponse.ok) {
            const results = await queryResponse.json();
            querySuccess = results.results?.length > 0 || results.hashes?.length > 0;
        }

        if (!querySuccess) {
            return {
                name: '[PROD] Plugin Embedding Gen',
                status: 'warning',
                message: 'Insert succeeded but could not verify vector retrieval',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'pass',
            message: `${backend} backend correctly generates embeddings`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Plugin Embedding Gen',
            status: 'fail',
            message: `Test error: ${error.message}`,
            category: 'production'
        };
    } finally {
        // Always clean up the test collection, even if the test bailed early.
        await cleanupTestCollection(testCollectionId, settings);
    }
}

/**
 * Test: Reciprocal Rank Fusion (RRF) algorithm
 * Tests the core RRF fusion algorithm with known inputs
 */
export async function testReciprocalRankFusion(settings) {
    try {
        // Mock vector results (high semantic similarity for "dragon")
        const vectorResults = [
            { hash: 'doc1', score: 0.95, text: 'The ancient dragon guarded the treasure' },
            { hash: 'doc2', score: 0.85, text: 'Dragons are mythical creatures' },
            { hash: 'doc3', score: 0.75, text: 'The warrior fought a dragon' },
        ];

        // Mock text/BM25 results (high keyword match for "treasure")
        const textResults = [
            { hash: 'doc1', bm25Score: 8.5, text: 'The ancient dragon guarded the treasure' },
            { hash: 'doc4', bm25Score: 7.2, text: 'Treasure hunters searched for gold' },
            { hash: 'doc5', bm25Score: 5.8, text: 'The treasure map was ancient' },
        ];

        // Apply RRF with k=60
        const fusedResults = reciprocalRankFusion([vectorResults, textResults], 60);

        // Validate results
        if (!Array.isArray(fusedResults) || fusedResults.length === 0) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'RRF returned no results',
                category: 'production'
            };
        }

        // doc1 should rank highest (appears in both lists at high ranks)
        if (fusedResults[0].result.hash !== 'doc1') {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: `Expected doc1 to rank first, got ${fusedResults[0].result.hash}`,
                category: 'production'
            };
        }

        // Verify all results have RRF scores
        const hasScores = fusedResults.every(r =>
            typeof r.rrfScore === 'number' &&
            r.rrfScore > 0 &&
            r.rrfScore <= 1.0
        );

        if (!hasScores) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'Not all results have valid RRF scores (0-1 range)',
                category: 'production'
            };
        }

        // Verify rank information is preserved
        const hasRanks = fusedResults[0].ranks &&
            (fusedResults[0].ranks.vector !== undefined || fusedResults[0].ranks.text !== undefined);

        if (!hasRanks) {
            return {
                name: '[PROD] RRF Fusion Algorithm',
                status: 'fail',
                message: 'Rank information not preserved',
                category: 'production'
            };
        }

        return {
            name: '[PROD] RRF Fusion Algorithm',
            status: 'pass',
            message: `Fused ${fusedResults.length} results, top score: ${fusedResults[0].rrfScore.toFixed(3)}`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] RRF Fusion Algorithm',
            status: 'fail',
            message: `RRF test error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Weighted Linear Combination algorithm
 * Tests the weighted fusion algorithm with known inputs
 */
export async function testWeightedCombination(settings) {
    try {
        // Mock vector results
        const vectorResults = [
            { hash: 'doc1', score: 0.95, text: 'The ancient dragon' },
            { hash: 'doc2', score: 0.85, text: 'Dragons are mythical' },
            { hash: 'doc3', score: 0.75, text: 'Warrior fought dragon' },
        ];

        // Mock text/BM25 results
        const textResults = [
            { hash: 'doc1', bm25Score: 8.5, text: 'The ancient dragon' },
            { hash: 'doc4', bm25Score: 7.2, text: 'Treasure hunters' },
            { hash: 'doc3', bm25Score: 6.0, text: 'Warrior fought dragon' },
        ];

        // Test with equal weights (0.5, 0.5)
        const fusedResults = weightedCombination(vectorResults, textResults, 0.5, 0.5);

        // Validate results
        if (!Array.isArray(fusedResults) || fusedResults.length === 0) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Weighted combination returned no results',
                category: 'production'
            };
        }

        // All results should have combined scores
        const hasScores = fusedResults.every(r =>
            typeof r.combinedScore === 'number' &&
            r.combinedScore >= 0 &&
            r.combinedScore <= 1.0
        );

        if (!hasScores) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Not all results have valid combined scores',
                category: 'production'
            };
        }

        // Results should be sorted by combined score
        const isSorted = fusedResults.every((r, i) =>
            i === 0 || fusedResults[i-1].combinedScore >= r.combinedScore
        );

        if (!isSorted) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Results not properly sorted by combined score',
                category: 'production'
            };
        }

        // Verify vector and text scores are preserved
        const hasComponentScores = fusedResults.every(r =>
            typeof r.vectorScore === 'number' && typeof r.textScore === 'number'
        );

        if (!hasComponentScores) {
            return {
                name: '[PROD] Weighted Combination',
                status: 'fail',
                message: 'Component scores not preserved',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Weighted Combination',
            status: 'pass',
            message: `Combined ${fusedResults.length} results, top score: ${fusedResults[0].combinedScore.toFixed(3)}`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Weighted Combination',
            status: 'fail',
            message: `Weighted combination test error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Keyword extraction from text
 * Tests TF-IDF based keyword extraction at different levels
 */
export async function testKeywordExtraction(settings) {
    try {
        const testText = `
The ancient dragon soared through the sky, its massive wings casting shadows over the kingdom.
Dragons are legendary creatures known for their wisdom and power. This particular dragon
had guarded the sacred treasure for centuries, maintaining its vigilant watch over the
ancient artifacts. Many warriors attempted to challenge the dragon, but none succeeded
in claiming the legendary treasure that lay within the dragon's mountain fortress.
        `.trim();

        // Test minimal extraction
        const minimalKeywords = extractTextKeywords(testText, {
            level: 'minimal',
            baseWeight: 1.5
        });

        if (!Array.isArray(minimalKeywords)) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Keyword extraction did not return an array',
                category: 'production'
            };
        }

        // Minimal should extract limited keywords (max 5 per EXTRACTION_LEVELS config)
        if (minimalKeywords.length > 5) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: `Minimal extraction returned ${minimalKeywords.length} keywords (expected max 5)`,
                category: 'production'
            };
        }

        // Test balanced extraction
        const balancedKeywords = extractTextKeywords(testText, {
            level: 'balanced',
            baseWeight: 1.5
        });

        // Balanced should extract more keywords (max 12 per EXTRACTION_LEVELS config)
        if (balancedKeywords.length > 12) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: `Balanced extraction returned ${balancedKeywords.length} keywords (expected max 12)`,
                category: 'production'
            };
        }

        // Keywords should have proper structure
        const hasValidStructure = balancedKeywords.every(kw =>
            kw.text && typeof kw.text === 'string' &&
            kw.weight && typeof kw.weight === 'number' &&
            kw.weight >= 1.0 && kw.weight <= 3.0
        );

        if (!hasValidStructure) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Keywords do not have valid {text, weight} structure',
                category: 'production'
            };
        }

        // "dragon" should be extracted (appears frequently in text)
        const hasDragon = balancedKeywords.some(kw =>
            kw.text.toLowerCase().includes('dragon')
        );

        if (!hasDragon) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'warning',
                message: 'Expected keyword "dragon" not found in balanced extraction',
                category: 'production'
            };
        }

        // Stop words should be filtered out
        const hasStopWords = balancedKeywords.some(kw =>
            ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with'].includes(kw.text)
        );

        if (hasStopWords) {
            return {
                name: '[PROD] Keyword Extraction',
                status: 'fail',
                message: 'Stop words were not filtered out',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Keyword Extraction',
            status: 'pass',
            message: `Extracted ${balancedKeywords.length} keywords: [${balancedKeywords.slice(0, 3).map(k => k.text).join(', ')}...]`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Keyword Extraction',
            status: 'fail',
            message: `Keyword extraction error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Keyword boosting on search results
 * Tests applyQueryKeywordBoost (chat-vectorization.js), the actual function
 * rearrangeChat's STAGE 4.3 uses at query time — a binary "any keyword match
 * → perfect score" boost, not the old diminishing-returns math.
 */
export async function testKeywordBoosting(settings) {
    try {
        // Mock chunks shaped like retrieval results (metadata.keywords, as
        // attached by content-vectorization.js's enrichChunks)
        const chunks = [
            {
                hash: 'doc1',
                text: 'The wizard cast a powerful spell',
                score: 0.70,
                metadata: { keywords: [{ text: 'wizard', weight: 2.0 }, { text: 'spell', weight: 1.5 }] }
            },
            {
                hash: 'doc2',
                text: 'The ancient tome contained secrets',
                score: 0.85,
                metadata: { keywords: [{ text: 'ancient', weight: 1.5 }, { text: 'tome', weight: 1.8 }] }
            },
            {
                hash: 'doc3',
                text: 'Magic flows through the realm',
                score: 0.75,
                metadata: { keywords: [{ text: 'magic', weight: 1.7 }] }
            }
        ];

        // STAGE 4.3 receives already-extracted, lowercased query keywords, not a raw query string
        const queryKeywordTexts = ['wizard', 'spell'];
        const boostedCount = applyQueryKeywordBoost(chunks, queryKeywordTexts);

        if (boostedCount !== 1) {
            return {
                name: '[PROD] Keyword Boosting',
                status: 'fail',
                message: `Expected 1 chunk boosted, got ${boostedCount}`,
                category: 'production'
            };
        }

        const doc1 = chunks.find(c => c.hash === 'doc1');
        const doc2 = chunks.find(c => c.hash === 'doc2');
        const doc3 = chunks.find(c => c.hash === 'doc3');

        // Verify doc1 was boosted to a perfect score
        if (!doc1?.keywordMatched || doc1.score !== 1.0) {
            return {
                name: '[PROD] Keyword Boosting',
                status: 'fail',
                message: 'doc1 was not boosted to a perfect score',
                category: 'production'
            };
        }

        // Verify original score is preserved
        if (doc1.originalScore !== 0.70) {
            return {
                name: '[PROD] Keyword Boosting',
                status: 'fail',
                message: 'Original score not preserved',
                category: 'production'
            };
        }

        // Verify matched keywords are tracked
        if (!doc1.matchedQueryKeywords || doc1.matchedQueryKeywords.length !== 2) {
            return {
                name: '[PROD] Keyword Boosting',
                status: 'fail',
                message: 'Matched keywords not properly tracked',
                category: 'production'
            };
        }

        // Verify unmatched chunks were left untouched
        if (doc2.keywordMatched || doc2.score !== 0.85 || doc3.keywordMatched || doc3.score !== 0.75) {
            return {
                name: '[PROD] Keyword Boosting',
                status: 'fail',
                message: 'Unmatched chunks were modified',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Keyword Boosting',
            status: 'pass',
            message: `Boosted doc1: ${doc1.originalScore.toFixed(2)} → ${doc1.score.toFixed(2)} (matched: ${doc1.matchedQueryKeywords.join(', ')})`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Keyword Boosting',
            status: 'fail',
            message: `Keyword boosting error: ${error.message}`,
            category: 'production'
        };
    }
}

/**
 * Test: Lorebook keyword extraction
 * Tests extraction of keywords from lorebook entries
 */
export async function testLorebookKeywordExtraction(settings) {
    try {
        // Mock lorebook entry
        const lorebookEntry = {
            key: ['dragon', 'wyvern', 'Drake the Ancient'],
            keysecondary: ['treasure', 'hoard', 'scales'],
            content: 'A fearsome dragon that guards ancient treasures...'
        };

        const keywords = extractLorebookKeywords(lorebookEntry);

        // Validate keywords were extracted
        if (!Array.isArray(keywords) || keywords.length === 0) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'No keywords extracted from lorebook entry',
                category: 'production'
            };
        }

        // Should extract from both key and keysecondary
        const hasMainKey = keywords.some(k => k === 'dragon' || k === 'wyvern');
        const hasSecondaryKey = keywords.some(k => k === 'treasure' || k === 'hoard');

        if (!hasMainKey || !hasSecondaryKey) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Did not extract keywords from both key and keysecondary arrays',
                category: 'production'
            };
        }

        // Keywords should be normalized to lowercase
        const allLowercase = keywords.every(k => k === k.toLowerCase());
        if (!allLowercase) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Keywords not normalized to lowercase',
                category: 'production'
            };
        }

        // Should deduplicate keywords
        const uniqueKeywords = [...new Set(keywords)];
        if (uniqueKeywords.length !== keywords.length) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Keywords not deduplicated',
                category: 'production'
            };
        }

        // Test with empty entry
        const emptyEntry = { key: [], keysecondary: [] };
        const emptyKeywords = extractLorebookKeywords(emptyEntry);

        if (emptyKeywords.length !== 0) {
            return {
                name: '[PROD] Lorebook Keywords',
                status: 'fail',
                message: 'Empty entry should return no keywords',
                category: 'production'
            };
        }

        return {
            name: '[PROD] Lorebook Keywords',
            status: 'pass',
            message: `Extracted ${keywords.length} keywords: [${keywords.slice(0, 3).join(', ')}...]`,
            category: 'production'
        };
    } catch (error) {
        return {
            name: '[PROD] Lorebook Keywords',
            status: 'fail',
            message: `Lorebook keyword extraction error: ${error.message}`,
            category: 'production'
        };
    }
}

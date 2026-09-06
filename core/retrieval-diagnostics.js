/** UI-independent retrieval explanations shared by selection and presentation. */

export function createDebugData() {
    return {
        query: '',
        timestamp: Date.now(),
        collectionId: null,
        // Which pipeline produced this entry — 'chunkbase' (chat-vectorization.js:
        // ChunkBase documents/lorebooks/URLs + EventBase) or 'lorebook-wi'
        // (world-info-integration.js: semantic Lorebook World Info). Both write
        // into this same shared history; callers that want to distinguish them
        // read this field rather than guessing from shape.
        source: 'chunkbase',
        settings: {},
        stages: {
            initial: [],
            afterThreshold: [],
            afterConditions: [],
            injected: []
        },
        // Detailed trace log - every operation recorded
        trace: [],
        // Per-chunk tracking - what happened to each chunk
        chunkFates: {},
        stats: {
            totalInCollection: 0,
            retrievedFromVector: 0,
            passedThreshold: 0,
            afterConditions: 0,
            actuallyInjected: 0,
            skippedDuplicates: 0,
            tokensBudget: 0,
            tokensUsed: 0
        }
    };
}

export function addTrace(debugData, stage, action, details = {}) {
    if (!debugData.trace) debugData.trace = [];
    debugData.trace.push({
        time: Date.now(),
        stage,
        action,
        ...details
    });
}

export function recordChunkFate(debugData, hash, stage, fate, reason = null, data = {}) {
    if (!debugData.chunkFates) debugData.chunkFates = {};
    if (!debugData.chunkFates[hash]) {
        debugData.chunkFates[hash] = {
            hash,
            stages: [],
            finalFate: null,
            finalReason: null
        };
    }

    debugData.chunkFates[hash].stages.push({
        stage,
        fate,
        reason,
        ...data
    });

    // Update final fate if dropped
    if (fate === 'dropped') {
        debugData.chunkFates[hash].finalFate = 'dropped';
        debugData.chunkFates[hash].finalReason = reason;
        debugData.chunkFates[hash].droppedAt = stage;
    } else if (fate === 'injected') {
        debugData.chunkFates[hash].finalFate = 'injected';
    }
}

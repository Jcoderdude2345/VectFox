import { addTrace } from './retrieval-diagnostics.js';

export function applyQueryKeywordBoost(chunks, queryKeywordTexts, debugData = null, getChunkMetadata = () => null) {
    if (!queryKeywordTexts?.length || !chunks?.length) return 0;

    let keywordMatchCount = 0;
    for (const chunk of chunks) {
        // Get chunk keywords — prefer vectra/qdrant metadata (plugin path),
        // fall back to extension_settings (saved during insert for no-plugin users).
        const rawKeywords = chunk.metadata?.keywords?.length > 0
            ? chunk.metadata.keywords
            : (getChunkMetadata(String(chunk.hash))?.keywords || []);
        const chunkKeywords = rawKeywords
            .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
            .filter(Boolean);

        const matchedKeywords = queryKeywordTexts.filter(qk => chunkKeywords.includes(qk));

        if (matchedKeywords.length > 0) {
            const oldScore = chunk.score;
            chunk.keywordMatched = true;
            chunk.matchedQueryKeywords = matchedKeywords;
            chunk.score = 1.0; // 100% perfect match
            chunk.originalScore = oldScore;
            keywordMatchCount++;

            if (debugData) {
                addTrace(debugData, 'keyword_boost', `Chunk boosted by ${matchedKeywords.length} keyword(s)`, {
                    hash: chunk.hash,
                    matchedKeywords,
                    newScore: 1.0,
                    oldScore
                });
            }
        }
    }

    if (debugData && keywordMatchCount > 0) {
        debugData.stages.afterKeywordBoost = [...chunks];
        debugData.stats.keywordBoosted = keywordMatchCount;
        addTrace(debugData, 'keyword_boost', `Boosted ${keywordMatchCount} chunks with keyword matches`, {
            totalChunks: chunks.length,
            boostedCount: keywordMatchCount
        });
    }

    return keywordMatchCount;
}

/** Existing fusion algorithms; score scales and provenance are unchanged. */
export const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion(resultLists, k = DEFAULT_RRF_K) {
    const fusedScores = new Map();
    const listNames = ['vector', 'text'];

    resultLists.forEach((results, listIdx) => {
        if (!results || !Array.isArray(results)) return;

        results.forEach((result, rank) => {
            const docId = result.hash;
            if (docId === undefined || docId === null) return;

            if (!fusedScores.has(docId)) {
                fusedScores.set(docId, {
                    result,
                    rrfScore: 0,
                    rawRrfScore: 0,
                    ranks: {},
                    vectorScore: 0,
                    textScore: 0
                });
            }

            // RRF contribution: 1 / (k + rank)
            // rank is 0-indexed, so add 1 for 1-indexed ranking
            const rrfContribution = 1 / (k + rank + 1);
            const entry = fusedScores.get(docId);
            entry.rawRrfScore += rrfContribution;
            entry.ranks[listNames[listIdx]] = rank + 1;

            // Store individual scores for debugging
            if (listIdx === 0) {
                entry.vectorScore = result.score || 0;
            } else {
                entry.textScore = result.bm25Score || result.score || 0;
            }
        });
    });

    // Convert to array and sort by raw RRF score
    const sortedResults = Array.from(fusedScores.values())
        .sort((a, b) => b.rawRrfScore - a.rawRrfScore);

    // RRF determines ORDER, but display scores should reflect actual similarity
    // This ensures chunks with high semantic match show high %, while chunks that
    // are just highly ranked but don't match well show appropriately lower %
    if (sortedResults.length > 0) {
        const maxRrfScore = sortedResults[0].rawRrfScore;

        // BM25 scores are unbounded (typically 0 to 10+)
        // Use saturation function to normalize: score / (score + k)
        // This gives intuitive 0-1 values: 0→0%, k→50%, 2k→67%, etc.
        const BM25_SATURATION_K = 3.0; // Score of 3 = 50%, score of 6 = 67%, etc.

        for (const entry of sortedResults) {
            // Calculate RRF rank factor (1.0 for top, decreasing for lower)
            const rrfRankFactor = maxRrfScore > 0 ? entry.rawRrfScore / maxRrfScore : 0;

            // vectorScore: cosine similarity (already 0-1)
            const vectorScore = entry.vectorScore || 0;

            // Normalize BM25 using saturation function (independent of batch)
            const rawBM25 = entry.textScore || 0;
            const normalizedTextScore = rawBM25 / (rawBM25 + BM25_SATURATION_K);

            // Update textScore for display consistency
            entry.textScore = normalizedTextScore;

            const hasVector = vectorScore > 0.01;
            const hasText = normalizedTextScore > 0.01;

            if (hasVector && hasText) {
                // Both signals present - weighted average
                const combinedScore = (vectorScore * 0.55 + normalizedTextScore * 0.45);
                // Small boost (up to 8%) for having both signals
                const dualSignalBonus = 1.0 + (Math.min(vectorScore, normalizedTextScore) * 0.08);
                entry.rrfScore = Math.min(1.0, combinedScore * dualSignalBonus * (0.95 + 0.05 * rrfRankFactor));
            } else if (hasVector) {
                // Vector-only: penalize since no keyword overlap suggests lower relevance
                entry.rrfScore = vectorScore * 0.55 * (0.9 + 0.1 * rrfRankFactor);
            } else if (hasText) {
                // Text-only: decent relevance but missing semantic similarity
                entry.rrfScore = normalizedTextScore * 0.6 * (0.9 + 0.1 * rrfRankFactor);
            } else {
                // Fallback: pure RRF rank - very low confidence
                entry.rrfScore = rrfRankFactor * 0.25;
            }

            // Ensure score never exceeds 1.0
            entry.rrfScore = Math.min(1.0, entry.rrfScore);
        }

        // Re-sort by final score (may differ slightly from raw RRF order)
        sortedResults.sort((a, b) => b.rrfScore - a.rrfScore);
    }

    return sortedResults;
}

export function weightedCombination(vectorResults, textResults, alpha = 0.5, beta = 0.5) {
    // Normalize scores to [0, 1]
    const normalizedVector = normalizeScores(vectorResults, 'score');
    const normalizedText = normalizeScores(textResults, 'bm25Score');

    const combined = new Map();

    // Add all vector results
    for (const r of normalizedVector) {
        if (r.hash === undefined || r.hash === null) continue;

        combined.set(r.hash, {
            result: r,
            hash: r.hash,
            text: r.text,
            metadata: r.metadata,
            vectorScore: r.normalizedScore,
            textScore: 0,
            combinedScore: alpha * r.normalizedScore
        });
    }

    // Merge text results
    for (const r of normalizedText) {
        if (r.hash === undefined || r.hash === null) continue;

        if (combined.has(r.hash)) {
            const entry = combined.get(r.hash);
            entry.textScore = r.normalizedScore;
            entry.combinedScore += beta * r.normalizedScore;
        } else {
            combined.set(r.hash, {
                result: r,
                hash: r.hash,
                text: r.text,
                metadata: r.metadata,
                vectorScore: 0,
                textScore: r.normalizedScore,
                combinedScore: beta * r.normalizedScore
            });
        }
    }

    // Sort by combined score (descending)
    return Array.from(combined.values())
        .sort((a, b) => b.combinedScore - a.combinedScore);
}

function normalizeScores(results, scoreField = 'score') {
    if (!results || results.length === 0) return [];

    const scores = results.map(r => r[scoreField] || 0);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore || 1; // Avoid division by zero

    return results.map(r => ({
        ...r,
        normalizedScore: ((r[scoreField] || 0) - minScore) / range
    }));
}

/** Compatibility entry points; search execution is owned by collection query execution. */
import { bindCollectionQueries } from './collection-query-bindings.js';
export { DEFAULT_RRF_K, reciprocalRankFusion, weightedCombination } from './query-score-fusion.js';

const collectionQueries = bindCollectionQueries();
export async function hybridSearch(collectionId, searchText, topK, settings, options = {}) {
    return collectionQueries.hybridSearch(collectionId, searchText, topK, settings, options);
}

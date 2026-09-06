# VectFox

VectFox organizes vectorized content into collections for retrieval.

## Language

**Collection removal**:
Deletion of a collection's vectors and its associated local records and extraction-cache links.
_Avoid_: Purge (which refers only to vector deletion)

**Partial removal**:
A collection removal in which some deletion or cleanup succeeded but the whole removal is not complete.
_Avoid_: Successful deletion

**Wiki acquisition**:
Obtaining wiki titles or page content, including whether the content is saved in the Wiki Library or available only for the current session.

**Auto-Reformat run**:
One attempt to turn a particular source into a reviewed, accepted set of entries. An unfinished or obsolete run is distinct from a previously accepted result.

**Chunk retrieval selection**:
The choice of non-chat chunks to include as generation context, based on collection eligibility, relevance, activation conditions, chunk relationships, and duplicate suppression.

**Collection query execution**:
A search of specified vectorized collections that produces scored matches. Those matches are candidates for a caller's selection rules, rather than a decision about which chunks enter a prompt.

**Related-chunk expansion**:
The adjustment of retrieved context through chunk relationships: replacing summaries with parent content, boosting soft-linked chunks, and including forced-link targets.

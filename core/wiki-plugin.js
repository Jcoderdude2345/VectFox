export async function isWikiPluginAvailable(wikiType, { signal } = {}) {
    const fandom = wikiType === 'fandom';
    try {
        const probe = await fetch(fandom ? '/api/plugins/fandom/probe' : '/api/plugins/fandom/probe-mediawiki', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        });
        signal?.throwIfAborted();
        return probe.ok;
    } catch (error) {
        signal?.throwIfAborted();
        return false;
    }
}

/** Whole-response adapter for the optional Fandom Scraper plugin. */
export async function fetchPluginWiki({ wikiType, url, filter, signal }) {
    const fandom = wikiType === 'fandom';
    if (!await isWikiPluginAvailable(wikiType, { signal })) throw new Error('Wiki scraper plugin unavailable');
    signal?.throwIfAborted();
    let fandomId = url;
    try { fandomId = new URL(url).hostname.split('.')[0] || url; } catch { /* bare wiki ID */ }
    const response = await fetch(fandom ? '/api/plugins/fandom/scrape' : '/api/plugins/fandom/scrape-mediawiki', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify(fandom ? { fandom: fandomId, filter } : { url, filter }),
    });
    if (!response.ok) throw new Error(await response.text());
    const pages = await response.json();
    signal?.throwIfAborted();
    return pages;
}

export function wikiSourceName(url, wikiType) {
    try {
        if (wikiType === 'e621') return 'e621-wiki';
        const parsed = new URL(url);
        if (wikiType === 'fandom') return parsed.hostname.split('.')[0] || url;
        return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    } catch { return String(url).substring(0, 50); }
}

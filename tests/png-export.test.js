/**
 * Characterization tests for core/png-export.js
 *
 * The module smuggles a VectFox collection export into a PNG's zTXt chunk.
 * These tests build real PNG byte streams (signature + IHDR + IEND), then
 * exercise the round trip, chunk parsing, CRC/offset arithmetic, and the
 * tEXt/base64 fallback path. The canvas-dependent helpers (createDefaultPNG,
 * convertToPNG, downloadPNG) need a DOM and are covered only at the
 * "throws without a document" level.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
}));

import {
    embedDataInPNG,
    extractDataFromPNG,
    readPNGFile,
    isVectFoxPNG,
    createDefaultPNG,
    downloadPNG,
} from '../core/png-export.js';

// ---------------------------------------------------------------------------
// Minimal PNG construction helpers (mirrors the module's own chunk format)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function crc32(bytes) {
    let table = crc32._t;
    if (!table) {
        table = crc32._t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c;
        }
    }
    let crc = 0xFFFFFFFF;
    for (const b of bytes) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data = new Uint8Array(0)) {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crcData = new Uint8Array(4 + data.length);
    crcData.set(typeBytes, 0);
    crcData.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcData), false);
    return out;
}

function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/** A structurally valid 1x1-ish PNG: signature + IHDR + IEND. */
function makeBasePNG(extraChunks = []) {
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 1, false); // width
    new DataView(ihdr.buffer).setUint32(4, 1, false); // height
    ihdr[8] = 8; ihdr[9] = 6; // bit depth, RGBA
    return concat(PNG_SIGNATURE, chunk('IHDR', ihdr), ...extraChunks, chunk('IEND'));
}

function textChunk(keyword, text) {
    const kw = new TextEncoder().encode(keyword);
    const body = new TextEncoder().encode(text);
    const data = new Uint8Array(kw.length + 1 + body.length);
    data.set(kw, 0);
    data[kw.length] = 0;
    data.set(body, kw.length + 1);
    return chunk('tEXt', data);
}

const sampleExport = {
    generator: 'VectFox',
    version: '4.0.0',
    type: 'single',
    collection: { name: 'Vaelor Lore', id: 'col_1' },
    chunks: [
        { text: 'Vaelor is the capital of the Sundered Reach.', metadata: { chunkIndex: 0 } },
        { text: 'The Iron Company holds the eastern passes.', metadata: { chunkIndex: 1 } },
    ],
};

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('embed / extract round trip', () => {
    it('replaces legacy payloads while preserving other metadata and image bytes', async () => {
        const character = textChunk('chara', 'keep character metadata');
        const pixels = chunk('IDAT', new Uint8Array([1, 2, 3, 4]));
        const base = makeBasePNG([
            textChunk('VectFox', JSON.stringify({ generator: 'VectFox', gen: 0 })),
            textChunk('VectFox', JSON.stringify({ generator: 'VectFox', gen: -1 })),
            character,
            pixels,
        ]);
        const first = await embedDataInPNG({ generator: 'VectFox', gen: 1 }, base);
        // Honor a Uint8Array view's offset, as well as removing all prior payloads.
        const padded = concat(new Uint8Array([99]), first, new Uint8Array([99]));
        const second = await embedDataInPNG({ generator: 'VectFox', gen: 2 }, padded.subarray(1, padded.length - 1));
        expect(await extractDataFromPNG(second)).toEqual({ generator: 'VectFox', gen: 2 });
        const chunks = [];
        for (let offset = 8; offset < second.length;) {
            const length = new DataView(second.buffer, second.byteOffset + offset).getUint32(0, false);
            chunks.push(second.slice(offset, offset + length + 12));
            offset += length + 12;
        }
        expect(chunks).toContainEqual(character);
        expect(chunks).toContainEqual(pixels);
        expect(chunks.filter(bytes => new TextDecoder().decode(bytes.slice(4, 8)) === 'zTXt')).toHaveLength(1);
        expect(chunks.filter(bytes => new TextDecoder().decode(bytes.slice(8)).startsWith('VectFox\0'))).toHaveLength(1);
    });

    it('survives a full round trip with the data intact', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(await extractDataFromPNG(png)).toEqual(sampleExport);
    });

    it('keeps the PNG signature and the IEND terminator', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(Array.from(png.slice(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
        expect(new TextDecoder().decode(png.slice(-8, -4))).toBe('IEND');
    });

    it('inserts the payload BEFORE IEND, leaving the original chunks untouched', async () => {
        const base = makeBasePNG();
        const png = await embedDataInPNG(sampleExport, base);
        // Everything up to the original IEND offset is byte-identical.
        const iendOffset = base.length - 12;
        expect(Array.from(png.slice(0, iendOffset))).toEqual(Array.from(base.slice(0, iendOffset)));
        expect(png.length).toBeGreaterThan(base.length);
    });

    it('writes a compressed zTXt chunk, not raw JSON', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        const asText = new TextDecoder('latin1').decode(png);
        expect(asText).toContain('zTXt');
        expect(asText).toContain('VectFox');
        // The plaintext must not survive verbatim — it was deflated.
        expect(asText).not.toContain('Sundered Reach');
    });

    it('compresses repetitive payloads well below their JSON size', async () => {
        const big = { generator: 'VectFox', chunks: Array.from({ length: 300 }, () => ({ text: 'repeat '.repeat(20) })) };
        const png = await embedDataInPNG(big, makeBasePNG());
        expect(png.length).toBeLessThan(JSON.stringify(big).length / 5);
        expect(await extractDataFromPNG(png)).toEqual(big);
    });

    it('preserves unicode payloads exactly', async () => {
        const data = { generator: 'VectFox', collection: { name: '星月绿洲 · ユキ · 유키' }, note: 'emoji 🦊🐇' };
        const png = await embedDataInPNG(data, makeBasePNG());
        expect(await extractDataFromPNG(png)).toEqual(data);
    });

    it('handles an empty object and deeply nested structures', async () => {
        expect(await extractDataFromPNG(await embedDataInPNG({}, makeBasePNG()))).toEqual({});
        const nested = { a: { b: { c: { d: [1, 2, { e: null }] } } } };
        expect(await extractDataFromPNG(await embedDataInPNG(nested, makeBasePNG()))).toEqual(nested);
    });

    it('drops undefined values and converts them inside arrays to null (JSON semantics)', async () => {
        const png = await embedDataInPNG({ keep: 1, gone: undefined, arr: [1, undefined] }, makeBasePNG());
        expect(await extractDataFromPNG(png)).toEqual({ keep: 1, arr: [1, null] });
    });

    it('replaces the prior VectFox payload on repeated export', async () => {
        const first = await embedDataInPNG({ generator: 'VectFox', gen: 1 }, makeBasePNG());
        const second = await embedDataInPNG({ generator: 'VectFox', gen: 2 }, first);
        expect(await extractDataFromPNG(second)).toEqual({ generator: 'VectFox', gen: 2 });
        const zCount = new TextDecoder('latin1').decode(second).split('zTXt').length - 1;
        expect(zCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// extractDataFromPNG
// ---------------------------------------------------------------------------

describe('extractDataFromPNG', () => {
    it('returns null for a PNG with no text chunks', async () => {
        expect(await extractDataFromPNG(makeBasePNG())).toBeNull();
    });

    it('ignores text chunks whose keyword is not "VectFox"', async () => {
        const png = makeBasePNG([textChunk('chara', btoa(JSON.stringify({ name: 'someone' })))]);
        expect(await extractDataFromPNG(png)).toBeNull();
    });

    it('is case-sensitive about the keyword', async () => {
        const png = makeBasePNG([textChunk('vectfox', btoa('{"a":1}'))]);
        expect(await extractDataFromPNG(png)).toBeNull();
    });

    it('reads the base64 tEXt fallback format', async () => {
        const payload = { generator: 'VectFox', from: 'tEXt' };
        const png = makeBasePNG([textChunk('VectFox', btoa(JSON.stringify(payload)))]);
        expect(await extractDataFromPNG(png)).toEqual(payload);
    });

    it('reads a plain (non-base64) tEXt payload too', async () => {
        // atob() rejects the JSON's braces, so the catch branch returns it raw.
        const png = makeBasePNG([textChunk('VectFox', '{"generator":"VectFox","raw":true}')]);
        expect(await extractDataFromPNG(png)).toEqual({ generator: 'VectFox', raw: true });
    });

    it('skips a malformed VectFox chunk and keeps scanning for a good one', async () => {
        const good = { generator: 'VectFox', ok: true };
        const png = makeBasePNG([
            textChunk('VectFox', 'not json at all'),
            textChunk('VectFox', btoa(JSON.stringify(good))),
        ]);
        expect(await extractDataFromPNG(png)).toEqual(good);
    });

    it('returns null rather than throwing when every candidate chunk is malformed', async () => {
        const png = makeBasePNG([textChunk('VectFox', 'garbage')]);
        expect(await extractDataFromPNG(png)).toBeNull();
    });

    it('rejects a file with a bad PNG signature', async () => {
        const notPng = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
        await expect(extractDataFromPNG(notPng)).rejects.toThrow('Invalid PNG signature');
    });

    it('rejects an empty buffer as a bad signature', async () => {
        await expect(extractDataFromPNG(new Uint8Array(0))).rejects.toThrow('Invalid PNG signature');
    });

    it('stops scanning at IEND, ignoring anything appended after it', async () => {
        const png = concat(makeBasePNG(), textChunk('VectFox', btoa('{"trailing":true}')));
        expect(await extractDataFromPNG(png)).toBeNull();
    });

    it('does not verify chunk CRCs — a corrupt CRC still parses', async () => {
        const png = makeBasePNG([textChunk('VectFox', btoa('{"generator":"VectFox"}'))]);
        png[png.length - 16] ^= 0xFF; // scribble inside the tEXt CRC region
        await expect(extractDataFromPNG(png)).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// embedDataInPNG error paths
// ---------------------------------------------------------------------------

describe('embedDataInPNG error paths', () => {
    it('throws on a base image with an invalid signature', async () => {
        await expect(embedDataInPNG(sampleExport, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))
            .rejects.toThrow('Invalid PNG signature');
    });

    it('throws when the base PNG has no IEND chunk', async () => {
        const headless = concat(PNG_SIGNATURE, chunk('IHDR', new Uint8Array(13)));
        await expect(embedDataInPNG(sampleExport, headless)).rejects.toThrow('PNG missing IEND chunk');
    });

    it('falls back to createDefaultPNG (and therefore fails without a DOM) when no base image is given', async () => {
        await expect(embedDataInPNG(sampleExport, null)).rejects.toThrow();
    });

    it('throws on a circular payload — JSON.stringify is not guarded', async () => {
        const circular = { generator: 'VectFox' };
        circular.self = circular;
        await expect(embedDataInPNG(circular, makeBasePNG())).rejects.toThrow(TypeError);
    });
});

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

describe('readPNGFile', () => {
    it('turns a File/Blob-like object into a Uint8Array', async () => {
        const bytes = makeBasePNG();
        const fileLike = { arrayBuffer: async () => bytes.buffer.slice(0) };
        const out = await readPNGFile(fileLike);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out)).toEqual(Array.from(bytes));
    });
});

describe('isVectFoxPNG', () => {
    const fileFrom = (bytes, { name = 'export.png', type = 'image/png' } = {}) => ({
        name, type, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    });

    it('accepts a PNG carrying VectFox data', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(await isVectFoxPNG(fileFrom(png))).toBe(true);
    });

    it('accepts by .png filename even when the MIME type is wrong', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(await isVectFoxPNG(fileFrom(png, { type: 'application/octet-stream' }))).toBe(true);
    });

    it('is case-insensitive about the .PNG extension', async () => {
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(await isVectFoxPNG(fileFrom(png, { name: 'EXPORT.PNG', type: '' }))).toBe(true);
    });

    it('rejects non-PNG files without reading them', async () => {
        const file = { name: 'notes.txt', type: 'text/plain', arrayBuffer: vi.fn() };
        expect(await isVectFoxPNG(file)).toBe(false);
        expect(file.arrayBuffer).not.toHaveBeenCalled();
    });

    it('rejects a plain PNG with no embedded data', async () => {
        expect(await isVectFoxPNG(fileFrom(makeBasePNG()))).toBe(false);
    });

    it('returns false (never throws) for corrupt bytes', async () => {
        expect(await isVectFoxPNG(fileFrom(new Uint8Array([1, 2, 3])))).toBe(false);
    });

    it('returns true for a versioned legacy payload', async () => {
        const png = makeBasePNG([textChunk('VectFox', btoa('{"version":"1.0","generator":"SomethingElse"}'))]);
        expect(await isVectFoxPNG(fileFrom(png))).toBe(true);
    });

    it('returns false for a payload without generator or version', async () => {
        const png = makeBasePNG([textChunk('VectFox', btoa('{"chunks":[]}'))]);
        expect(await isVectFoxPNG(fileFrom(png))).toBe(false);
    });

    it('does return a real boolean on the paths that short-circuit early', async () => {
        expect(await isVectFoxPNG({ name: 'a.txt', type: 'text/plain', arrayBuffer: vi.fn() })).toBe(false);
        const png = await embedDataInPNG(sampleExport, makeBasePNG());
        expect(await isVectFoxPNG(fileFrom(png))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Canvas-dependent helpers
// ---------------------------------------------------------------------------

describe('canvas-dependent helpers (no DOM in this environment)', () => {
    it('createDefaultPNG throws without a document', async () => {
        await expect(createDefaultPNG(64, 64, 'x')).rejects.toThrow();
    });

    it('downloadPNG throws without a document', () => {
        expect(() => downloadPNG(makeBasePNG(), 'export')).toThrow();
    });
});

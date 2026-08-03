/**
 * Characterization tests for core/emotion-classifier.js
 *
 * This is VectFox's Cotton-Tales integration surface: settings mapping,
 * a FIFO-ish result cache, a thin wrapper over ST's /api/extra/classify, and a
 * heuristic "is this model actually an emotion classifier?" prober. These tests
 * pin the confidence thresholds, the cache-key truncation, and the swallow-all
 * error contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

// One shared mutable settings object — the module reads extension_settings
// live on every call, so tests mutate this in place. vi.hoisted keeps it
// available inside the hoisted vi.mock factory.
const { extension_settings } = vi.hoisted(() => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../extensions.js', () => ({ extension_settings }));

import {
    classifyEmotion,
    testClassifierModel,
    getClassifierSettings,
    updateClassifierSetting,
    clearClassifierCache,
    isCottonTalesInstalled,
    isCottonTalesUsingVectFox,
    CottonTalesAPI,
    RECOMMENDED_CLASSIFIER_MODELS,
    DEFAULT_CLASSIFIER_SETTINGS,
} from '../core/emotion-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const classifyResponse = (...labels) => ({
    ok: true,
    status: 200,
    json: async () => ({ classification: labels.map(([label, score]) => ({ label, score })) }),
});

function enableClassifier(overrides = {}) {
    extension_settings.vectfox = {
        emotion_classifier_enabled: true,
        emotion_classifier_model: 'SamLowe/roberta-base-go_emotions',
        ...overrides,
    };
}

beforeEach(() => {
    for (const k of Object.keys(extension_settings)) delete extension_settings[k];
    extension_settings.vectfox = {};
    clearClassifierCache();
    globalThis.fetch = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Cotton-Tales detection
// ---------------------------------------------------------------------------

describe('Cotton-Tales detection', () => {
    it('reports installed only when a cotton_tales settings block exists', () => {
        expect(isCottonTalesInstalled()).toBe(false);
        extension_settings.cotton_tales = {};
        // An EMPTY object is truthy, so a bare presence check counts as installed.
        expect(isCottonTalesInstalled()).toBe(true);
    });

    it('detects the VectFox expression API by its magic number 4', () => {
        expect(isCottonTalesUsingVectFox()).toBe(false);
        extension_settings.cotton_tales = { expressionApi: 3 };
        expect(isCottonTalesUsingVectFox()).toBe(false);
        extension_settings.cotton_tales = { expressionApi: 4 };
        expect(isCottonTalesUsingVectFox()).toBe(true);
    });

    it('requires a strict number — the string "4" does not count', () => {
        extension_settings.cotton_tales = { expressionApi: '4' };
        expect(isCottonTalesUsingVectFox()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('getClassifierSettings', () => {
    it('returns the documented defaults when nothing is configured', () => {
        expect(getClassifierSettings()).toEqual({
            enabled: false,
            model: 'SamLowe/roberta-base-go_emotions',
            useEmbeddingSimilarity: false,
            customLabels: [],
        });
        expect(DEFAULT_CLASSIFIER_SETTINGS.enabled).toBe(false);
    });

    it('maps the flat emotion_* settings keys onto the friendly shape', () => {
        extension_settings.vectfox = {
            emotion_classifier_enabled: true,
            emotion_classifier_model: 'custom/model',
            emotion_use_similarity: true,
            emotion_custom_labels: ['happy', 'sad'],
        };
        expect(getClassifierSettings()).toEqual({
            enabled: true,
            model: 'custom/model',
            useEmbeddingSimilarity: true,
            customLabels: ['happy', 'sad'],
        });
    });

    it('preserves explicit falsy values via ?? (false and "" are kept)', () => {
        extension_settings.vectfox = { emotion_classifier_model: '', emotion_classifier_enabled: false };
        expect(getClassifierSettings().model).toBe('');
        expect(getClassifierSettings().enabled).toBe(false);
    });

    it('falls back to defaults when the vectfox block is missing entirely', () => {
        delete extension_settings.vectfox;
        expect(getClassifierSettings().model).toBe('SamLowe/roberta-base-go_emotions');
    });
});

describe('updateClassifierSetting', () => {
    it('writes friendly keys through to their emotion_* storage keys', () => {
        updateClassifierSetting('enabled', true);
        updateClassifierSetting('model', 'a/b');
        updateClassifierSetting('useEmbeddingSimilarity', true);
        updateClassifierSetting('customLabels', ['x']);
        expect(extension_settings.vectfox).toEqual({
            emotion_classifier_enabled: true,
            emotion_classifier_model: 'a/b',
            emotion_use_similarity: true,
            emotion_custom_labels: ['x'],
        });
    });

    it('writes unmapped keys through under their own name — no validation', () => {
        updateClassifierSetting('totally_made_up', 7);
        expect(extension_settings.vectfox.totally_made_up).toBe(7);
    });

    it('creates the vectfox settings block if absent', () => {
        delete extension_settings.vectfox;
        updateClassifierSetting('model', 'a/b');
        expect(extension_settings.vectfox.emotion_classifier_model).toBe('a/b');
    });

    it('flushes the result cache when the model changes', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion('hello');
        await classifyEmotion('hello');
        expect(globalThis.fetch).toHaveBeenCalledOnce();

        updateClassifierSetting('model', 'other/model');
        await classifyEmotion('hello');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT flush the cache for other setting changes', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion('hello');
        updateClassifierSetting('enabled', true);
        await classifyEmotion('hello');
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });
});

// ---------------------------------------------------------------------------
// classifyEmotion
// ---------------------------------------------------------------------------

describe('classifyEmotion', () => {
    it('returns null for empty or non-string input', async () => {
        enableClassifier();
        expect(await classifyEmotion('')).toBeNull();
        expect(await classifyEmotion(null)).toBeNull();
        expect(await classifyEmotion(42)).toBeNull();
        expect(await classifyEmotion({ text: 'x' })).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns null without a request when the classifier is disabled', async () => {
        expect(await classifyEmotion('I am happy')).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('POSTs to ST\'s local classify endpoint and returns the top label', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.92], ['excitement', 0.61]));

        const result = await classifyEmotion('I am so happy!');
        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toBe('/api/extra/classify');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            text: 'I am so happy!',
            model: 'SamLowe/roberta-base-go_emotions',
        });
        expect(result).toEqual({
            label: 'joy',
            score: 0.92,
            allLabels: [
                { label: 'joy', score: 0.92 },
                { label: 'excitement', score: 0.61 },
            ],
        });
    });

    it('lets options.model override the configured model for one call', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion('text', { model: 'override/model' });
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).model).toBe('override/model');
    });

    it('keys the cache on the model but NOT on options.model — an override poisons the cache', async () => {
        // BUG-SHAPED: cacheKey uses settings.model, so a one-off override is
        // stored under the default model's key and served back to later
        // default-model calls.
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['anger', 0.99]));
        await classifyEmotion('same text', { model: 'override/model' });

        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.5]));
        const second = await classifyEmotion('same text');
        expect(second.label).toBe('anger');
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it('keys the cache on only the first 100 characters of the text', async () => {
        // BUG-SHAPED: two long texts sharing a 100-char prefix collide.
        enableClassifier();
        const prefix = 'p'.repeat(100);
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion(`${prefix} first ending`);
        const second = await classifyEmotion(`${prefix} completely different ending`);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
        expect(second.label).toBe('joy');
    });

    it('caches per model, so switching models re-queries', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion('text');
        extension_settings.vectfox.emotion_classifier_model = 'other/model';
        await classifyEmotion('text');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('evicts the oldest entry once the cache reaches 100 items', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        for (let i = 0; i < 100; i++) await classifyEmotion(`text ${i}`);
        expect(globalThis.fetch).toHaveBeenCalledTimes(100);

        await classifyEmotion('text 101');           // evicts "text 0"
        expect(globalThis.fetch).toHaveBeenCalledTimes(101);
        await classifyEmotion('text 0');             // must re-query
        expect(globalThis.fetch).toHaveBeenCalledTimes(102);
        await classifyEmotion('text 5');             // still cached
        expect(globalThis.fetch).toHaveBeenCalledTimes(102);
    });

    it('clearClassifierCache() forces the next call back to the network', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        await classifyEmotion('text');
        clearClassifierCache();
        await classifyEmotion('text');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns null and caches NOTHING on a non-OK HTTP response', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        expect(await classifyEmotion('text')).toBeNull();
        expect(await classifyEmotion('text')).toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns null for an empty or missing classification array', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue(classifyResponse());
        expect(await classifyEmotion('a')).toBeNull();
        globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        expect(await classifyEmotion('b')).toBeNull();
    });

    it('swallows network and JSON errors, returning null', async () => {
        enableClassifier();
        globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await classifyEmotion('text')).toBeNull();

        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => { throw new SyntaxError('bad json'); },
        });
        expect(await classifyEmotion('other')).toBeNull();
    });

    it('does not validate that the top entry actually has a label', async () => {
        enableClassifier();
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ classification: [{ score: 0.5 }] }),
        });
        expect(await classifyEmotion('text')).toEqual({
            label: undefined,
            score: 0.5,
            allLabels: [{ score: 0.5 }],
        });
    });
});

// ---------------------------------------------------------------------------
// testClassifierModel
// ---------------------------------------------------------------------------

describe('testClassifierModel', () => {
    it('probes with three fixed texts regardless of settings', async () => {
        globalThis.fetch
            .mockResolvedValueOnce(classifyResponse(['joy', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['anger', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['sadness', 0.9]));

        await testClassifierModel('some/model');
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        const texts = globalThis.fetch.mock.calls.map(c => JSON.parse(c[1].body).text);
        expect(texts).toEqual([
            'I am so happy and excited!',
            'This makes me really angry and frustrated.',
            'I feel sad and disappointed.',
        ]);
        expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).model).toBe('some/model');
    });

    it('runs even when the classifier feature is disabled', async () => {
        globalThis.fetch.mockResolvedValue(classifyResponse(['joy', 0.9]));
        const out = await testClassifierModel('m');
        expect(out.confidence).not.toBe('error');
    });

    it('reports high confidence when all three probes match expected emotions', async () => {
        globalThis.fetch
            .mockResolvedValueOnce(classifyResponse(['joy', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['anger', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['sadness', 0.9]));

        expect(await testClassifierModel('m')).toEqual({
            isEmotionClassifier: true,
            sampleLabels: ['joy', 'anger', 'sadness'],
            confidence: 'high',
            matchRate: 1,
        });
    });

    it('lowercases labels and dedupes them into sampleLabels', async () => {
        globalThis.fetch.mockResolvedValue(classifyResponse(['JOY', 0.9]));
        const out = await testClassifierModel('m');
        expect(out.sampleLabels).toEqual(['joy']);
        expect(out.matchRate).toBeCloseTo(1 / 3, 5); // only the joy probe matched
        expect(out.confidence).toBe('medium');
    });

    it('drops to medium when only one of three probes matches', async () => {
        globalThis.fetch
            .mockResolvedValueOnce(classifyResponse(['joy', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['label_1', 0.9]))
            .mockResolvedValueOnce(classifyResponse(['label_2', 0.9]));
        const out = await testClassifierModel('m');
        expect(out.matchRate).toBeCloseTo(1 / 3, 5);
        expect(out.confidence).toBe('medium');
        expect(out.isEmotionClassifier).toBe(true);
    });

    it('reports low confidence — and isEmotionClassifier false — for non-emotion labels', async () => {
        globalThis.fetch.mockResolvedValue(classifyResponse(['POSITIVE', 0.9]));
        expect(await testClassifierModel('m')).toEqual({
            isEmotionClassifier: false,
            sampleLabels: ['positive'],
            confidence: 'low',
            matchRate: 0,
        });
    });

    it('reaches medium on emotion-shaped labels even with a zero match rate', async () => {
        // 'gratitude' contains the 'grat' keyword, so looksLikeEmotions is true.
        globalThis.fetch.mockResolvedValue(classifyResponse(['gratitude', 0.9]));
        const out = await testClassifierModel('m');
        expect(out.matchRate).toBe(0);
        expect(out.confidence).toBe('medium');
        expect(out.isEmotionClassifier).toBe(true);
    });

    it('matches expectations by substring in EITHER direction', async () => {
        // 'happiness' is not in the expected list, but expected 'happiness'…
        // rather: topLabel 'joyful' contains expected 'joy'.
        globalThis.fetch.mockResolvedValueOnce(classifyResponse(['joyful', 0.9]));
        globalThis.fetch.mockResolvedValue(classifyResponse(['zzz', 0.1]));
        const out = await testClassifierModel('m');
        expect(out.matchRate).toBeCloseTo(1 / 3, 5);
    });

    it('bails out on the FIRST HTTP failure and reports an error verdict', async () => {
        globalThis.fetch
            .mockResolvedValueOnce(classifyResponse(['joy', 0.9]))
            .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

        expect(await testClassifierModel('bad/model')).toEqual({
            isEmotionClassifier: false,
            sampleLabels: [],
            confidence: 'error',
            error: 'HTTP 404',
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(2); // third probe never runs
    });

    it('reports an error verdict carrying the thrown message on a network failure', async () => {
        globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await testClassifierModel('m')).toEqual({
            isEmotionClassifier: false,
            sampleLabels: [],
            confidence: 'error',
            error: 'Failed to fetch',
        });
    });

    it('returns NaN matchRate when every probe returns an empty classification', async () => {
        // BUG-SHAPED: `results` stays empty, so 0/0 = NaN. NaN fails both
        // threshold comparisons, landing on 'low'.
        globalThis.fetch.mockResolvedValue(classifyResponse());
        const out = await testClassifierModel('m');
        expect(Number.isNaN(out.matchRate)).toBe(true);
        expect(out.confidence).toBe('low');
        expect(out.isEmotionClassifier).toBe(false);
    });

    it('skips entries whose top result has no label, without throwing', async () => {
        globalThis.fetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ classification: [{ score: 0.5 }] }),
        });
        const out = await testClassifierModel('m');
        expect(out.sampleLabels).toEqual([]);
        expect(out.confidence).toBe('low');
    });
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe('exported surface', () => {
    it('ships three recommended models with their label lists', () => {
        expect(RECOMMENDED_CLASSIFIER_MODELS).toHaveLength(3);
        expect(RECOMMENDED_CLASSIFIER_MODELS.map(m => m.id)).toEqual([
            'SamLowe/roberta-base-go_emotions',
            'j-hartmann/emotion-english-distilroberta-base',
            'bhadresh-savani/distilbert-base-uncased-emotion',
        ]);
        expect(RECOMMENDED_CLASSIFIER_MODELS[0].labels).toHaveLength(28);
        expect(RECOMMENDED_CLASSIFIER_MODELS[1].labels).toHaveLength(7);
        expect(RECOMMENDED_CLASSIFIER_MODELS[2].labels).toHaveLength(6);
    });

    it('is mutable — RECOMMENDED_CLASSIFIER_MODELS is not frozen', () => {
        expect(Object.isFrozen(RECOMMENDED_CLASSIFIER_MODELS)).toBe(false);
    });

    it('exposes the Cotton-Tales bridge object with the documented members', () => {
        expect(Object.keys(CottonTalesAPI).sort()).toEqual([
            'RECOMMENDED_CLASSIFIER_MODELS',
            'classifyEmotion',
            'clearClassifierCache',
            'getClassifierSettings',
            'isCottonTalesInstalled',
            'testClassifierModel',
        ]);
        expect(CottonTalesAPI.classifyEmotion).toBe(classifyEmotion);
    });

    it('does NOT expose isCottonTalesUsingVectFox on the bridge, despite exporting it', () => {
        expect(CottonTalesAPI.isCottonTalesUsingVectFox).toBeUndefined();
        expect(typeof isCottonTalesUsingVectFox).toBe('function');
    });

    it('skips the window global when there is no window (Node/test env)', () => {
        expect(typeof globalThis.window === 'undefined'
            ? true
            : globalThis.window.VectFoxEmotionClassifier === CottonTalesAPI).toBe(true);
    });
});

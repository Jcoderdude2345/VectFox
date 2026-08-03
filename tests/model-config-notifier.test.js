/**
 * Characterization tests for core/model-config-notifier.js
 *
 * Shared UX for "the configured model is no longer valid". Three behaviors
 * matter: the error-shape predicate, the once-per-message sticky toast, and
 * the auto-sync pause that walks the EventBase collection registry. The
 * dynamic-import dependencies are stubbed so this stays a unit test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { findEventBaseCollectionIdsForChat, setCollectionAutoSync } = vi.hoisted(() => ({
    findEventBaseCollectionIdsForChat: vi.fn(() => []),
    setCollectionAutoSync: vi.fn(),
}));

vi.mock('../core/eventbase-store.js', () => ({ findEventBaseCollectionIdsForChat }));
vi.mock('../core/collection-metadata.js', () => ({ setCollectionAutoSync }));

import {
    isInvalidModelConfigError,
    notifyInvalidModel,
    resetInvalidModelNotifications,
    pauseAutoSyncForChat,
} from '../core/model-config-notifier.js';

// ---------------------------------------------------------------------------
// Test doubles for the browser globals the module touches
// ---------------------------------------------------------------------------

let toastrError;
let dispatched;

beforeEach(() => {
    resetInvalidModelNotifications();
    findEventBaseCollectionIdsForChat.mockReset().mockReturnValue([]);
    setCollectionAutoSync.mockReset();

    toastrError = vi.fn();
    globalThis.toastr = { error: toastrError };

    dispatched = [];
    globalThis.document = { dispatchEvent: (e) => { dispatched.push(e); return true; } };
    globalThis.CustomEvent ??= class CustomEvent { constructor(type) { this.type = type; } };
});

afterEach(() => {
    delete globalThis.toastr;
    delete globalThis.document;
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isInvalidModelConfigError
// ---------------------------------------------------------------------------

describe('isInvalidModelConfigError', () => {
    it('matches on the code marker alone, regardless of error class', () => {
        const tagged = new Error('bad model');
        tagged.code = 'invalid_model_config';
        expect(isInvalidModelConfigError(tagged)).toBe(true);
        // A plain object with the right code also passes — it is duck-typed.
        expect(isInvalidModelConfigError({ code: 'invalid_model_config' })).toBe(true);
    });

    it('rejects errors with a different or missing code', () => {
        expect(isInvalidModelConfigError(new Error('boom'))).toBe(false);
        expect(isInvalidModelConfigError({ code: 'missing_api_key' })).toBe(false);
        expect(isInvalidModelConfigError({})).toBe(false);
    });

    it('is null-safe and returns false (not undefined) for nullish input', () => {
        expect(isInvalidModelConfigError(null)).toBe(false);
        expect(isInvalidModelConfigError(undefined)).toBe(false);
    });

    it('returns false for primitives without throwing', () => {
        expect(isInvalidModelConfigError('invalid_model_config')).toBe(false);
        expect(isInvalidModelConfigError(0)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// notifyInvalidModel
// ---------------------------------------------------------------------------

describe('notifyInvalidModel', () => {
    it('shows a sticky toast that cannot auto-dismiss', () => {
        notifyInvalidModel('EventBase: model "x/y" not found');
        expect(toastrError).toHaveBeenCalledWith(
            'EventBase: model "x/y" not found',
            'VectFox — model no longer valid',
            { timeOut: 0, extendedTimeOut: 0 },
        );
    });

    it('de-dupes on the exact message so a failing auto-sync cannot spam toasts', () => {
        for (let i = 0; i < 50; i++) notifyInvalidModel('same message');
        expect(toastrError).toHaveBeenCalledOnce();
    });

    it('warns again for a different message (e.g. a different model id)', () => {
        notifyInvalidModel('model A is gone');
        notifyInvalidModel('model B is gone');
        expect(toastrError).toHaveBeenCalledTimes(2);
    });

    it('de-dupes on exact string equality — trailing whitespace counts as new', () => {
        notifyInvalidModel('msg');
        notifyInvalidModel('msg ');
        expect(toastrError).toHaveBeenCalledTimes(2);
    });

    it('ignores empty and nullish messages', () => {
        notifyInvalidModel('');
        notifyInvalidModel(null);
        notifyInvalidModel(undefined);
        expect(toastrError).not.toHaveBeenCalled();
    });

    it('does not throw when toastr is unavailable', () => {
        delete globalThis.toastr;
        expect(() => notifyInvalidModel('no toastr here')).not.toThrow();
    });

    it('still records a message as notified even when the toast throws', () => {
        // The message is added to the seen-set BEFORE the toastr call, so a
        // failed toast is never retried later.
        globalThis.toastr = { error: () => { throw new Error('toastr blew up'); } };
        notifyInvalidModel('flaky');

        globalThis.toastr = { error: toastrError };
        notifyInvalidModel('flaky');
        expect(toastrError).not.toHaveBeenCalled();
    });

    it('resetInvalidModelNotifications() lets a message warn afresh', () => {
        notifyInvalidModel('msg');
        resetInvalidModelNotifications();
        notifyInvalidModel('msg');
        expect(toastrError).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// pauseAutoSyncForChat
// ---------------------------------------------------------------------------

describe('pauseAutoSyncForChat', () => {
    it('turns auto-sync off for every EventBase collection of the chat', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([
            { registryKey: 'eb::chat-1::a' },
            { registryKey: 'eb::chat-1::b' },
        ]);

        await pauseAutoSyncForChat('chat-1', 'qdrant');

        expect(findEventBaseCollectionIdsForChat).toHaveBeenCalledWith('chat-1', 'qdrant');
        expect(setCollectionAutoSync).toHaveBeenCalledTimes(2);
        expect(setCollectionAutoSync).toHaveBeenNthCalledWith(1, 'eb::chat-1::a', false);
        expect(setCollectionAutoSync).toHaveBeenNthCalledWith(2, 'eb::chat-1::b', false);
    });

    it('dispatches vectfox:collections-updated so the UI checkbox refreshes', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([{ registryKey: 'k' }]);
        await pauseAutoSyncForChat('chat-1', 'qdrant');
        expect(dispatched.map(e => e.type)).toEqual(['vectfox:collections-updated']);
    });

    it('does NOT dispatch when nothing was paused', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([]);
        await pauseAutoSyncForChat('chat-1', 'qdrant');
        expect(setCollectionAutoSync).not.toHaveBeenCalled();
        expect(dispatched).toEqual([]);
    });

    it('no-ops without loading the store when chatUUID or backend is missing', async () => {
        await pauseAutoSyncForChat('', 'qdrant');
        await pauseAutoSyncForChat('chat-1', '');
        await pauseAutoSyncForChat(undefined, undefined);
        expect(findEventBaseCollectionIdsForChat).not.toHaveBeenCalled();
    });

    it('swallows a dispatchEvent failure after the collections are already paused', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([{ registryKey: 'k' }]);
        globalThis.document = { dispatchEvent: () => { throw new Error('no DOM'); } };
        await expect(pauseAutoSyncForChat('chat-1', 'qdrant')).resolves.toBeUndefined();
        expect(setCollectionAutoSync).toHaveBeenCalledWith('k', false);
    });

    it('propagates — does not swallow — a throw from setCollectionAutoSync', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([{ registryKey: 'k' }]);
        setCollectionAutoSync.mockImplementation(() => { throw new Error('registry write failed'); });
        await expect(pauseAutoSyncForChat('chat-1', 'qdrant')).rejects.toThrow('registry write failed');
    });

    it('passes undefined through when an entry has no registryKey — no filtering', async () => {
        findEventBaseCollectionIdsForChat.mockReturnValue([{}]);
        await pauseAutoSyncForChat('chat-1', 'qdrant');
        expect(setCollectionAutoSync).toHaveBeenCalledWith(undefined, false);
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReformatExecution, createReformatSession } from '../core/reformat-run.js';

afterEach(() => vi.useRealTimers());

describe('Auto-Reformat run ownership', () => {
    it('snapshots settings and prevents obsolete review or acceptance publication', () => {
        const session = createReformatSession();
        const settings = { model: 'old' };
        const old = session.start({ settings });
        settings.model = 'new';
        expect(old.snapshot.settings.model).toBe('old');
        const saved = { value: 'previous accepted result' };
        const next = session.start({ settings });
        expect(old.signal.aborted).toBe(true);
        expect(() => old.publish(() => { saved.value = 'stale'; })).toThrow();
        session.cancel();
        expect(() => next.publish(() => { saved.value = 'unfinished'; })).toThrow();
        expect(saved.value).toBe('previous accepted result');
    });

    it('cancels a retry wait without starting another request', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const execution = createReformatExecution(controller.signal);
        const request = vi.fn().mockRejectedValue(new Error('timeout'));
        const promise = execution.retry(request, { shouldRetry: () => true });
        const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await assertion;
        await vi.runAllTimersAsync();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('drains active siblings after fatal failure and never schedules the next job', async () => {
        const execution = createReformatExecution();
        const fatal = new Error('invalid model');
        let release;
        const sibling = new Promise(resolve => { release = resolve; });
        const queued = vi.fn();
        let settled = false;
        const run = execution.parallel([
            async () => { throw fatal; },
            async () => { await sibling; execution.check(); },
            queued,
        ], 2);
        const assertion = expect(run).rejects.toBe(fatal);
        run.catch(() => { settled = true; });
        await Promise.resolve();
        expect(execution.signal.aborted).toBe(true);
        expect(settled).toBe(false);
        release();
        await assertion;
        expect(queued).not.toHaveBeenCalled();
    });
});

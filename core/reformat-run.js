/** Owns the current draft through preparation, review, and synchronous publication. */
export function createReformatSession() {
    let current = null;
    const cancel = () => {
        current?.controller.abort();
        current = null;
    };
    return {
        cancel,
        start(snapshot) {
            cancel();
            const controller = new AbortController();
            const run = {
                controller, signal: controller.signal,
                snapshot: structuredClone(snapshot),
                isCurrent: () => current === run && !controller.signal.aborted,
                assertCurrent() {
                    if (!run.isCurrent()) throw new DOMException('Auto-Reformat cancelled', 'AbortError');
                },
                publish(work) {
                    run.assertCurrent();
                    // Publication must be synchronous: no source changes can interleave.
                    return work();
                },
            };
            current = run;
            return run;
        },
    };
}

/** Feature-owned scheduling: cancellation stops queues and drains active work. */
export function createReformatExecution(parentSignal) {
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const check = () => signal.throwIfAborted();
    const sleep = ms => new Promise((resolve, reject) => {
        check();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
    return {
        signal, check,
        async retry(work, { shouldRetry, onRetry }) {
            for (let attempt = 1; ; attempt++) {
                check();
                try {
                    const result = await work(signal);
                    check();
                    return result;
                } catch (error) {
                    check();
                    if (attempt >= 3 || !shouldRetry(error)) throw error;
                    onRetry?.(attempt, error);
                    await sleep(1500 * 2 ** (attempt - 1));
                }
            }
        },
        async parallel(work, concurrency) {
            let next = 0;
            let failure;
            const results = [];
            const worker = async () => {
                try {
                    while (next < work.length) {
                        check();
                        const index = next++;
                        results[index] = await work[index]();
                        check();
                    }
                } catch (error) {
                    if (!failure) failure = error;
                    controller.abort(error);
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
            if (failure) throw failure;
            check();
            return results;
        },
    };
}

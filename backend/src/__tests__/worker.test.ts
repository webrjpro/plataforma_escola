import { describe, expect, it } from 'vitest';

describe('worker entrypoint', () => {
    it('é import-safe e expõe inicialização explícita', async () => {
        const signalListeners = process.listenerCount('SIGTERM');

        const worker = await import('../worker');

        expect(worker.startVideoWorker).toBeTypeOf('function');
        expect(worker.stopVideoWorker).toBeTypeOf('function');
        expect(worker.runWorker).toBeTypeOf('function');
        expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
    }, 15_000);
});

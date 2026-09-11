import { afterEach, expect, it, vi } from 'vitest';
import { sendMessage, __resetSendQueueForTest } from '@/runtime/ui-protocol-send';
import * as Runtime from '@/runtime/ui-protocol-runtime';
import { __resetThinkingStoreForTest } from '@/store/thinking-store';
import type { UiProtocolBridge } from '@/runtime/ui-protocol-bridge';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/runtime/ui-protocol-bridge', async () => ({ ...await vi.importActual('@/runtime/ui-protocol-bridge'), createUiProtocolBridge: mocks.create }));

function makeBridge(): UiProtocolBridge {
  let state = 'connected';
  const states = new Set<(s: string) => void>();
  const target = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => { state = 'closed'; states.forEach(fn => fn('closed')); }),
    sendTurn: vi.fn(async () => ({ accepted: true })),
    getConnectionState: () => state,
    isTerminal: () => state === 'closed',
    onConnectionStateChange: (fn: (s: string) => void) => { states.add(fn); return () => states.delete(fn); },
    hydrateSession: vi.fn(async () => null),
    listLoops: vi.fn(async () => []),
    getGoal: vi.fn(async () => null),
    callMethod: vi.fn(async () => ({})),
  };
  return new Proxy(target, { get(obj, key) { if (key === 'then') return undefined; if (key in obj) return obj[key as keyof typeof target]; if (typeof key === 'string' && key.startsWith('on')) return () => () => {}; return () => false; } }) as unknown as UiProtocolBridge;
}
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
afterEach(() => { Runtime.__resetUiProtocolRuntimeForTest(); __resetSendQueueForTest(); __resetThinkingStoreForTest(); vi.restoreAllMocks(); });
it('does not let an old queued chat steal the new active session bridge', async () => {
  const a = makeBridge(), b = makeBridge(), reopenedA = makeBridge();
  mocks.create.mockReturnValueOnce(b).mockReturnValue(reopenedA);
  Runtime.__setActiveBridgeForTest('web-a', a);
  sendMessage({ sessionId: 'web-a', text: 'first', media: [], clientMessageId: 'review-1' });
  sendMessage({ sessionId: 'web-a', text: 'queued private followup', media: [], clientMessageId: 'review-2' });
  await flush();
  expect(a.sendTurn).toHaveBeenCalledTimes(1);
  // Matches React effect cleanup (fire-and-forget stop) followed by the new
  // session effect's start, before the queued promise continuation runs.
  const stopping = Runtime.stopActiveBridge();
  const starting = Runtime.startBridgeForSession('web-b');
  await Promise.allSettled([stopping, starting]);
  await flush();
  expect(reopenedA.sendTurn).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(Runtime.getActiveBridge('web-b')).toBe(b);
});

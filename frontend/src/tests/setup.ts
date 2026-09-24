import "@testing-library/jest-dom/vitest";

// jsdom (the test DOM environment) does not implement WebSocket. Stub a
// minimal, inert version so components that open a realtime connection
// (RealtimeProvider) can render in tests without crashing — tests that
// need to simulate realtime messages do so through RealtimeContext's own
// `subscribe`/mocked services, not through this stub actually connecting.
class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = StubWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {}

  send(): void {
    // no-op — nothing is actually connected in tests
  }

  close(): void {
    this.readyState = StubWebSocket.CLOSED;
    this.onclose?.();
  }
}

// @ts-expect-error - intentionally partial implementation, sufficient for tests
globalThis.WebSocket = StubWebSocket;

// jsdom doesn't implement scrollIntoView (used by ChatConversationPage to auto-scroll to the latest message).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

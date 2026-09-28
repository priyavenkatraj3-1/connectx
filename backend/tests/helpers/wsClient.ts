import { WebSocket } from "ws";

type Event = Record<string, unknown>;

/**
 * Queues every incoming message on a socket so tests can `.next()` them in
 * order, even if two frames arrive back-to-back before the test asks for
 * the second one. `.nextOfType()` skips unrelated events and gives up after
 * a timeout (removing its waiter, so no later event is swallowed).
 */
export function createMessageQueue(ws: WebSocket) {
  const buffered: Event[] = [];
  const waiters: Array<(msg: Event) => void> = [];

  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as Event;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      buffered.push(parsed);
    }
  });

  const next = (timeoutMs = 3000): Promise<Event> => {
    const queued = buffered.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = (msg: Event) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for an event"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    next,
    async nextOfType(type: string, timeoutMs = 3000): Promise<Event> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for a "${type}" event`);
        let event: Event;
        try {
          event = await next(remaining);
        } catch {
          throw new Error(`Timed out waiting for a "${type}" event`);
        }
        if (event.type === type) return event;
      }
    },
  };
}

export function connect(baseWsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWsUrl}?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

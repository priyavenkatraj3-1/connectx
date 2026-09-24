import type { Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyAccessToken } from "../modules/auth/token.service";
import { ConnectionRegistry } from "./connection-registry";
import type { ClientEvent, ServerEvent } from "./events";
import type { RealtimeGateway } from "./gateway.interface";

export const WS_PATH = "/ws";

interface WebSocketGatewayOptions {
  /** Called when a client reports it has read up to a given message in a conversation. */
  onClientRead: (userId: string, conversationId: string, upToMessageId: string) => Promise<void>;
}

interface AuthenticatedUpgradeRequest {
  url?: string;
  connectXUserId?: string;
}

/**
 * Attaches a WebSocket server to the given HTTP server at WS_PATH and
 * returns a RealtimeGateway for pushing server → client events. Clients
 * authenticate by passing their access token as a query parameter:
 * `ws://host/ws?token=<accessToken>` (WebSocket has no custom-header
 * support in browsers, so a query param is the standard workaround).
 */
export function attachWebSocketGateway(httpServer: HttpServer, options: WebSocketGatewayOptions): RealtimeGateway {
  const registry = new ConnectionRegistry();

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    // Authenticate during the HTTP Upgrade handshake itself, so an invalid
    // token gets a real 401 and the WebSocket connection never opens on the
    // client side — accepting the socket first and closing it right after
    // would still fire the client's `open` event.
    verifyClient: (info, callback) => {
      const req = info.req as AuthenticatedUpgradeRequest;
      const url = new URL(req.url ?? "", "http://localhost");
      const token = url.searchParams.get("token");

      try {
        if (!token) throw new Error("missing token");
        req.connectXUserId = verifyAccessToken(token).userId;
        callback(true);
      } catch {
        callback(false, 401, "Unauthorized");
      }
    },
  });

  wss.on("connection", (socket: WebSocket, request: AuthenticatedUpgradeRequest) => {
    const userId = request.connectXUserId;
    if (!userId) {
      socket.close(4401, "Unauthorized");
      return;
    }

    registry.add(userId, socket);

    socket.on("message", (raw) => {
      void handleClientMessage(userId, raw.toString(), options).catch(() => {
        send(socket, { type: "error", message: "Failed to process message" });
      });
    });

    socket.on("close", () => {
      registry.remove(userId, socket);
    });
  });

  return {
    sendToUser(userId: string, event: ServerEvent) {
      for (const socket of registry.getSockets(userId)) {
        send(socket, event);
      }
    },
    isUserOnline(userId: string) {
      return registry.isOnline(userId);
    },
  };
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

async function handleClientMessage(userId: string, raw: string, options: WebSocketGatewayOptions): Promise<void> {
  let event: ClientEvent;
  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    return;
  }

  if (event.type === "message:read") {
    await options.onClientRead(userId, event.conversationId, event.upToMessageId);
  }
  // "ping" and any unrecognized event types are intentionally ignored —
  // the connection itself proves liveness.
}

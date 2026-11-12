import type { Container } from "../container";
import { env } from "../config/env";
import type { WebSocketGatewayOptions } from "./ws.server";

/**
 * Connects the WebSocket gateway's inbound events to the services that
 * handle them. Shared by server.ts and the realtime tests so both wire the
 * gateway identically.
 */
export function buildGatewayOptions(container: Container): WebSocketGatewayOptions {
  return {
    onClientRead: (userId, conversationId, upToMessageId) =>
      container.messagesService.markRead(conversationId, userId, upToMessageId),
    onClientTyping: (userId, conversationId, isTyping) => container.messagesService.setTyping(conversationId, userId, isTyping),
    onCallEvent: (ctx, event) => container.callsService.handleClientEvent(ctx, event),
    onConnect: (ctx) => container.callsService.handleConnect(ctx),
    onDisconnect: (ctx) => container.callsService.handleDisconnect(ctx),
    validateSession: (userId, sessionId) => container.sessionsService.isActive(userId, sessionId),
    allowedOrigins: env.clientOrigins,
    maxMessagesPer10s: env.ws.maxMessagesPer10s,
    maxConnectionsPerUser: env.ws.maxConnectionsPerUser,
    heartbeatIntervalMs: env.ws.heartbeatIntervalMs,
  };
}

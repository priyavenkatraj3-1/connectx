import { type DatabaseClient, getDb } from "./db/pool";
import { AuthService } from "./modules/auth/auth.service";
import { PostgresUserRepository } from "./modules/auth/postgres-user.repository";
import { ConversationsRepository } from "./modules/conversations/conversations.repository";
import { ConversationsService } from "./modules/conversations/conversations.service";
import { MessagesRepository } from "./modules/messages/messages.repository";
import { MessagesService } from "./modules/messages/messages.service";
import { UsersRepository } from "./modules/users/users.repository";
import { UsersService } from "./modules/users/users.service";
import { noopRealtimeGateway, type RealtimeGateway } from "./realtime/gateway.interface";

export interface ContainerOverrides {
  db?: DatabaseClient;
  realtimeGateway?: RealtimeGateway;
}

export interface Container {
  db: DatabaseClient;
  /** Mutable holder so server.ts can swap in the live WebSocket gateway after the HTTP server exists — see src/server.ts. */
  realtimeGatewayRef: { current: RealtimeGateway };
  authService: AuthService;
  usersService: UsersService;
  conversationsService: ConversationsService;
  messagesService: MessagesService;
}

/**
 * Builds every repository/service the API depends on, wired to a single
 * DatabaseClient. Production (server.ts) uses the real Postgres pool;
 * tests inject a pg-mem-backed client — see backend/tests/helpers/testDb.ts.
 */
export function createContainer(overrides: ContainerOverrides = {}): Container {
  const db = overrides.db ?? getDb();

  const realtimeGatewayRef: { current: RealtimeGateway } = {
    current: overrides.realtimeGateway ?? noopRealtimeGateway,
  };
  const delegatingGateway: RealtimeGateway = {
    sendToUser: (userId, event) => realtimeGatewayRef.current.sendToUser(userId, event),
    isUserOnline: (userId) => realtimeGatewayRef.current.isUserOnline(userId),
  };

  const userRepository = new PostgresUserRepository(db);
  const authService = new AuthService(userRepository);

  const usersRepository = new UsersRepository(db);
  const usersService = new UsersService(usersRepository);

  const conversationsRepository = new ConversationsRepository(db, usersRepository);
  const conversationsService = new ConversationsService(conversationsRepository);

  const messagesRepository = new MessagesRepository(db);
  const messagesService = new MessagesService(messagesRepository, conversationsRepository, delegatingGateway);

  return {
    db,
    realtimeGatewayRef,
    authService,
    usersService,
    conversationsService,
    messagesService,
  };
}

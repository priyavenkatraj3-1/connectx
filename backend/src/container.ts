import { env } from "./config/env";
import { type DatabaseClient, getDb } from "./db/pool";
import { AuthService } from "./modules/auth/auth.service";
import { CallsRepository } from "./modules/calls/calls.repository";
import { CallsService } from "./modules/calls/calls.service";
import { PostgresUserRepository } from "./modules/auth/postgres-user.repository";
import { ConversationsRepository } from "./modules/conversations/conversations.repository";
import { ConversationsService } from "./modules/conversations/conversations.service";
import { GroupsRepository } from "./modules/groups/groups.repository";
import { GroupsService } from "./modules/groups/groups.service";
import { MediaRepository } from "./modules/media/media.repository";
import { MediaService } from "./modules/media/media.service";
import { LocalDiskStorageProvider } from "./modules/media/storage/local-disk.storage";
import type { StorageProvider } from "./modules/media/storage/storage-provider.interface";
import { MessagesRepository } from "./modules/messages/messages.repository";
import { MessagesService } from "./modules/messages/messages.service";
import { StatusesRepository } from "./modules/statuses/statuses.repository";
import { StatusesService } from "./modules/statuses/statuses.service";
import { UsersRepository } from "./modules/users/users.repository";
import { UsersService } from "./modules/users/users.service";
import { noopRealtimeGateway, type RealtimeGateway } from "./realtime/gateway.interface";

export interface ContainerOverrides {
  db?: DatabaseClient;
  realtimeGateway?: RealtimeGateway;
  /** Media byte storage. Defaults to local disk under UPLOAD_DIR; tests inject an in-memory store. */
  storage?: StorageProvider;
  /** Upload size cap in bytes. Defaults to MAX_UPLOAD_SIZE_MB. */
  maxUploadBytes?: number;
  /** Call ring timeout. Defaults to CALL_RING_TIMEOUT_SECONDS; tests shorten it. */
  callRingTimeoutMs?: number;
  /** How long a dropped connection may take to reconnect before its call participation ends. */
  callReconnectGraceMs?: number;
  /** Max joined participants in a (mesh) group call. Defaults to MAX_MESH_PARTICIPANTS. */
  callMaxMeshParticipants?: number;
}

export interface Container {
  db: DatabaseClient;
  /** Mutable holder so server.ts can swap in the live WebSocket gateway after the HTTP server exists — see src/server.ts. */
  realtimeGatewayRef: { current: RealtimeGateway };
  storage: StorageProvider;
  maxUploadBytes: number;
  authService: AuthService;
  usersService: UsersService;
  conversationsService: ConversationsService;
  messagesService: MessagesService;
  groupsService: GroupsService;
  mediaService: MediaService;
  callsService: CallsService;
  statusesService: StatusesService;
}

/**
 * Builds every repository/service the API depends on, wired to a single
 * DatabaseClient. Production (server.ts) uses the real Postgres pool;
 * tests inject a pg-mem-backed client — see backend/tests/helpers/testDb.ts.
 */
export function createContainer(overrides: ContainerOverrides = {}): Container {
  const db = overrides.db ?? getDb();
  const storage = overrides.storage ?? new LocalDiskStorageProvider(env.uploadDir);
  const maxUploadBytes = overrides.maxUploadBytes ?? env.maxUploadSizeMb * 1024 * 1024;

  const realtimeGatewayRef: { current: RealtimeGateway } = {
    current: overrides.realtimeGateway ?? noopRealtimeGateway,
  };
  const delegatingGateway: RealtimeGateway = {
    sendToUser: (userId, event) => realtimeGatewayRef.current.sendToUser(userId, event),
    isUserOnline: (userId) => realtimeGatewayRef.current.isUserOnline(userId),
    sendToConnection: (userId, connectionId, event) =>
      realtimeGatewayRef.current.sendToConnection(userId, connectionId, event),
    hasConnection: (userId, connectionId) => realtimeGatewayRef.current.hasConnection(userId, connectionId),
  };

  const userRepository = new PostgresUserRepository(db);
  const authService = new AuthService(userRepository);

  const usersRepository = new UsersRepository(db);
  const usersService = new UsersService(usersRepository);

  const conversationsRepository = new ConversationsRepository(db, usersRepository);
  const conversationsService = new ConversationsService(conversationsRepository);

  const mediaRepository = new MediaRepository(db);
  const messagesRepository = new MessagesRepository(db, mediaRepository);
  const messagesService = new MessagesService(
    messagesRepository,
    conversationsRepository,
    delegatingGateway,
    mediaRepository,
    storage
  );

  const groupsRepository = new GroupsRepository(db);
  const groupsService = new GroupsService(groupsRepository, usersRepository, delegatingGateway);

  const statusesRepository = new StatusesRepository(db);
  const statusesService = new StatusesService(statusesRepository, mediaRepository, usersRepository, storage, delegatingGateway);

  const mediaService = new MediaService(
    mediaRepository,
    conversationsRepository,
    messagesRepository,
    storage,
    maxUploadBytes,
    statusesRepository
  );

  const callsService = new CallsService(
    new CallsRepository(db),
    conversationsRepository,
    usersRepository,
    delegatingGateway,
    {
      ringTimeoutMs: overrides.callRingTimeoutMs ?? env.calls.ringTimeoutMs,
      reconnectGraceMs: overrides.callReconnectGraceMs,
      maxMeshParticipants: overrides.callMaxMeshParticipants,
      iceServers: env.webrtc,
    }
  );

  return {
    db,
    realtimeGatewayRef,
    storage,
    maxUploadBytes,
    authService,
    usersService,
    conversationsService,
    messagesService,
    groupsService,
    mediaService,
    callsService,
    statusesService,
  };
}

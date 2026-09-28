import { env } from "./config/env";
import { type DatabaseClient, getDb } from "./db/pool";
import { AISettingsService } from "./modules/ai/ai-settings.service";
import type { AIServices } from "./modules/ai/ai.controller";
import { AIGateway } from "./modules/ai/ai.gateway";
import { AIRateLimiter } from "./modules/ai/ai.rate-limiter";
import { AIRepository } from "./modules/ai/ai.repository";
import { AIContextService } from "./modules/ai/context/ai-context.service";
import { SmartActionsService } from "./modules/ai/features/actions.service";
import { AskYourChatsService } from "./modules/ai/features/ask.service";
import { GroupDecisionService } from "./modules/ai/features/group-decision.service";
import { AIMemoryService } from "./modules/ai/features/memory.service";
import { ScamShieldService } from "./modules/ai/features/scam-shield.service";
import { TranslationService } from "./modules/ai/features/translation.service";
import { VoiceIntelligenceService } from "./modules/ai/features/voice.service";
import type { AIProvider, TranscriptionProvider } from "./modules/ai/interfaces/ai-provider.interface";
import { createAIProvider, createTranscriptionProvider } from "./modules/ai/providers/provider.factory";
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
  /** AI text provider. Defaults to the one selected by AI_PROVIDER; tests inject fakes. */
  aiProvider?: AIProvider;
  /** Speech-to-text provider. Defaults to TRANSCRIPTION_PROVIDER. */
  transcriptionProvider?: TranscriptionProvider;
  /** AI limits/timeouts. Defaults come from env (AI_*). */
  aiOptions?: Partial<{
    timeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    maxOutputTokens: number;
    maxContextChars: number;
    rateLimitPerMinute: number;
    rateLimitPerDay: number;
    maxAudioBytes: number;
  }>;
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
  ai: AIServices;
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

  const aiOptions = overrides.aiOptions ?? {};
  const aiRepository = new AIRepository(db);
  const aiGateway = new AIGateway(
    overrides.aiProvider ?? createAIProvider(),
    overrides.transcriptionProvider ?? createTranscriptionProvider(),
    aiRepository,
    new AIRateLimiter(aiRepository, {
      perMinute: aiOptions.rateLimitPerMinute ?? env.ai.rateLimitPerMinute,
      perDay: aiOptions.rateLimitPerDay ?? env.ai.rateLimitPerDay,
    }),
    delegatingGateway,
    {
      timeoutMs: aiOptions.timeoutMs ?? env.ai.timeoutMs,
      maxRetries: aiOptions.maxRetries ?? env.ai.maxRetries,
      retryBaseDelayMs: aiOptions.retryBaseDelayMs,
      maxOutputTokens: aiOptions.maxOutputTokens ?? env.ai.maxOutputTokens,
    }
  );
  const aiSettingsService = new AISettingsService(aiRepository, conversationsRepository, aiGateway);
  const aiContext = new AIContextService(aiRepository, { maxContextChars: aiOptions.maxContextChars ?? env.ai.maxContextChars });
  const ai: AIServices = {
    settings: aiSettingsService,
    ask: new AskYourChatsService(aiSettingsService, aiContext, aiRepository, aiGateway),
    memory: new AIMemoryService(aiSettingsService, aiRepository, messagesRepository),
    actions: new SmartActionsService(aiSettingsService, aiContext, aiRepository, aiGateway),
    groupDecision: new GroupDecisionService(aiSettingsService, aiContext, aiGateway),
    translation: new TranslationService(aiSettingsService, aiRepository, messagesRepository, aiGateway),
    scamShield: new ScamShieldService(aiSettingsService, aiRepository, messagesRepository, aiGateway),
    voice: new VoiceIntelligenceService(
      aiSettingsService,
      aiRepository,
      mediaService,
      aiGateway,
      aiOptions.maxAudioBytes ?? env.ai.transcription.maxAudioBytes
    ),
  };

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
    ai,
  };
}

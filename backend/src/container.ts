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
import { MessagesService, type MentionNotifier } from "./modules/messages/messages.service";
import { BusinessService } from "./modules/business/business.service";
import { ConversationAccessService } from "./modules/collaboration/conversation-access";
import { SharedNotesService } from "./modules/collaboration/notes.service";
import { SharedTodosService } from "./modules/collaboration/todos.service";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { MessageOrganizationService } from "./modules/organization/organization.service";
import { PreferencesService } from "./modules/preferences/preferences.service";
import { EventsService } from "./modules/productivity/events.service";
import { RemindersService } from "./modules/productivity/reminders.service";
import { SourceResolver } from "./modules/productivity/source";
import { TasksService } from "./modules/productivity/tasks.service";
import { ScheduledMessagesService } from "./modules/scheduled-messages/scheduled-messages.service";
import { SchedulerService } from "./modules/scheduler/scheduler.service";
import { SessionsService } from "./modules/sessions/sessions.service";
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
  // --- Phase 6 ---
  conversationAccess: ConversationAccessService;
  preferencesService: PreferencesService;
  notificationsService: NotificationsService;
  sessionsService: SessionsService;
  tasksService: TasksService;
  remindersService: RemindersService;
  eventsService: EventsService;
  notesService: SharedNotesService;
  todosService: SharedTodosService;
  organizationService: MessageOrganizationService;
  scheduledMessagesService: ScheduledMessagesService;
  businessService: BusinessService;
  schedulerService: SchedulerService;
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
    disconnectSession: (userId, sessionId) => realtimeGatewayRef.current.disconnectSession?.(userId, sessionId),
  };

  // Phase 6 building blocks used by several modules below.
  const conversationAccess = new ConversationAccessService(db);
  const preferencesService = new PreferencesService(db, delegatingGateway);
  const notificationsService = new NotificationsService(db, delegatingGateway, preferencesService);
  const sessionsService = new SessionsService(db, delegatingGateway);

  const userRepository = new PostgresUserRepository(db);
  const authService = new AuthService(userRepository, sessionsService, notificationsService);

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
    storage,
    createMentionNotifier(db, notificationsService)
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

  const sourceResolver = new SourceResolver(db, conversationAccess);
  const remindersService = new RemindersService(db, delegatingGateway, preferencesService, sourceResolver);
  const tasksService = new TasksService(
    db,
    delegatingGateway,
    conversationAccess,
    preferencesService,
    sourceResolver,
    remindersService,
    notificationsService
  );
  const eventsService = new EventsService(db, delegatingGateway, preferencesService, sourceResolver);
  const notesService = new SharedNotesService(db, delegatingGateway, conversationAccess);
  const todosService = new SharedTodosService(db, delegatingGateway, conversationAccess, notificationsService);
  const organizationService = new MessageOrganizationService(db, delegatingGateway, conversationAccess);
  const scheduledMessagesService = new ScheduledMessagesService(
    db,
    delegatingGateway,
    conversationAccess,
    preferencesService,
    messagesService,
    notificationsService
  );
  const businessService = new BusinessService(db, delegatingGateway);
  const schedulerService = new SchedulerService(db, delegatingGateway, notificationsService, remindersService, scheduledMessagesService);

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
    conversationAccess,
    preferencesService,
    notificationsService,
    sessionsService,
    tasksService,
    remindersService,
    eventsService,
    notesService,
    todosService,
    organizationService,
    scheduledMessagesService,
    businessService,
    schedulerService,
  };
}

/** @mention → in-app notification for each mentioned member (respecting their notification preference). No message text is stored. */
function createMentionNotifier(db: DatabaseClient, notifications: NotificationsService): MentionNotifier {
  return async ({ conversationId, conversationType, messageId, senderName, mentionedUserIds }) => {
    let where = "";
    if (conversationType === "group") {
      const group = await db.query<{ name: string }>("SELECT name FROM groups WHERE conversation_id = $1", [conversationId]);
      if (group.rows[0]) where = ` in ${group.rows[0].name}`;
    }
    for (const userId of mentionedUserIds) {
      await notifications.notify({
        userId,
        type: "mention",
        title: `${senderName} mentioned you${where}`,
        payload: { conversationId, messageId },
        dedupeKey: `mention:${messageId}`,
      });
    }
  };
}

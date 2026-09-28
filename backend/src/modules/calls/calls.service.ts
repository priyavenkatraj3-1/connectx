import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { CallClientEvent, ServerEvent } from "../../realtime/events";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { ConnectionContext } from "../../realtime/ws.server";
import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { UsersRepository } from "../users/users.repository";
import { LiveCallExistsError, type CallsRepository, type SessionPatch } from "./calls.repository";
import {
  DEFAULT_RECONNECT_GRACE_MS,
  DEFAULT_RING_TIMEOUT_MS,
  isLiveState,
  MAX_MESH_PARTICIPANTS,
  type CallDTO,
  type CallEndReason,
  type CallHistoryEntryDTO,
  type CallMedia,
  type CallOutcome,
  type CallState,
  type IceServerConfig,
} from "./calls.types";
import { buildIceServers, type IceServerSettings } from "./ice-servers";

export interface CallsServiceOptions {
  ringTimeoutMs?: number;
  reconnectGraceMs?: number;
  maxMeshParticipants?: number;
  iceServers: IceServerSettings;
}

/** Serializes async work per key, so concurrent events for one call are applied one at a time. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

const ANSWERABLE: CallState[] = ["ringing", "accepted", "connecting", "connected"];

/**
 * Call lifecycle + WebRTC signaling authority.
 *
 * Media (audio/video) never touches the server: browsers exchange it
 * peer-to-peer over WebRTC. The server's job is to decide who may call
 * whom, track each call's state, and relay signaling (SDP offers/answers,
 * ICE candidates) between the *specific devices* that joined — nothing a
 * client sends about identity is trusted; it comes from the authenticated
 * socket.
 *
 * Session state machine (see database/migrations/003_calls_status.sql):
 *
 *   ringing ──accept──▶ accepted ──first offer──▶ connecting ──media up──▶ connected
 *      │                    └──────────────── hang up / all left ─────────────┴──▶ ended
 *      ├─ decline (direct, or every group invitee) ─▶ declined
 *      ├─ caller cancels ─▶ cancelled
 *      └─ ring timeout, nobody answered ─▶ missed
 *   direct call media failure, or disconnect of a device mid-call ─▶ failed / ended
 *
 * Group calls use a peer-to-peer *mesh* (each joined device connects to
 * every other), capped at MAX_MESH_PARTICIPANTS joined participants. That
 * is a foundation, not a production-scale design — larger calls need an
 * SFU; the session/participant model here is what an SFU would plug into.
 *
 * Ephemeral state — which connection each participant joined from, ring
 * timers, mic/camera flags — lives in process memory. That matches the
 * single-instance WebSocket gateway; on restart, recoverStaleCalls() marks
 * any calls left "live" in the database as failed.
 */
export class CallsService {
  private readonly ringTimeoutMs: number;
  private readonly reconnectGraceMs: number;
  private readonly maxMeshParticipants: number;
  private readonly mutex = new KeyedMutex();
  /** callId → userId → connectionId of the device that joined. */
  private readonly bindings = new Map<string, Map<string, string>>();
  /** callId → userId → last reported mic/camera state. */
  private readonly mediaStates = new Map<string, Map<string, { audioEnabled: boolean; videoEnabled: boolean }>>();
  private readonly ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly callsRepository: CallsRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly options: CallsServiceOptions
  ) {
    this.ringTimeoutMs = options.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
    this.reconnectGraceMs = options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.maxMeshParticipants = options.maxMeshParticipants ?? MAX_MESH_PARTICIPANTS;
  }

  // ---------------------------------------------------------------------------
  // Queries (REST)
  // ---------------------------------------------------------------------------

  getIceServers(userId: string): IceServerConfig[] {
    return buildIceServers(this.options.iceServers, userId);
  }

  /** Participants can always see a call; for a live group call, any active group member can too (so they can join). */
  async getCall(callId: string, userId: string): Promise<CallDTO> {
    const call = await this.callsRepository.findById(callId);
    if (!call) throw new AppError("Call not found", 404);
    const isParticipant = call.participants.some((p) => p.userId === userId);
    const canJoin =
      call.scope === "group" && isLiveState(call.state) && (await this.conversationsRepository.isMember(call.conversationId, userId));
    if (!isParticipant && !canJoin) throw new AppError("You do not have access to this call", 403);
    return this.withMediaState(call);
  }

  async getActiveCall(conversationId: string, userId: string): Promise<CallDTO | null> {
    await this.requireMember(conversationId, userId);
    const call = await this.callsRepository.findLiveByConversation(conversationId);
    return call ? this.withMediaState(call) : null;
  }

  /**
   * Call history for the user: only calls they were invited to or started
   * (a group member who joined later never sees earlier calls). With a
   * conversationId, the user must also still be an active member.
   */
  async listHistory(
    userId: string,
    options: { conversationId?: string; limit?: number; before?: string }
  ): Promise<CallHistoryEntryDTO[]> {
    if (options.conversationId) await this.requireMember(options.conversationId, userId);
    const calls = await this.callsRepository.listForParticipant(userId, {
      conversationId: options.conversationId,
      limit: options.limit ?? 50,
      beforeCallId: options.before,
    });
    return calls.map((call) => toHistoryEntry(this.withMediaState(call), userId));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async startCall(
    userId: string,
    input: { conversationId: string; media: CallMedia; connectionId: string }
  ): Promise<CallDTO> {
    await this.requireMember(input.conversationId, userId);
    if (!this.realtimeGateway.hasConnection(userId, input.connectionId)) {
      throw new AppError("Your realtime connection isn't open. Reconnect and try again.", 409);
    }

    const conversation = await this.conversationsRepository.getById(input.conversationId);
    if (!conversation) throw new AppError("Conversation not found", 404);

    const inviteeIds = (await this.conversationsRepository.getAllMemberIds(input.conversationId)).filter((id) => id !== userId);
    if (inviteeIds.length === 0) throw new AppError("There is no one else in this conversation to call", 400);

    if ((await this.callsRepository.findLiveCallIdsJoinedBy(userId)).length > 0) {
      throw new AppError("You are already in a call", 409);
    }

    if (conversation.type === "direct") {
      const calleeId = inviteeIds[0]!;
      const callee = await this.usersRepository.findPublicProfile(calleeId);
      if (!callee) throw new AppError("This user is no longer available", 400);
      if ((await this.callsRepository.findLiveCallIdsJoinedBy(calleeId)).length > 0) {
        throw new AppError(`${callee.displayName} is on another call`, 409);
      }
    }

    let call: CallDTO;
    try {
      call = await this.callsRepository.createSession({
        conversationId: input.conversationId,
        initiatorId: userId,
        scope: conversation.type,
        media: input.media,
        inviteeIds,
      });
    } catch (err) {
      if (err instanceof LiveCallExistsError) {
        throw new AppError(
          conversation.type === "group"
            ? "A call is already in progress in this group — join it instead"
            : "A call is already in progress in this conversation",
          409
        );
      }
      throw err;
    }

    this.bind(call.id, userId, input.connectionId);
    this.scheduleRingTimeout(call.id);

    const dto = this.withMediaState(call);
    broadcast(this.realtimeGateway, inviteeIds, { type: "call:invite", call: dto });
    return dto;
  }

  /** Routes a validated client event from the WebSocket gateway. */
  async handleClientEvent(ctx: ConnectionContext, event: CallClientEvent): Promise<void> {
    switch (event.type) {
      case "call:ring":
        return this.ring(ctx, event.callId);
      case "call:accept":
        return this.accept(ctx, event.callId);
      case "call:decline":
        return this.decline(ctx.userId, event.callId);
      case "call:cancel":
        return this.cancel(ctx.userId, event.callId);
      case "call:end":
        await this.hangUp(ctx.userId, event.callId);
        return;
      case "call:offer":
      case "call:answer":
      case "call:ice_candidate":
        return this.relaySignal(ctx, event);
      case "call:connected":
        return this.reportConnected(ctx, event.callId);
      case "call:failed":
        return this.reportFailed(ctx, event.callId, event.reason);
      case "call:media_state":
        return this.reportMediaState(ctx, event.callId, event.audioEnabled, event.videoEnabled);
    }
  }

  /** An invitee's device acknowledges the invite and is ringing. */
  async ring(ctx: ConnectionContext, callId: string): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.requireLiveCall(callId);
      const participant = call.participants.find((p) => p.userId === ctx.userId);
      if (!participant || participant.role !== "invitee") throw new AppError("You were not invited to this call", 403);

      const changed = await this.callsRepository.transitionParticipant(callId, ctx.userId, ["invited"], "ringing");
      if (!changed) return; // already ringing on another device, or already answered
      await this.callsRepository.addEvent(callId, ctx.userId, "ringing");
      broadcast(this.realtimeGateway, this.joinedUserIds(call), { type: "call:ring", callId, userId: ctx.userId });
    });
  }

  /** Accept a direct call, or join a group call (also used to re-join a group call you left). */
  async accept(ctx: ConnectionContext, callId: string): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.requireLiveCall(callId);
      let participant = call.participants.find((p) => p.userId === ctx.userId);

      if (!participant) {
        // Late joiner: a group member who wasn't a member when the call started.
        if (call.scope !== "group" || !(await this.conversationsRepository.isMember(call.conversationId, ctx.userId))) {
          throw new AppError("You were not invited to this call", 403);
        }
        await this.callsRepository.insertParticipant(callId, ctx.userId, "invitee", "invited");
        participant = { userId: ctx.userId, role: "invitee", state: "invited" } as CallDTO["participants"][number];
      } else if (call.scope === "group" && !(await this.conversationsRepository.isMember(call.conversationId, ctx.userId))) {
        throw new AppError("You are no longer a member of this group", 403);
      }

      if (participant.state === "joined") {
        if (this.bindings.get(callId)?.get(ctx.userId) === ctx.connectionId) return;
        throw new AppError("You are already in this call on another device", 409);
      }

      if (call.scope === "direct") {
        if (participant.role !== "invitee" || !["invited", "ringing"].includes(participant.state) || call.state !== "ringing") {
          throw new AppError("This call can no longer be answered", 409);
        }
      } else if (this.joinedUserIds(call).length >= this.maxMeshParticipants) {
        throw new AppError(`This call is full (maximum ${this.maxMeshParticipants} participants)`, 409);
      }

      const otherLiveCalls = (await this.callsRepository.findLiveCallIdsJoinedBy(ctx.userId)).filter((id) => id !== callId);
      if (otherLiveCalls.length > 0) throw new AppError("You are already in another call", 409);

      const joinable = call.scope === "direct" ? (["invited", "ringing"] as const) : (["invited", "ringing", "declined", "missed", "left"] as const);
      const joined = await this.callsRepository.transitionParticipant(callId, ctx.userId, [...joinable], "joined");
      if (!joined) throw new AppError("This call can no longer be answered", 409);

      this.bind(callId, ctx.userId, ctx.connectionId);
      if (call.state === "ringing") {
        await this.callsRepository.transitionSession(callId, ["ringing"], { state: "accepted", answeredAt: new Date() });
        if (call.scope === "direct") this.clearRingTimer(callId);
      }
      await this.callsRepository.addEvent(callId, ctx.userId, call.state === "ringing" ? "accepted" : "joined");

      const updated = await this.reload(callId);
      this.broadcastToParticipants(updated, { type: "call:accept", call: updated, userId: ctx.userId });
    });
  }

  async decline(userId: string, callId: string): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.requireLiveCall(callId);
      const participant = call.participants.find((p) => p.userId === userId);
      if (!participant || participant.role !== "invitee") throw new AppError("You were not invited to this call", 403);

      const declined = await this.callsRepository.transitionParticipant(callId, userId, ["invited", "ringing"], "declined");
      if (!declined) throw new AppError("This call can no longer be declined", 409);
      await this.callsRepository.addEvent(callId, userId, "declined");

      const afterDecline = await this.reload(callId);
      const stillPending = afterDecline.participants.some(
        (p) => p.role === "invitee" && ["invited", "ringing", "joined"].includes(p.state)
      );

      if (call.scope === "direct" || (!stillPending && afterDecline.state === "ringing")) {
        // Nobody left to answer: the whole call is declined.
        const ended = await this.finish(callId, ["ringing"], { state: "declined", endReason: "declined" }, userId, "declined");
        if (ended) this.broadcastToParticipants(ended, { type: "call:decline", call: ended, userId });
        return;
      }

      this.broadcastToParticipants(afterDecline, { type: "call:decline", call: afterDecline, userId });
    });
  }

  /** The caller withdraws the call before anyone answered. */
  async cancel(userId: string, callId: string): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.requireLiveCall(callId);
      if (call.initiatorId !== userId) throw new AppError("Only the caller can cancel this call", 403);
      if (call.state !== "ringing") throw new AppError("This call was already answered — hang up instead", 409);

      const ended = await this.finish(callId, ["ringing"], { state: "cancelled", endReason: "cancelled" }, userId, "cancelled");
      if (!ended) throw new AppError("This call was already answered — hang up instead", 409);
      this.broadcastToParticipants(ended, { type: "call:cancel", call: ended });
    });
  }

  /**
   * "Hang up" — does the right thing for the caller's current role:
   * cancel (caller, still ringing), decline (invitee, still ringing),
   * end (direct call in progress) or leave (group call in progress).
   * Also backs POST /calls/:callId/end, so a client can always get out.
   */
  async hangUp(userId: string, callId: string): Promise<CallDTO> {
    const call = await this.callsRepository.findById(callId);
    if (!call) throw new AppError("Call not found", 404);
    const participant = call.participants.find((p) => p.userId === userId);
    if (!participant) throw new AppError("You are not part of this call", 403);
    if (!isLiveState(call.state)) return this.withMediaState(call);

    if (participant.role === "initiator" && call.state === "ringing") {
      await this.cancel(userId, callId);
    } else if (participant.state === "invited" || participant.state === "ringing") {
      await this.decline(userId, callId);
    } else if (participant.state === "joined") {
      await this.leave(userId, callId, "hangup");
    } else {
      throw new AppError("You are not in this call", 409);
    }
    return this.withMediaState(await this.reload(callId));
  }

  /**
   * A joined participant leaves. Direct calls end for both sides; group
   * calls continue until the last joined participant leaves.
   */
  private async leave(userId: string, callId: string, reason: "hangup" | "disconnected" | CallEndReason): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.callsRepository.findById(callId);
      if (!call || !isLiveState(call.state)) return;
      const participant = call.participants.find((p) => p.userId === userId);
      if (!participant || participant.state !== "joined") return;

      if (call.scope === "direct") {
        const ended = await this.finish(callId, ANSWERABLE, { state: "ended", endReason: reason }, userId, "ended");
        if (ended) this.broadcastToParticipants(ended, { type: "call:end", call: ended, userId });
        return;
      }

      await this.callsRepository.transitionParticipant(callId, userId, ["joined"], "left");
      this.unbind(callId, userId);
      await this.callsRepository.addEvent(callId, userId, "left");

      const afterLeave = await this.reload(callId);
      if (this.joinedUserIds(afterLeave).length === 0) {
        const endState = afterLeave.answeredAt ? "ended" : "missed";
        const ended = await this.finish(
          callId,
          ANSWERABLE,
          { state: endState, endReason: afterLeave.answeredAt ? "all_left" : "no_answer" },
          userId,
          endState === "ended" ? "ended" : "missed"
        );
        if (ended) this.broadcastToParticipants(ended, { type: "call:end", call: ended, userId });
        return;
      }
      this.broadcastToParticipants(afterLeave, { type: "call:participant_left", call: afterLeave, userId });
    });
  }

  // ---------------------------------------------------------------------------
  // Signaling & media reports
  // ---------------------------------------------------------------------------

  private async relaySignal(
    ctx: ConnectionContext,
    event: Extract<CallClientEvent, { type: "call:offer" | "call:answer" | "call:ice_candidate" }>
  ): Promise<void> {
    const call = await this.requireLiveCall(event.callId);
    this.requireBoundConnection(call, ctx);
    if (event.toUserId === ctx.userId) throw new AppError("Cannot signal yourself", 400);

    const target = call.participants.find((p) => p.userId === event.toUserId);
    const targetConnection = this.bindings.get(call.id)?.get(event.toUserId);
    if (!target || target.state !== "joined" || !targetConnection) {
      throw new AppError("That participant is not in the call", 409);
    }

    const relay: ServerEvent =
      event.type === "call:ice_candidate"
        ? { type: "call:ice_candidate", callId: call.id, fromUserId: ctx.userId, candidate: event.candidate }
        : { type: event.type, callId: call.id, fromUserId: ctx.userId, sdp: event.sdp };

    if (event.type === "call:offer" && call.state === "accepted") {
      await this.mutex.run(call.id, () =>
        this.callsRepository.transitionSession(call.id, ["accepted"], { state: "connecting" })
      );
    }

    // SDP/ICE payloads are relayed only — never stored or logged.
    if (!this.realtimeGateway.sendToConnection(event.toUserId, targetConnection, relay)) {
      throw new AppError("That participant is not connected right now", 409);
    }
  }

  private async reportConnected(ctx: ConnectionContext, callId: string): Promise<void> {
    await this.mutex.run(callId, async () => {
      const call = await this.requireLiveCall(callId);
      this.requireBoundConnection(call, ctx);
      const changed = await this.callsRepository.transitionSession(callId, ["accepted", "connecting"], {
        state: "connected",
        connectedAt: new Date(),
      });
      if (!changed) return; // already connected (e.g. another pair in a group call)
      await this.callsRepository.addEvent(callId, ctx.userId, "connected");
      const updated = await this.reload(callId);
      this.broadcastToParticipants(updated, { type: "call:updated", call: updated });
    });
  }

  private async reportFailed(ctx: ConnectionContext, callId: string, reason: "connection_failed" | "media_error"): Promise<void> {
    const call = await this.requireLiveCall(callId);
    const participant = call.participants.find((p) => p.userId === ctx.userId);
    if (!participant) throw new AppError("You are not part of this call", 403);

    if (call.scope === "direct" || (participant.role === "initiator" && call.state === "ringing")) {
      await this.mutex.run(callId, async () => {
        const ended = await this.finish(callId, ANSWERABLE, { state: "failed", endReason: reason }, ctx.userId, "failed");
        if (ended) this.broadcastToParticipants(ended, { type: "call:failed", call: ended, userId: ctx.userId });
      });
      return;
    }

    // Group: only this participant drops out.
    await this.mutex.run(callId, async () => {
      await this.callsRepository.addEvent(callId, ctx.userId, "failed");
      const current = await this.reload(callId);
      this.broadcastToParticipants(current, { type: "call:failed", call: current, userId: ctx.userId });
    });
    await this.leave(ctx.userId, callId, reason);
  }

  private async reportMediaState(ctx: ConnectionContext, callId: string, audioEnabled: boolean, videoEnabled: boolean): Promise<void> {
    const call = await this.requireLiveCall(callId);
    this.requireBoundConnection(call, ctx);
    const states = this.mediaStates.get(callId) ?? new Map();
    states.set(ctx.userId, { audioEnabled, videoEnabled });
    this.mediaStates.set(callId, states);
    const updated = this.withMediaState(call);
    broadcast(this.realtimeGateway, this.joinedUserIds(updated), { type: "call:updated", call: updated });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle & timers
  // ---------------------------------------------------------------------------

  handleConnect(ctx: ConnectionContext): void {
    const key = `${ctx.userId}:${ctx.connectionId}`;
    const timer = this.disconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(key);
    }
  }

  /**
   * A signaling connection dropped. If it was carrying a call, give it a
   * short grace period to reconnect (same connection ID) before the user is
   * taken out of the call — so a brief network blip doesn't end it.
   */
  handleDisconnect(ctx: ConnectionContext): void {
    const boundCallIds = [...this.bindings.entries()]
      .filter(([, users]) => users.get(ctx.userId) === ctx.connectionId)
      .map(([callId]) => callId);
    if (boundCallIds.length === 0) return;

    const key = `${ctx.userId}:${ctx.connectionId}`;
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(key);
      if (this.realtimeGateway.hasConnection(ctx.userId, ctx.connectionId)) return;
      for (const callId of boundCallIds) {
        if (this.bindings.get(callId)?.get(ctx.userId) !== ctx.connectionId) continue;
        void this.leave(ctx.userId, callId, "disconnected").catch(() => undefined);
      }
    }, this.reconnectGraceMs);
    timer.unref?.();
    this.disconnectTimers.set(key, timer);
  }

  /** Ring timeout: unanswered invitees become "missed"; if nobody answered at all, so does the call. */
  async expireRinging(callId: string): Promise<void> {
    this.ringTimers.delete(callId);
    await this.mutex.run(callId, async () => {
      const call = await this.callsRepository.findById(callId);
      if (!call || !isLiveState(call.state)) return;

      await this.callsRepository.transitionParticipants(callId, ["invited", "ringing"], "missed");

      if (call.state === "ringing") {
        const ended = await this.finish(callId, ["ringing"], { state: "missed", endReason: "no_answer" }, null, "missed");
        if (ended) this.broadcastToParticipants(ended, { type: "call:end", call: ended, userId: null });
        return;
      }
      const updated = await this.reload(callId);
      this.broadcastToParticipants(updated, { type: "call:updated", call: updated });
    });
  }

  /** Startup recovery — see CallsRepository.failAllLive. */
  async recoverStaleCalls(): Promise<number> {
    return this.callsRepository.failAllLive("server_restart");
  }

  /** Clears every timer (tests / graceful shutdown). */
  dispose(): void {
    for (const timer of this.ringTimers.values()) clearTimeout(timer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.ringTimers.clear();
    this.disconnectTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Moves a live session to a terminal state: joined participants → left,
   * unanswered invitees → missed, duration computed from when media
   * connected. Returns the final call, or null if another transition won.
   */
  private async finish(
    callId: string,
    fromStates: CallState[],
    patch: { state: CallState; endReason: CallEndReason },
    actorId: string | null,
    eventType: "ended" | "declined" | "cancelled" | "missed" | "failed"
  ): Promise<CallDTO | null> {
    const current = await this.callsRepository.findById(callId);
    if (!current) return null;
    const endedAt = new Date();
    const durationSeconds = current.connectedAt
      ? Math.max(0, Math.round((endedAt.getTime() - new Date(current.connectedAt).getTime()) / 1000))
      : null;
    const sessionPatch: SessionPatch = { ...patch, endedAt, durationSeconds };

    const applied = await this.callsRepository.transitionSession(callId, fromStates, sessionPatch);
    if (!applied) return null;

    await this.callsRepository.transitionParticipants(callId, ["joined"], "left");
    await this.callsRepository.transitionParticipants(callId, ["invited", "ringing"], "missed");
    await this.callsRepository.addEvent(callId, actorId, eventType);

    this.clearRingTimer(callId);
    this.bindings.delete(callId);
    this.mediaStates.delete(callId);
    return this.reload(callId);
  }

  private async requireMember(conversationId: string, userId: string): Promise<void> {
    if (!(await this.conversationsRepository.isMember(conversationId, userId))) {
      throw new AppError("You do not have access to this conversation", 403);
    }
  }

  private async requireLiveCall(callId: string): Promise<CallDTO> {
    const call = await this.callsRepository.findById(callId);
    if (!call) throw new AppError("Call not found", 404);
    if (!isLiveState(call.state)) throw new AppError("This call has ended", 409);
    return call;
  }

  /** Signaling is only accepted from the exact device that joined the call. */
  private requireBoundConnection(call: CallDTO, ctx: ConnectionContext): void {
    const participant = call.participants.find((p) => p.userId === ctx.userId);
    if (!participant || participant.state !== "joined") throw new AppError("You are not in this call", 403);
    if (this.bindings.get(call.id)?.get(ctx.userId) !== ctx.connectionId) {
      throw new AppError("This call is active on another of your devices", 403);
    }
  }

  private async reload(callId: string): Promise<CallDTO> {
    return this.withMediaState((await this.callsRepository.findById(callId))!);
  }

  private withMediaState(call: CallDTO): CallDTO {
    const states = this.mediaStates.get(call.id);
    return {
      ...call,
      participants: call.participants.map((p) => {
        const state = p.state === "joined" ? states?.get(p.userId) : undefined;
        return { ...p, audioEnabled: state?.audioEnabled ?? null, videoEnabled: state?.videoEnabled ?? null };
      }),
    };
  }

  private joinedUserIds(call: CallDTO): string[] {
    return call.participants.filter((p) => p.state === "joined").map((p) => p.userId);
  }

  private broadcastToParticipants(call: CallDTO, event: ServerEvent): void {
    broadcast(
      this.realtimeGateway,
      call.participants.map((p) => p.userId),
      event
    );
  }

  private bind(callId: string, userId: string, connectionId: string): void {
    const users = this.bindings.get(callId) ?? new Map<string, string>();
    users.set(userId, connectionId);
    this.bindings.set(callId, users);
  }

  private unbind(callId: string, userId: string): void {
    this.bindings.get(callId)?.delete(userId);
    this.mediaStates.get(callId)?.delete(userId);
  }

  private scheduleRingTimeout(callId: string): void {
    const timer = setTimeout(() => {
      void this.expireRinging(callId).catch(() => undefined);
    }, this.ringTimeoutMs);
    timer.unref?.();
    this.ringTimers.set(callId, timer);
  }

  private clearRingTimer(callId: string): void {
    const timer = this.ringTimers.get(callId);
    if (timer) clearTimeout(timer);
    this.ringTimers.delete(callId);
  }
}

/** Describes a call from one participant's point of view, for call history. */
export function toHistoryEntry(call: CallDTO, viewerId: string): CallHistoryEntryDTO {
  const me = call.participants.find((p) => p.userId === viewerId);
  const outgoing = call.initiatorId === viewerId;
  const everJoined = !!me?.joinedAt;

  let outcome: CallOutcome;
  if (isLiveState(call.state)) {
    outcome = "ongoing";
  } else if (outgoing) {
    outcome =
      call.state === "cancelled"
        ? "cancelled"
        : call.state === "declined"
          ? "declined"
          : call.state === "missed"
            ? "no_answer"
            : call.state === "failed"
              ? "failed"
              : "completed";
  } else if (me?.state === "declined") {
    outcome = "declined";
  } else if (!everJoined) {
    outcome = "missed";
  } else {
    outcome = call.state === "failed" ? "failed" : "completed";
  }

  return { ...call, direction: outgoing ? "outgoing" : "incoming", outcome };
}

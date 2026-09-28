import type { CallDTO, CallHistoryEntryDTO, CallMedia, IceServerConfig } from "../types/call";
import { apiRequest, buildQueryString } from "./apiClient";

/**
 * REST side of calling. Starting a call is REST (so failures come back as
 * clean HTTP errors); everything after — accept, decline, SDP/ICE
 * signaling — goes over the WebSocket (see CallContext).
 */
export const callService = {
  async start(accessToken: string, conversationId: string, media: CallMedia, connectionId: string): Promise<CallDTO> {
    const { call } = await apiRequest<{ call: CallDTO }>("/calls", {
      method: "POST",
      body: { conversationId, media, connectionId },
      accessToken,
    });
    return call;
  },

  async get(accessToken: string, callId: string): Promise<CallDTO> {
    const { call } = await apiRequest<{ call: CallDTO }>(`/calls/${callId}`, { accessToken });
    return call;
  },

  async active(accessToken: string, conversationId: string): Promise<CallDTO | null> {
    const { call } = await apiRequest<{ call: CallDTO | null }>(`/calls/active${buildQueryString({ conversationId })}`, {
      accessToken,
    });
    return call;
  },

  async history(accessToken: string, conversationId?: string): Promise<CallHistoryEntryDTO[]> {
    const { calls } = await apiRequest<{ calls: CallHistoryEntryDTO[] }>(`/calls${buildQueryString({ conversationId })}`, {
      accessToken,
    });
    return calls;
  },

  /** Hang-up fallback over REST (cancel / decline / leave, whatever fits) — used if the socket is down. */
  async end(accessToken: string, callId: string): Promise<CallDTO> {
    const { call } = await apiRequest<{ call: CallDTO }>(`/calls/${callId}/end`, { method: "POST", accessToken });
    return call;
  },

  async iceServers(accessToken: string): Promise<IceServerConfig[]> {
    const { iceServers } = await apiRequest<{ iceServers: IceServerConfig[] }>("/calls/ice-servers", { accessToken });
    return iceServers;
  },
};

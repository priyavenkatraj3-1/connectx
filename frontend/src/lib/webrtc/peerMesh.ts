import type { IceCandidatePayload, IceServerConfig } from "../../types/call";
import type { CallClientEvent } from "../../types/realtime";

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

interface PeerMeshOptions {
  callId: string;
  localStream: MediaStream;
  iceServers: IceServerConfig[];
  createPeerConnection: PeerConnectionFactory;
  /** Sends a signaling event over the authenticated WebSocket. */
  sendSignal(event: CallClientEvent): void;
  onRemoteStream(userId: string, stream: MediaStream): void;
  onPeerStateChange(userId: string, state: RTCPeerConnectionState): void;
}

interface Peer {
  pc: RTCPeerConnection;
  /** ICE candidates that arrived before the remote description was set. */
  pendingCandidates: IceCandidatePayload[];
  remoteStream: MediaStream | null;
}

/**
 * One RTCPeerConnection per remote participant. For a 1:1 call that's a
 * single connection; for a group call it's a full mesh (every device
 * connects to every other), which is why group calls are capped server-side.
 *
 * Offer/answer roles are fixed by the protocol to avoid "glare": whoever
 * *joins* a call sends offers to everyone already in it, and existing
 * participants only ever answer. Media flows directly between browsers
 * (or via a TURN relay); only SDP/ICE text passes through the server.
 */
export class PeerMesh {
  private readonly peers = new Map<string, Peer>();
  private closed = false;

  constructor(private readonly options: PeerMeshOptions) {}

  private getOrCreatePeer(userId: string): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const pc = this.options.createPeerConnection({ iceServers: this.options.iceServers });
    const peer: Peer = { pc, pendingCandidates: [], remoteStream: null };
    this.peers.set(userId, peer);

    for (const track of this.options.localStream.getTracks()) {
      pc.addTrack(track, this.options.localStream);
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.closed) return;
      const c = event.candidate;
      this.options.sendSignal({
        type: "call:ice_candidate",
        callId: this.options.callId,
        toUserId: userId,
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment },
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? peer.remoteStream ?? new MediaStream();
      if (!event.streams[0]) stream.addTrack(event.track);
      peer.remoteStream = stream;
      this.options.onRemoteStream(userId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (!this.closed) this.options.onPeerStateChange(userId, pc.connectionState);
    };

    return peer;
  }

  /** We joined: offer a connection to a participant who was already in the call. */
  async connectTo(userId: string): Promise<void> {
    const peer = this.getOrCreatePeer(userId);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.options.sendSignal({ type: "call:offer", callId: this.options.callId, toUserId: userId, sdp: offer.sdp ?? "" });
  }

  async handleOffer(fromUserId: string, sdp: string): Promise<void> {
    const peer = this.getOrCreatePeer(fromUserId);
    await peer.pc.setRemoteDescription({ type: "offer", sdp });
    await this.flushCandidates(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.options.sendSignal({ type: "call:answer", callId: this.options.callId, toUserId: fromUserId, sdp: answer.sdp ?? "" });
  }

  async handleAnswer(fromUserId: string, sdp: string): Promise<void> {
    const peer = this.peers.get(fromUserId);
    if (!peer) return;
    await peer.pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushCandidates(peer);
  }

  async handleCandidate(fromUserId: string, candidate: IceCandidatePayload): Promise<void> {
    const peer = this.getOrCreatePeer(fromUserId);
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    await peer.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const pending = peer.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await peer.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  /** A participant left: drop their connection. */
  remove(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(userId);
  }

  has(userId: string): boolean {
    return this.peers.has(userId);
  }

  closeAll(): void {
    this.closed = true;
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
  }
}

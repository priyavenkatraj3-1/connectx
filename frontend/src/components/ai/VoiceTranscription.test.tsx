import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIProvider } from "../../context/AIContext";
import { AuthProvider } from "../../context/AuthContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { aiService } from "../../services/aiService";
import { aiSettingsResponse } from "../../tests/aiFixtures";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { VoiceResult } from "../../types/ai";
import type { MessageDTO } from "../../types/message";
import { MessageAITools } from "./MessageAITools";

vi.mock("../../services/aiService", () => ({
  aiService: {
    getSettings: vi.fn(),
    listExclusions: vi.fn(),
    listActions: vi.fn(),
    getVoice: vi.fn(),
    transcribe: vi.fn(),
    analyzeVoice: vi.fn(),
    listVoiceTranslations: vi.fn(() => Promise.resolve([])),
    translateVoice: vi.fn(),
  },
}));

const voiceMessage: MessageDTO = {
  id: "msg-v",
  conversationId: "conv-1",
  senderId: "user-2",
  sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null },
  contentType: "audio",
  body: null,
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
  attachment: {
    id: "att-v",
    conversationId: "conv-1",
    messageId: "msg-v",
    uploaderId: "user-2",
    kind: "audio",
    mimeType: "audio/ogg",
    sizeBytes: 2048,
    originalFilename: "voice.ogg",
    createdAt: new Date().toISOString(),
  } as MessageDTO["attachment"],
};

function result(overrides: Partial<VoiceResult>): VoiceResult {
  return {
    attachmentId: "att-v",
    status: "complete",
    transcript: null,
    detectedLanguage: null,
    summary: null,
    actionItems: [],
    errorMessage: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderTools(wrapper?: (children: ReactNode) => ReactNode) {
  const tree = <MessageAITools message={voiceMessage} isOwn={false} />;
  render(
    <AuthProvider>
      <RealtimeProvider>
        <MemoryRouter>
          <AIProvider>{wrapper ? wrapper(tree) : tree}</AIProvider>
        </MemoryRouter>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("Voice message transcription UI", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    seedAuthenticatedSession();
    vi.mocked(aiService.listExclusions).mockResolvedValue([]);
    vi.mocked(aiService.listActions).mockResolvedValue([]);
    vi.mocked(aiService.getVoice).mockResolvedValue(null);
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({}, { transcriptionConfigured: true }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("transcribes on request in the chosen language, shows progress, then the transcript beneath the audio", async () => {
    let finish!: (r: VoiceResult) => void;
    vi.mocked(aiService.transcribe).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderTools();

    const select = await screen.findByRole("combobox", { name: "Language of the voice message" });
    expect(within(select).getByRole("option", { name: "Auto-detect language" })).toBeInTheDocument();
    await user.selectOptions(select, "es");
    await user.click(screen.getByRole("button", { name: "Transcribe" }));

    expect(aiService.transcribe).toHaveBeenCalledWith("test-access-token", "att-v", "es");
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing…");
    // A second click while it's running can't start another request.
    expect(screen.getByRole("button", { name: "Transcribe…" })).toBeDisabled();

    finish(result({ transcript: "Hola, nos vemos el viernes", detectedLanguage: "es" }));
    const panel = await screen.findByLabelText("Voice message transcript");
    expect(panel).toHaveTextContent("Hola, nos vemos el viernes");
    expect(panel).toHaveTextContent("Spanish");
    expect(aiService.transcribe).toHaveBeenCalledTimes(1);
  });

  it("auto-detect sends no language hint", async () => {
    vi.mocked(aiService.transcribe).mockResolvedValue(result({ transcript: "Hi" }));
    const user = userEvent.setup();
    renderTools();
    await user.click(await screen.findByRole("button", { name: "Transcribe" }));
    expect(aiService.transcribe).toHaveBeenCalledWith("test-access-token", "att-v", undefined);
  });

  it("copies the transcript, and says so if the clipboard is unavailable", async () => {
    vi.mocked(aiService.getVoice).mockResolvedValue(result({ transcript: "Call me back" }));
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    const user = userEvent.setup();
    renderTools();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await user.click(await screen.findByRole("button", { name: "Copy transcript" }));
    expect(writeText).toHaveBeenCalledWith("Call me back");
    expect(screen.getByRole("button", { name: "Copy transcript" })).toHaveTextContent("Copied");

    await user.click(screen.getByRole("button", { name: "Copy transcript" }));
    expect(await screen.findByText("Couldn't copy — select the text instead.")).toBeInTheDocument();
  });

  it("shows errors with a retry, and an empty result as 'no speech'", async () => {
    vi.mocked(aiService.getVoice).mockResolvedValue(result({ status: "failed", errorMessage: "Transcription failed. Please try again." }));
    vi.mocked(aiService.transcribe)
      .mockResolvedValueOnce(result({ status: "failed", errorMessage: "No speech was recognized in this voice message." }))
      .mockResolvedValueOnce(result({ transcript: "Got it this time" }));
    const user = userEvent.setup();
    renderTools();

    expect(await screen.findByText("Transcription failed. Please try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No speech was recognized — try again, or pick the language/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Got it this time")).toBeInTheDocument();
    expect(aiService.transcribe).toHaveBeenCalledTimes(2);
  });

  it("shows the server's reason when a request is refused (too large, unsupported, rate limited, timeout)", async () => {
    vi.mocked(aiService.transcribe).mockRejectedValue(new ApiError("This audio format can't be transcribed", 415));
    const user = userEvent.setup();
    renderTools();
    await user.click(await screen.findByRole("button", { name: "Transcribe" }));
    expect(await screen.findByText("This audio format can't be transcribed")).toBeInTheDocument();
  });

  it("is opt-in: without Voice Intelligence on there's no Transcribe action, only where to turn it on", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ voiceEnabled: false }, { transcriptionConfigured: true }));
    renderTools();
    expect(await screen.findByText("To transcribe voice messages, turn on Voice Intelligence in Settings → AI Features.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transcribe" })).not.toBeInTheDocument();
    expect(aiService.getVoice).not.toHaveBeenCalled();
  });

  it("offers nothing when the server has no transcription provider", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({}, { transcriptionConfigured: false }));
    renderTools();
    await waitFor(() => expect(aiService.getSettings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Transcribe" })).not.toBeInTheDocument();
    expect(screen.queryByText(/turn on Voice Intelligence/)).not.toBeInTheDocument();
  });
});

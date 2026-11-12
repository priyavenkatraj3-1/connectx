import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIProvider } from "../../context/AIContext";
import { AuthProvider } from "../../context/AuthContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { aiService } from "../../services/aiService";
import { mediaService } from "../../services/mediaService";
import { aiSettingsResponse } from "../../tests/aiFixtures";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { VoiceResult, VoiceTranslationResult } from "../../types/ai";
import type { MessageDTO } from "../../types/message";
import { AttachmentView } from "../media/AttachmentView";
import { MessageAITools } from "./MessageAITools";

vi.mock("../../services/aiService", () => ({
  aiService: {
    getSettings: vi.fn(),
    listExclusions: vi.fn(),
    listActions: vi.fn(),
    getVoice: vi.fn(),
    transcribe: vi.fn(),
    analyzeVoice: vi.fn(),
    listVoiceTranslations: vi.fn(),
    translateVoice: vi.fn(),
  },
}));

// The audio player loads its bytes through mediaService; serve a fake clip so nothing hits the network.
vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { upload: vi.fn(), remove: vi.fn(), fetchContent: vi.fn() } };
});

/** Swaps a static URL method (jsdom has no object URLs) and returns a function that puts the original back. */
function stubUrlMethod<K extends "createObjectURL" | "revokeObjectURL">(name: K, impl: (typeof URL)[K]): () => void {
  const original = Object.getOwnPropertyDescriptor(URL, name);
  Object.defineProperty(URL, name, { configurable: true, writable: true, value: impl });
  return () => {
    if (original) Object.defineProperty(URL, name, original);
    else delete (URL as unknown as Record<string, unknown>)[name];
  };
}

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

const NATIVE: Record<string, string> = {
  ta: "வெள்ளிக்கிழமை சந்திப்போம்",
  en: "See you on Friday",
  hi: "शुक्रवार को मिलते हैं",
  te: "శుక్రవారం కలుద్దాం",
  ml: "വെള്ളിയാഴ്ച കാണാം",
};

function voice(overrides: Partial<VoiceResult> = {}): VoiceResult {
  return {
    attachmentId: "att-v",
    status: "complete",
    transcript: "Nos vemos el viernes",
    detectedLanguage: "es",
    summary: null,
    actionItems: [],
    errorMessage: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function translation(targetLanguage: string, overrides: Partial<VoiceTranslationResult> = {}): VoiceTranslationResult {
  return {
    attachmentId: "att-v",
    targetLanguage,
    translatedText: NATIVE[targetLanguage]!,
    detectedSourceLanguage: "es",
    cached: false,
    generatedBy: { provider: "gemini", model: "gemini-test-model" },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The bubble as ChatConversationPage renders it: the audio player, then the AI tools. */
function renderVoiceBubble() {
  render(
    <AuthProvider>
      <RealtimeProvider>
        <MemoryRouter>
          <AIProvider>
            <AttachmentView attachment={voiceMessage.attachment!} isOwn={false} />
            <MessageAITools message={voiceMessage} isOwn={false} />
          </AIProvider>
        </MemoryRouter>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("Voice message translation UI", () => {
  let restoreUrlMethods: Array<() => void> = [];

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    seedAuthenticatedSession();
    vi.mocked(mediaService.fetchContent).mockResolvedValue(new Blob(["OggS"], { type: "audio/ogg" }));
    restoreUrlMethods = [stubUrlMethod("createObjectURL", vi.fn(() => "blob:voice")), stubUrlMethod("revokeObjectURL", vi.fn())];
    vi.mocked(aiService.listExclusions).mockResolvedValue([]);
    vi.mocked(aiService.listActions).mockResolvedValue([]);
    vi.mocked(aiService.getVoice).mockResolvedValue(voice());
    vi.mocked(aiService.listVoiceTranslations).mockResolvedValue([]);
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ preferredLanguage: "es" }, { transcriptionConfigured: true }));
  });

  afterEach(() => {
    // Unmount first: unmounting revokes object URLs, so the stubs must still be in place.
    cleanup();
    restoreUrlMethods.forEach((restore) => restore());
  });

  it("offers exactly Tamil, English, Hindi, Telugu and Malayalam", async () => {
    renderVoiceBubble();
    const select = await screen.findByRole("combobox", { name: "Translate to" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Tamil", "English", "Hindi", "Telugu", "Malayalam"]);
    // Spanish preferred language isn't a voice target, so English is the default.
    expect(select).toHaveValue("en");
  });

  it.each(Object.keys(NATIVE))("translates into %s and shows it under the original transcript, with the audio kept", async (code) => {
    let finish!: (t: VoiceTranslationResult) => void;
    vi.mocked(aiService.translateVoice).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderVoiceBubble();

    await user.selectOptions(await screen.findByRole("combobox", { name: "Translate to" }), code);
    await user.click(screen.getByRole("button", { name: "Translate" }));
    expect(aiService.translateVoice).toHaveBeenCalledWith("test-access-token", "att-v", code);
    expect(screen.getByRole("status")).toHaveTextContent("Translating to");
    expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();

    finish(translation(code));
    const panel = await screen.findByLabelText("Voice message translation");
    expect(panel).toHaveTextContent(NATIVE[code]!);
    expect(within(panel).getByText(NATIVE[code]!)).toHaveAttribute("lang", code);
    // Original transcript and audio are still shown, unchanged.
    expect(screen.getByLabelText("Voice message transcript")).toHaveTextContent("Nos vemos el viernes");
    expect(screen.getByLabelText("voice.ogg")).toBeInTheDocument();
    expect(aiService.translateVoice).toHaveBeenCalledTimes(1);
  });

  it("shows stored translations without a provider call, and reuses one already shown", async () => {
    vi.mocked(aiService.listVoiceTranslations).mockResolvedValue([translation("ta", { cached: true, generatedBy: null })]);
    const user = userEvent.setup();
    renderVoiceBubble();

    const panel = await screen.findByLabelText("Voice message translation");
    expect(panel).toHaveTextContent(NATIVE.ta!);
    expect(panel).toHaveTextContent("saved result");

    await user.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.queryByLabelText("Voice message translation")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Translate to" }), "ta");
    await user.click(screen.getByRole("button", { name: "Translate" }));
    expect(await screen.findByLabelText("Voice message translation")).toHaveTextContent(NATIVE.ta!);
    expect(aiService.translateVoice).not.toHaveBeenCalled();
  });

  it("shows server errors (consent, exclusion, provider unavailable) and keeps the transcript", async () => {
    vi.mocked(aiService.translateVoice)
      .mockRejectedValueOnce(new ApiError("This conversation is excluded from AI in your settings", 400, "ai_conversation_excluded"))
      .mockRejectedValueOnce(new ApiError("AI features aren't configured on this server yet.", 503, "ai_not_configured"));
    const user = userEvent.setup();
    renderVoiceBubble();

    await user.click(await screen.findByRole("button", { name: "Translate" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("excluded from AI");
    expect(within(alert).getByRole("link", { name: "Open AI settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate" }));
    expect(await screen.findByText("AI features aren't configured on this server yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Voice message transcript")).toHaveTextContent("Nos vemos el viernes");
    expect(screen.queryByLabelText("Voice message translation")).not.toBeInTheDocument();
  });

  it("isn't offered before there is a transcript, without Voice Intelligence, or without a text provider", async () => {
    vi.mocked(aiService.getVoice).mockResolvedValue(null);
    const { unmount } = render(
      <AuthProvider>
        <RealtimeProvider>
          <MemoryRouter>
            <AIProvider>
              <MessageAITools message={voiceMessage} isOwn={false} />
            </AIProvider>
          </MemoryRouter>
        </RealtimeProvider>
      </AuthProvider>
    );
    expect(await screen.findByRole("button", { name: "Transcribe" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Translate to" })).not.toBeInTheDocument();
    unmount();

    vi.mocked(aiService.getVoice).mockResolvedValue(voice());
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({}, { transcriptionConfigured: true, providerConfigured: false }));
    renderVoiceBubble();
    expect(await screen.findByText("Nos vemos el viernes")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Translate to" })).not.toBeInTheDocument();
    await waitFor(() => expect(aiService.translateVoice).not.toHaveBeenCalled());
  });

  it("never loads or sends anything while Voice Intelligence is off", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ voiceEnabled: false }, { transcriptionConfigured: true }));
    renderVoiceBubble();
    expect(await screen.findByText(/turn on Voice Intelligence/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Translate to" })).not.toBeInTheDocument();
    expect(aiService.listVoiceTranslations).not.toHaveBeenCalled();
    expect(aiService.translateVoice).not.toHaveBeenCalled();
  });
});

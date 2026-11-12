import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIProvider } from "../../context/AIContext";
import { AuthProvider } from "../../context/AuthContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { aiService } from "../../services/aiService";
import { aiSettingsResponse } from "../../tests/aiFixtures";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { MessageDTO } from "../../types/message";
import { ConversationAIPanel } from "./ConversationAIPanel";
import { MessageAITools } from "./MessageAITools";

vi.mock("../../services/aiService", () => ({
  aiService: {
    getSettings: vi.fn(),
    listExclusions: vi.fn(),
    setExclusion: vi.fn(),
    ask: vi.fn(),
    listActions: vi.fn(),
    extractActions: vi.fn(),
    confirmAction: vi.fn(),
    dismissAction: vi.fn(),
    updateAction: vi.fn(),
    translate: vi.fn(),
    scamCheck: vi.fn(),
    safetyFeedback: vi.fn(),
    createMemory: vi.fn(),
    getVoice: vi.fn(),
    listVoiceTranslations: vi.fn(() => Promise.resolve([])),
    translateVoice: vi.fn(),
  },
}));

function wrap(children: ReactNode) {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <MemoryRouter>
          <AIProvider>{children}</AIProvider>
        </MemoryRouter>
      </RealtimeProvider>
    </AuthProvider>
  );
}

const message: MessageDTO = {
  id: "msg-1",
  conversationId: "conv-1",
  senderId: "user-2",
  sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null },
  contentType: "text",
  body: "Hola, ¿nos vemos mañana?",
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
  replyTo: null,
  mentions: [],
  attachment: null,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  seedAuthenticatedSession();
  vi.mocked(aiService.listExclusions).mockResolvedValue([]);
  vi.mocked(aiService.listActions).mockResolvedValue([]);
});

describe("Ask Your Chats (conversation panel)", () => {
  it("shows the answer with its real source messages and an AI-generated label", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    vi.mocked(aiService.ask).mockResolvedValue({
      status: "answered",
      answer: "You agreed to meet on Friday.",
      sources: [
        {
          ref: "M2",
          messageId: "msg-9",
          conversationId: "conv-1",
          conversationTitle: "Chat with Grace Hopper",
          senderName: "Grace Hopper",
          createdAt: new Date().toISOString(),
          excerpt: "Friday works for me",
        },
      ],
      generatedBy: { provider: "anthropic", model: "claude-opus-5" },
      contextMessageCount: 12,
      usedMemory: false,
    });
    wrap(<ConversationAIPanel conversationId="conv-1" isGroup={false} onClose={() => undefined} />);

    await userEvent.type(await screen.findByLabelText("Question about your chats"), "When do we meet?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("You agreed to meet on Friday.")).toBeInTheDocument();
    expect(screen.getByText("“Friday works for me”")).toBeInTheDocument();
    expect(screen.getByText(/AI-generated · claude-opus-5/)).toBeInTheDocument();
    expect(aiService.ask).toHaveBeenCalledWith("test-access-token", {
      question: "When do we meet?",
      conversationIds: ["conv-1"],
      useMemory: true,
    });
  });

  it("explains that AI is off instead of offering features", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ aiFeaturesEnabled: false }));
    wrap(<ConversationAIPanel conversationId="conv-1" isGroup={false} onClose={() => undefined} />);

    expect(await screen.findByText(/AI features are off/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Question about your chats")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open AI settings" })).toHaveAttribute("href", "/app/settings");
  });

  it("shows the server's coded error (e.g. provider unavailable) without crashing", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    vi.mocked(aiService.ask).mockRejectedValue(
      new ApiError("The AI service took too long to respond. Please try again.", 504, "ai_timeout")
    );
    wrap(<ConversationAIPanel conversationId="conv-1" isGroup={false} onClose={() => undefined} />);

    await userEvent.type(await screen.findByLabelText("Question about your chats"), "Anything?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
  });

  it("offers Group Decision AI only for groups", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    const { unmount } = wrap(<ConversationAIPanel conversationId="conv-1" isGroup={false} onClose={() => undefined} />);
    await screen.findByRole("tab", { name: "Ask" });
    expect(screen.queryByRole("tab", { name: "Decisions" })).not.toBeInTheDocument();
    unmount();

    wrap(<ConversationAIPanel conversationId="conv-1" isGroup onClose={() => undefined} />);
    expect(await screen.findByRole("tab", { name: "Decisions" })).toBeInTheDocument();
  });
});

describe("Smart Actions", () => {
  it("lists suggestions and only confirms on explicit user action", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    const now = new Date().toISOString();
    const suggestion = {
      id: "act-1",
      conversationId: "conv-1",
      sourceMessageId: "msg-1",
      type: "task" as const,
      title: "Send the report",
      notes: null,
      dueAt: null,
      dueText: "Friday",
      timezone: null,
      participants: [],
      confidence: "high" as const,
      explanation: "Grace asked for it.",
      status: "suggested" as const,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    vi.mocked(aiService.extractActions).mockResolvedValue({
      actions: [suggestion],
      generatedBy: { provider: "anthropic", model: "claude-opus-5" },
      messageCount: 5,
    });
    vi.mocked(aiService.confirmAction).mockResolvedValue({ ...suggestion, status: "confirmed", confirmedAt: now });
    wrap(<ConversationAIPanel conversationId="conv-1" isGroup={false} onClose={() => undefined} />);

    await userEvent.click(await screen.findByRole("tab", { name: "Actions" }));
    await userEvent.click(screen.getByRole("button", { name: "Find actions in this chat" }));

    expect(await screen.findByText("Send the report")).toBeInTheDocument();
    expect(screen.getByText("Due: Friday")).toBeInTheDocument();
    expect(aiService.confirmAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Confirmed")).toBeInTheDocument();
    expect(aiService.confirmAction).toHaveBeenCalledWith("test-access-token", "act-1");
  });
});

describe("MessageAITools", () => {
  it("renders nothing (and calls nothing) while AI features are off", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(
      aiSettingsResponse({ aiFeaturesEnabled: false, aiMemoryEnabled: false, spamShieldEnabled: false, voiceEnabled: false })
    );
    wrap(<MessageAITools message={message} isOwn={false} />);

    await waitFor(() => expect(aiService.getSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("message-ai-tools")).not.toBeInTheDocument();
    expect(aiService.translate).not.toHaveBeenCalled();
  });

  describe("text translation target language", () => {
    const englishMessage: MessageDTO = { ...message, id: "msg-en", body: "See you tomorrow" };
    const result = (targetLanguage: string, translatedText: string, detectedSourceLanguage: string | null = "en") => ({
      messageId: "msg-en",
      targetLanguage,
      translatedText,
      detectedSourceLanguage,
      cached: false,
      generatedBy: { provider: "gemini", model: "gemini-3.5-flash-lite" },
    });

    it("offers exactly Tamil, English, Hindi, Telugu and Malayalam, defaulting to Tamil when the preferred language isn't one of them", async () => {
      vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ preferredLanguage: "es" }));
      vi.mocked(aiService.translate).mockResolvedValue(result("ta", "நாளை சந்திப்போம்"));
      wrap(<MessageAITools message={englishMessage} isOwn={false} />);

      const picker = await screen.findByRole("combobox", { name: "Translate message to" });
      expect([...(picker as HTMLSelectElement).options].map((o) => o.value)).toEqual(["ta", "en", "hi", "te", "ml"]);
      expect(picker).toHaveValue("ta");

      await userEvent.click(screen.getByRole("button", { name: "Translate" }));

      expect(aiService.translate).toHaveBeenCalledWith("test-access-token", "msg-en", "ta");
      const panel = await screen.findByLabelText("Translation");
      expect(panel).toHaveTextContent("நாளை சந்திப்போம்");
      expect(panel).toHaveTextContent("Translated to Tamil from en");
      // The original message is left as it was; the translation is shown separately.
      expect(englishMessage.body).toBe("See you tomorrow");
    });

    it("defaults to the preferred language when it's one of the five and differs from the source", async () => {
      vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ preferredLanguage: "hi" }));
      vi.mocked(aiService.translate).mockResolvedValue(result("hi", "कल मिलते हैं"));
      wrap(<MessageAITools message={englishMessage} isOwn={false} />);

      expect(await screen.findByRole("combobox", { name: "Translate message to" })).toHaveValue("hi");
      await userEvent.click(screen.getByRole("button", { name: "Translate" }));

      expect(aiService.translate).toHaveBeenCalledWith("test-access-token", "msg-en", "hi");
      expect(await screen.findByText("कल मिलते हैं")).toBeInTheDocument();
    });

    it("sends the language the user picks", async () => {
      vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ preferredLanguage: "en" }));
      vi.mocked(aiService.translate).mockResolvedValue(result("ml", "നാളെ കാണാം"));
      wrap(<MessageAITools message={englishMessage} isOwn={false} />);

      // English is preferred but the text is (assumed) English, so the default is Tamil, not a no-op English → English.
      const picker = await screen.findByRole("combobox", { name: "Translate message to" });
      expect(picker).toHaveValue("ta");
      await userEvent.selectOptions(picker, "ml");
      await userEvent.click(screen.getByRole("button", { name: "Translate" }));

      expect(aiService.translate).toHaveBeenCalledWith("test-access-token", "msg-en", "ml");
      expect(await screen.findByText("നാളെ കാണാം")).toBeInTheDocument();
    });

    it("says the message is already in the chosen language instead of repeating it", async () => {
      vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ preferredLanguage: "en" }));
      vi.mocked(aiService.translate).mockResolvedValue(result("en", "See you tomorrow"));
      wrap(<MessageAITools message={englishMessage} isOwn={false} />);

      await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Translate message to" }), "en");
      await userEvent.click(screen.getByRole("button", { name: "Translate" }));

      expect(aiService.translate).toHaveBeenCalledWith("test-access-token", "msg-en", "en");
      expect(await screen.findByText("This message is already in English. Choose another language.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Translation")).not.toBeInTheDocument();
    });
  });

  it("shows a local scam warning with an explanation, and records a dismissal", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    vi.mocked(aiService.safetyFeedback).mockResolvedValue(undefined);
    const onHandled = vi.fn();
    wrap(
      <MessageAITools
        message={message}
        isOwn={false}
        onFindingHandled={onHandled}
        finding={{
          messageId: "msg-1",
          riskLevel: "high_risk",
          signals: [{ type: "credential_request", description: "Asks for a password or one-time code." }],
          links: [],
        }}
      />
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("High risk");
    expect(alert).toHaveTextContent("Asks for a password or one-time code.");
    expect(alert).toHaveTextContent("it can be wrong");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(onHandled).toHaveBeenCalledWith("msg-1"));
    expect(aiService.safetyFeedback).toHaveBeenCalledWith("test-access-token", "msg-1", "dismissed");
  });
});

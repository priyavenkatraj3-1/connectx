import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIProvider } from "../../context/AIContext";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { aiService } from "../../services/aiService";
import { conversationService } from "../../services/conversationService";
import { aiSettingsResponse } from "../../tests/aiFixtures";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import { AISettingsPanel } from "./AISettingsPanel";

vi.mock("../../services/aiService", () => ({
  aiService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    listExclusions: vi.fn(),
    setExclusion: vi.fn(),
    listMemories: vi.fn(),
    createMemory: vi.fn(),
    deleteMemory: vi.fn(),
    clearMemories: vi.fn(),
  },
}));
vi.mock("../../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn() },
}));

function renderPanel() {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter>
            <AIProvider>
              <AISettingsPanel />
            </AIProvider>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("AISettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([]);
    vi.mocked(aiService.listExclusions).mockResolvedValue([]);
    vi.mocked(aiService.listMemories).mockResolvedValue({ enabled: false, items: [] });
  });

  it("shows every feature off by default and an honest 'not configured' notice", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(
      aiSettingsResponse(
        { aiFeaturesEnabled: false, aiMemoryEnabled: false, chatRetrievalEnabled: false, spamShieldEnabled: false, voiceEnabled: false },
        { providerConfigured: false }
      )
    );
    renderPanel();

    expect(await screen.findByRole("switch", { name: "AI features" })).not.toBeChecked();
    expect(screen.getByText(/aren't configured on this server yet/)).toBeInTheDocument();
    // Features that need the master switch can't be turned on while it's off.
    expect(screen.getByRole("switch", { name: "Let AI read my chats" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Voice Intelligence" })).toBeDisabled();
    expect(screen.getByText("Translation sends only the one message you ask to translate.")).toBeInTheDocument();
  });

  it("saves consent changes through the API", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse({ aiFeaturesEnabled: false }));
    vi.mocked(aiService.updateSettings).mockResolvedValue(aiSettingsResponse({ aiFeaturesEnabled: true }));
    renderPanel();

    await userEvent.click(await screen.findByRole("switch", { name: "AI features" }));

    expect(aiService.updateSettings).toHaveBeenCalledWith("test-access-token", { aiFeaturesEnabled: true });
    await waitFor(() => expect(screen.getByRole("switch", { name: "AI features" })).toBeChecked());
  });

  it("adds and deletes explicit memories", async () => {
    vi.mocked(aiService.getSettings).mockResolvedValue(aiSettingsResponse());
    vi.mocked(aiService.listMemories).mockResolvedValue({ enabled: true, items: [] });
    const now = new Date().toISOString();
    vi.mocked(aiService.createMemory).mockResolvedValue({
      id: "mem-1",
      type: "preference",
      content: "I prefer mornings",
      sourceConversationId: null,
      sourceMessageId: null,
      createdAt: now,
      updatedAt: now,
    });
    vi.mocked(aiService.deleteMemory).mockResolvedValue(undefined);
    renderPanel();

    await userEvent.type(await screen.findByLabelText("New memory"), "I prefer mornings");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(aiService.createMemory).toHaveBeenCalledWith("test-access-token", { type: "preference", content: "I prefer mornings" });
    expect(await screen.findByText("I prefer mornings")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete memory: I prefer mornings" }));
    await waitFor(() => expect(screen.queryByText("I prefer mornings")).not.toBeInTheDocument());
    expect(aiService.deleteMemory).toHaveBeenCalledWith("test-access-token", "mem-1");
  });
});

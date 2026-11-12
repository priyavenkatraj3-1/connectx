import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../services/apiClient";
import { messageService } from "../../services/messageService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { MessageDTO } from "../../types/message";
import { highlightMatches, MessageSearchPanel, SEARCH_DEBOUNCE_MS } from "./MessageSearchPanel";

vi.mock("../../services/messageService", () => ({ messageService: { search: vi.fn() } }));

function msg(id: string, body: string): MessageDTO {
  return {
    id,
    conversationId: "conv-1",
    senderId: "user-2",
    sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null },
    contentType: "text",
    body,
    status: "sent",
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
}

function renderPanel(loaded: string[] = []) {
  const handlers = { onJumpToMessage: vi.fn(), onClose: vi.fn() };
  render(
    <AuthProvider>
      <MessageSearchPanel conversationId="conv-1" loadedMessageIds={new Set(loaded)} {...handlers} />
    </AuthProvider>
  );
  return handlers;
}

const type = (text: string) => fireEvent.change(screen.getByRole("searchbox"), { target: { value: text } });
const settle = () => act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));

describe("MessageSearchPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(messageService.search).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("searches once typing pauses, highlights matches, and jumps to loaded messages", async () => {
    vi.mocked(messageService.search).mockResolvedValue([msg("m2", "The Project doc"), msg("m1", "project kickoff")]);
    const { onJumpToMessage } = renderPanel(["m2"]);
    expect(screen.getByRole("searchbox")).toHaveFocus();

    type("pro");
    type("project");
    expect(messageService.search).not.toHaveBeenCalled();
    await settle();
    expect(messageService.search).toHaveBeenCalledTimes(1);
    expect(messageService.search).toHaveBeenCalledWith("test-access-token", "conv-1", "project");

    const marks = screen.getAllByText(/project/i, { selector: "mark" });
    expect(marks.map((m) => m.textContent)).toEqual(["Project", "project"]);

    const [loaded, older] = screen.getAllByRole("button", { name: /Grace Hopper/ });
    fireEvent.click(loaded!);
    expect(onJumpToMessage).toHaveBeenCalledWith("m2");
    expect(older).toBeDisabled();
    expect(screen.getByText("Older message — not loaded in this view")).toBeInTheDocument();
  });

  it("says when nothing matches and shows server errors", async () => {
    vi.mocked(messageService.search).mockResolvedValueOnce([]);
    renderPanel();
    type("zebra");
    await settle();
    expect(screen.getByText("No messages match “zebra”.")).toBeInTheDocument();

    vi.mocked(messageService.search).mockRejectedValueOnce(new ApiError("Too many searches in a short time. Please wait a moment.", 429));
    type("zebras");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many searches");
  });

  it("ignores a slower response for an earlier query, and doesn't search blank text", async () => {
    let finishFirst!: (results: MessageDTO[]) => void;
    vi.mocked(messageService.search)
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce([msg("m9", "second query hit")]);
    renderPanel();

    type("first");
    await settle();
    type("second");
    await settle();
    await act(async () => finishFirst([msg("m1", "first query hit")]));

    expect(screen.getByRole("button", { name: /second query hit/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /first query hit/ })).not.toBeInTheDocument();

    type("   ");
    await settle();
    expect(messageService.search).toHaveBeenCalledTimes(2);
  });

  it("Escape in the search box closes the panel", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("highlightMatches", () => {
  it("marks every case-insensitive occurrence and leaves the rest as text", () => {
    render(<p data-testid="out">{highlightMatches("a.b A.B c", "a.b")}</p>);
    expect(screen.getByTestId("out").innerHTML).toBe(
      '<mark class="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-700">a.b</mark> <mark class="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-700">A.B</mark> c'
    );
  });
});

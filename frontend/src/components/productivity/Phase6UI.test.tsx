import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsPanel } from "../ai/ActionsPanel";
import { MessageComposer } from "../chat/MessageComposer";
import { AuthProvider, useAuth } from "../../context/AuthContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { useWorkspace, WorkspaceProvider } from "../../context/WorkspaceContext";
import { aiService } from "../../services/aiService";
import { apiRequest, ApiError, NetworkError } from "../../services/apiClient";
import { messageService } from "../../services/messageService";
import {
  businessService,
  eventService,
  notificationService,
  preferencesService,
  reminderService,
  taskService,
} from "../../services/productivityService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { AIAction } from "../../types/ai";
import type { AppNotification, QuickReply, Task, UserPreferences } from "../../types/productivity";
import { ItemFormModal } from "./ItemFormModal";
import { TaskPanel } from "./TaskPanel";

vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/aiService", () => ({
  aiService: { listActions: vi.fn(), extractActions: vi.fn(), confirmAction: vi.fn(), dismissAction: vi.fn(), updateAction: vi.fn() },
}));
vi.mock("../../services/productivityService", () => ({
  taskService: { list: vi.fn(), create: vi.fn(), update: vi.fn(), complete: vi.fn(), reopen: vi.fn(), remove: vi.fn() },
  reminderService: { create: vi.fn() },
  eventService: { create: vi.fn() },
  notificationService: { list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(), remove: vi.fn() },
  preferencesService: { get: vi.fn(), update: vi.fn(), focused: vi.fn(), setFocused: vi.fn() },
  businessService: { quickReplies: vi.fn() },
}));

const PREFS: UserPreferences = {
  timezone: "Asia/Tokyo",
  productivityMode: false,
  notifyMentions: true,
  notifyTaskDue: true,
  notifyReminders: true,
  notifyScheduledMessages: true,
  notifyAssignments: true,
  updatedAt: null,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    ownerId: "user-1",
    owner: { id: "user-1", displayName: "Test User" },
    assignee: null,
    title: "Send the report",
    description: null,
    status: "todo",
    priority: "high",
    dueAt: null,
    reminderAt: null,
    timezone: null,
    source: { conversationId: null, messageId: null, actionId: null, messageExcerpt: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function withProviders(children: ReactNode, realtime = createFakeRealtime()) {
  const utils = render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <MemoryRouter>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </MemoryRouter>
      </RealtimeContext.Provider>
    </AuthProvider>
  );
  return { ...utils, realtime };
}

beforeEach(() => {
  localStorage.clear();
  seedAuthenticatedSession();
  vi.mocked(preferencesService.get).mockResolvedValue(PREFS);
  vi.mocked(preferencesService.focused).mockResolvedValue([]);
  vi.mocked(businessService.quickReplies).mockResolvedValue([]);
  vi.mocked(notificationService.list).mockResolvedValue({ notifications: [], unreadCount: 0 });
  vi.mocked(taskService.list).mockReset().mockResolvedValue([]);
  vi.mocked(taskService.create).mockReset();
  vi.mocked(taskService.complete).mockReset();
  vi.mocked(messageService.send).mockReset();
});

describe("MessageComposer — offline queue, quick replies, scheduling", () => {
  function renderComposer(props: Partial<Parameters<typeof MessageComposer>[0]>) {
    return render(
      <AuthProvider>
        <MessageComposer
          conversationId="conv-1"
          mentionCandidates={[]}
          replyingTo={null}
          onCancelReply={vi.fn()}
          editing={null}
          onCancelEdit={vi.fn()}
          onSent={vi.fn()}
          onEdited={vi.fn()}
          {...props}
        />
      </AuthProvider>
    );
  }

  it("queues a text message instead of sending while offline", async () => {
    const queue = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderComposer({ offlineQueue: { isOnline: false, queue } });

    await user.type(screen.getByLabelText("Message"), "see you soon{Enter}");
    await waitFor(() => expect(queue).toHaveBeenCalledWith({ body: "see you soon", replyToMessageId: undefined, mentionedUserIds: undefined }));
    expect(messageService.send).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("will be sent when you reconnect");
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("queues with the same idempotency key when the connection drops mid-send", async () => {
    vi.mocked(messageService.send).mockRejectedValue(new NetworkError("offline", "22222222-2222-4222-8222-222222222222"));
    const queue = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderComposer({ offlineQueue: { isOnline: true, queue } });

    await user.type(screen.getByLabelText("Message"), "hello{Enter}");
    await waitFor(() => expect(queue).toHaveBeenCalledWith(expect.objectContaining({ body: "hello", clientMessageId: "22222222-2222-4222-8222-222222222222" })));
  });

  it("does not queue messages the server rejected", async () => {
    vi.mocked(messageService.send).mockRejectedValue(new ApiError("You do not have access to this conversation", 403));
    const queue = vi.fn();
    const user = userEvent.setup();
    renderComposer({ offlineQueue: { isOnline: true, queue } });
    await user.type(screen.getByLabelText("Message"), "hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access");
    expect(queue).not.toHaveBeenCalled();
  });

  it("inserts a quick reply via the ⚡ button and via its /shortcut", async () => {
    const replies: QuickReply[] = [
      { id: "q1", shortcut: "/hours", title: "Opening hours", body: "We're open 9–5, Mon–Fri.", createdAt: "", updatedAt: "" },
    ];
    const user = userEvent.setup();
    renderComposer({ quickReplies: replies });

    await user.click(screen.getByRole("button", { name: "Quick replies" }));
    await user.click(screen.getByRole("button", { name: /Opening hours/ }));
    expect(screen.getByLabelText("Message")).toHaveValue("We're open 9–5, Mon–Fri.");

    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "/ho");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Message")).toHaveValue("We're open 9–5, Mon–Fri.");
    expect(messageService.send).not.toHaveBeenCalled();
  });

  it("schedules the draft only when the user picks a time and confirms", async () => {
    const onSchedule = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderComposer({ onSchedule });

    await user.type(screen.getByLabelText("Message"), "Happy birthday!");
    await user.click(screen.getByRole("button", { name: "Schedule message" }));
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    await user.type(screen.getByLabelText("Send at"), "2030-05-01T09:30");
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledWith("Happy birthday!", "2030-05-01T09:30"));
    expect(messageService.send).not.toHaveBeenCalled();
  });
});

describe("Creating tasks / reminders / events", () => {
  it("creates nothing until Create is pressed, then sends the source message and wall-clock time in the user's timezone", async () => {
    vi.mocked(taskService.create).mockResolvedValue(task());
    const onClose = vi.fn();
    const user = userEvent.setup();
    withProviders(<ItemFormModal kind="task" initial={{ title: "Send the report" }} source={{ sourceMessageId: "msg-1" }} onClose={onClose} />);

    await waitFor(() => expect(screen.getByText("Times are in Asia/Tokyo")).toBeInTheDocument());
    expect(taskService.create).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Due"), "2030-01-10T17:00");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(taskService.create).toHaveBeenCalledWith(
        "test-access-token",
        expect.objectContaining({ title: "Send the report", sourceMessageId: "msg-1", dueAtLocal: "2030-01-10T17:00", timezone: "Asia/Tokyo" })
      )
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("requires a time for reminders and events", async () => {
    const user = userEvent.setup();
    withProviders(<ItemFormModal kind="reminder" initial={{ title: "Call" }} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(screen.getByLabelText("Remind me at"), "2030-01-10T08:00");
    vi.mocked(reminderService.create).mockResolvedValue({} as never);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(reminderService.create).toHaveBeenCalledWith("test-access-token", expect.objectContaining({ remindAtLocal: "2030-01-10T08:00" })));
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it("turns an AI suggestion into a task only through the pre-filled form", async () => {
    const suggestion: AIAction = {
      id: "act-1",
      conversationId: "conv-1",
      sourceMessageId: "msg-1",
      type: "task",
      title: "Send the Q3 report",
      notes: null,
      dueAt: null,
      dueText: "Friday",
      timezone: null,
      participants: [],
      confidence: "high",
      explanation: "Asked directly",
      status: "suggested",
      confirmedAt: null,
      convertedTo: null,
      convertedId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(aiService.listActions).mockResolvedValue([suggestion]);
    vi.mocked(taskService.create).mockResolvedValue(task());
    const user = userEvent.setup();
    withProviders(<ActionsPanel conversationId="conv-1" />);

    await user.click(await screen.findByRole("button", { name: "Task" }));
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Send the Q3 report")).toBeInTheDocument();
    expect(taskService.create).not.toHaveBeenCalled();

    vi.mocked(aiService.listActions).mockResolvedValue([{ ...suggestion, status: "confirmed", convertedTo: "task", convertedId: "task-1" }]);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(taskService.create).toHaveBeenCalledWith("test-access-token", expect.objectContaining({ sourceActionId: "act-1" })));
    expect(await screen.findByText("Added as task")).toBeInTheDocument();
  });
});

describe("TaskPanel", () => {
  it("lists tasks, completes one, and re-syncs on a task:updated event from another device", async () => {
    vi.mocked(taskService.list).mockResolvedValue([task()]);
    vi.mocked(taskService.complete).mockResolvedValue(task({ status: "completed" }));
    const user = userEvent.setup();
    const { realtime } = withProviders(<TaskPanel />);

    expect(await screen.findByText("Send the report")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Complete Send the report" }));
    await waitFor(() => expect(taskService.complete).toHaveBeenCalledWith("test-access-token", "task-1"));

    vi.mocked(taskService.list).mockResolvedValue([task(), task({ id: "task-2", title: "Created on my phone" })]);
    realtime.emit({ type: "task:updated", task: task({ id: "task-2", title: "Created on my phone" }) });
    expect(await screen.findByText("Created on my phone")).toBeInTheDocument();
  });

  it("adds a task with the chosen priority", async () => {
    vi.mocked(taskService.create).mockResolvedValue(task());
    const user = userEvent.setup();
    withProviders(<TaskPanel />);
    await user.type(screen.getByLabelText("New task title"), "Book flights");
    await user.selectOptions(screen.getByLabelText("New task priority"), "urgent");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(taskService.create).toHaveBeenCalledWith("test-access-token", expect.objectContaining({ title: "Book flights", priority: "urgent", dueAtLocal: null }))
    );
  });
});

describe("Notification + preference sync", () => {
  function Probe() {
    const { unreadNotifications, notifications, preferences } = useWorkspace();
    return (
      <div>
        <p data-testid="unread">{unreadNotifications}</p>
        <p data-testid="latest">{notifications[0]?.title ?? ""}</p>
        <p data-testid="mode">{String(preferences?.productivityMode)}</p>
      </div>
    );
  }

  it("updates the notification center and preferences from realtime events", async () => {
    const { realtime } = withProviders(<Probe />);
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("false"));

    const notification: AppNotification = {
      id: "n1",
      type: "reminder",
      title: "Reminder",
      body: "Stand up",
      payload: { reminderId: "r1" },
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    realtime.emit({ type: "notification:new", notification });
    expect(screen.getByTestId("unread")).toHaveTextContent("1");
    expect(screen.getByTestId("latest")).toHaveTextContent("Reminder");

    realtime.emit({ type: "notification:read", notificationIds: "all", unreadCount: 0 });
    expect(screen.getByTestId("unread")).toHaveTextContent("0");

    realtime.emit({ type: "preferences:updated", preferences: { ...PREFS, productivityMode: true } });
    expect(screen.getByTestId("mode")).toHaveTextContent("true");
  });
});

describe("Remote sign-out", () => {
  function Who() {
    const { user, signedOutReason } = useAuth();
    return <p data-testid="who">{user ? user.displayName : `signed out: ${signedOutReason}`}</p>;
  }

  it("signs this device out when the server reports its session was revoked", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "This session has been signed out.", code: "session_revoked" } }), { status: 401 })
    ) as unknown as typeof fetch;
    try {
      render(
        <AuthProvider>
          <Who />
        </AuthProvider>
      );
      expect(screen.getByTestId("who")).toHaveTextContent("Test User");
      await expect(apiRequest("/tasks", { accessToken: "test-access-token" })).rejects.toBeInstanceOf(ApiError);
      await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("signed out: This device was signed out"));
      expect(localStorage.getItem("connectx.auth")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("signs out on a session:revoked frame for this device's session only", async () => {
    localStorage.setItem(
      "connectx.auth",
      JSON.stringify({ user: { id: "user-1", email: "t@e.com", displayName: "Test User" }, tokens: { accessToken: "a", refreshToken: "r" }, sessionId: "sess-1" })
    );
    // Capture the socket RealtimeProvider opens (the test setup's inert StubWebSocket) to feed it frames.
    const sockets: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends (OriginalWebSocket as unknown as new (url: string) => object) {
      constructor(url: string) {
        super(url);
        sockets.push(this as never);
      }
    } as unknown as typeof WebSocket;
    try {
      const { RealtimeProvider } = await import("../../context/RealtimeContext");
      const { act } = await import("@testing-library/react");
      render(
        <AuthProvider>
          <RealtimeProvider>
            <Who />
          </RealtimeProvider>
        </AuthProvider>
      );
      const deliver = (event: object) => act(() => sockets.at(-1)!.onmessage?.({ data: JSON.stringify(event) }));

      deliver({ type: "session:revoked", sessionId: "some-other-device" });
      expect(screen.getByTestId("who")).toHaveTextContent("Test User");

      deliver({ type: "session:revoked", sessionId: "sess-1" });
      await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("signed out: This device was signed out from another device."));
    } finally {
      globalThis.WebSocket = OriginalWebSocket;
    }
  });
});

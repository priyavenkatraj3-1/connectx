import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../services/apiClient";
import { authService } from "../../services/authService";
import { mediaService } from "../../services/mediaService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { AttachmentDTO } from "../../types/media";
import { AttachmentView } from "./AttachmentView";

vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { upload: vi.fn(), remove: vi.fn(), fetchContent: vi.fn() } };
});

vi.mock("../../services/authService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/authService")>();
  return { ...actual, authService: { ...actual.authService, refresh: vi.fn() } };
});

const fetchContent = vi.mocked(mediaService.fetchContent);
const refresh = vi.mocked(authService.refresh);

const expired = () => new ApiError("Invalid or expired token", 401);

function attachment(overrides: Partial<AttachmentDTO>): AttachmentDTO {
  return {
    id: "att-1",
    conversationId: "conv-1",
    purpose: "message",
    messageId: "msg-1",
    uploaderId: "user-2",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 3,
    originalFilename: "cat.png",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AttachmentDTO;
}

const image = () => attachment({});
const pdf = () => attachment({ id: "att-pdf", kind: "document", mimeType: "application/pdf", sizeBytes: 2048, originalFilename: "Q3 report.pdf" });

function renderAttachments(...items: AttachmentDTO[]) {
  return render(
    <AuthProvider>
      {items.map((item) => (
        <AttachmentView key={item.id} attachment={item} isOwn={false} />
      ))}
    </AuthProvider>
  );
}

/** Records programmatic downloads (anchor clicks) instead of letting jsdom navigate. */
function captureDownloads() {
  const downloads: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.getAttribute("href") ?? "", download: this.download });
  });
  return downloads;
}

/** Swaps a static URL method (jsdom has no object URLs) and returns a function that puts the original back. */
function stubUrlMethod<K extends "createObjectURL" | "revokeObjectURL">(name: K, impl: (typeof URL)[K]): () => void {
  const original = Object.getOwnPropertyDescriptor(URL, name);
  Object.defineProperty(URL, name, { configurable: true, writable: true, value: impl });
  return () => {
    if (original) Object.defineProperty(URL, name, original);
    else delete (URL as unknown as Record<string, unknown>)[name];
  };
}

describe("AttachmentView", () => {
  let urlCounter = 0;
  let restoreUrlMethods: (() => void)[] = [];

  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    fetchContent.mockReset();
    refresh.mockReset();
    urlCounter = 0;
    restoreUrlMethods = [
      stubUrlMethod("createObjectURL", vi.fn(() => `blob:mock-${++urlCounter}`)),
      stubUrlMethod("revokeObjectURL", vi.fn()),
    ];
  });

  // Runs even when a test's assertions fail, so nothing leaks into later tests.
  afterEach(() => {
    // Unmount first: unmounting revokes object URLs, so the URL stubs must still be in place.
    cleanup();
    vi.restoreAllMocks();
    fetchContent.mockReset();
    refresh.mockReset();
    for (const restore of restoreUrlMethods) restore();
    restoreUrlMethods = [];
    localStorage.clear();
  });

  describe("image preview", () => {
    it("opens a preview of the securely loaded image on click, and closes it", async () => {
      fetchContent.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
      const user = userEvent.setup();
      renderAttachments(image());

      await user.click(await screen.findByRole("button", { name: "Open cat.png" }));
      const dialog = screen.getByRole("dialog", { name: "Preview of cat.png" });
      expect(dialog.querySelector("img")).toHaveAttribute("src", "blob:mock-1");
      // The preview reuses the bytes fetched through the authenticated endpoint — no second request.
      expect(fetchContent).toHaveBeenCalledTimes(1);
      expect(fetchContent).toHaveBeenCalledWith("test-access-token", "att-1");

      await user.click(screen.getByRole("button", { name: "Close preview" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Open cat.png" }));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("downloads the image from the preview under its original name", async () => {
      fetchContent.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(image());

      await user.click(await screen.findByRole("button", { name: "Open cat.png" }));
      await user.click(screen.getByRole("button", { name: "Download cat.png" }));
      expect(downloads).toEqual([{ href: "blob:mock-1", download: "cat.png" }]);
    });

    it("retries a failed image load when the placeholder is clicked", async () => {
      fetchContent.mockRejectedValueOnce(new ApiError("Couldn't load this file", 500));
      fetchContent.mockResolvedValueOnce(new Blob(["png"], { type: "image/png" }));
      const user = userEvent.setup();
      renderAttachments(image());

      await user.click(await screen.findByRole("button", { name: /Couldn't load this file/ }));
      expect(await screen.findByRole("button", { name: "Open cat.png" })).toBeInTheDocument();
      expect(fetchContent).toHaveBeenCalledTimes(2);
    });
  });

  describe("file download", () => {
    it("fetches on the first click and saves the file under its original name", async () => {
      fetchContent.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      expect(fetchContent).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Download Q3 report.pdf" }));

      await waitFor(() => expect(downloads).toEqual([{ href: "blob:mock-1", download: "Q3 report.pdf" }]));
      expect(fetchContent).toHaveBeenCalledWith("test-access-token", "att-pdf");
    });

    it("downloads again on repeated clicks without re-fetching", async () => {
      fetchContent.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      const card = screen.getByRole("button", { name: "Download Q3 report.pdf" });
      await user.click(card);
      await waitFor(() => expect(downloads).toHaveLength(1));
      await user.click(card);
      await user.click(card);

      expect(downloads).toHaveLength(3);
      expect(fetchContent).toHaveBeenCalledTimes(1);
    });

    it("ignores clicks while the file is still loading", async () => {
      let resolve!: (blob: Blob) => void;
      fetchContent.mockReturnValue(new Promise<Blob>((r) => (resolve = r)));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      const card = screen.getByRole("button", { name: "Download Q3 report.pdf" });
      await user.click(card);
      await user.click(card);
      resolve(new Blob(["%PDF"]));

      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(fetchContent).toHaveBeenCalledTimes(1);
    });

    it("is not stuck after a failure: the next click retries and downloads", async () => {
      fetchContent.mockRejectedValueOnce(new ApiError("Attachment content is unavailable", 404));
      fetchContent.mockResolvedValueOnce(new Blob(["%PDF"]));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      const card = screen.getByRole("button", { name: "Download Q3 report.pdf" });
      await user.click(card);
      expect(await screen.findByText(/Attachment content is unavailable/)).toBeInTheDocument();
      expect(downloads).toHaveLength(0);

      await user.click(card);
      await waitFor(() => expect(downloads).toEqual([{ href: "blob:mock-1", download: "Q3 report.pdf" }]));
      expect(fetchContent).toHaveBeenCalledTimes(2);
    });
  });

  describe("unauthorized and expired tokens", () => {
    it("refreshes an expired access token once and retries with the new token", async () => {
      fetchContent.mockRejectedValueOnce(expired());
      fetchContent.mockResolvedValueOnce(new Blob(["%PDF"]));
      refresh.mockResolvedValue({ tokens: { accessToken: "fresh-access-token", refreshToken: "fresh-refresh-token" }, session: { id: "s-1" } });
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      await user.click(screen.getByRole("button", { name: "Download Q3 report.pdf" }));

      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(refresh).toHaveBeenCalledWith("test-refresh-token");
      expect(fetchContent.mock.calls.map(([token]) => token)).toEqual(["test-access-token", "fresh-access-token"]);
      // The rotated tokens are kept, so later requests use them too.
      expect(JSON.parse(localStorage.getItem("connectx.auth")!).tokens.accessToken).toBe("fresh-access-token");
    });

    it("shares one refresh between attachments that hit an expired token together", async () => {
      fetchContent.mockImplementation(async (token) => {
        if (token === "test-access-token") throw expired();
        return new Blob(["png"], { type: "image/png" });
      });
      refresh.mockResolvedValue({ tokens: { accessToken: "fresh-access-token", refreshToken: "fresh-refresh-token" }, session: { id: "s-1" } });
      renderAttachments(image(), attachment({ id: "att-2", originalFilename: "dog.png" }));

      expect(await screen.findByRole("button", { name: "Open cat.png" })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Open dog.png" })).toBeInTheDocument();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("shows the error and does not loop when the refreshed token is rejected too", async () => {
      fetchContent.mockRejectedValue(expired());
      refresh.mockResolvedValue({ tokens: { accessToken: "fresh-access-token", refreshToken: "fresh-refresh-token" }, session: { id: "s-1" } });
      renderAttachments(image());

      expect(await screen.findByText("Invalid or expired token")).toBeInTheDocument();
      expect(fetchContent).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("signs out instead of retrying when the refresh token is rejected", async () => {
      fetchContent.mockRejectedValue(expired());
      refresh.mockRejectedValue(new ApiError("Invalid or expired refresh token", 401, "session_expired"));
      renderAttachments(image());

      expect(await screen.findByText("Please sign in again to open this file.")).toBeInTheDocument();
      expect(fetchContent).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("connectx.auth")).toBeNull();
    });

    it("does not refresh for an ended session or for access denied", async () => {
      fetchContent.mockRejectedValueOnce(new ApiError("This session has been signed out. Please sign in again.", 401, "session_revoked"));
      fetchContent.mockRejectedValueOnce(new ApiError("You do not have access to this attachment", 403));
      renderAttachments(image(), attachment({ id: "att-2", originalFilename: "dog.png" }));

      expect(await screen.findByText("This session has been signed out. Please sign in again.")).toBeInTheDocument();
      expect(await screen.findByText("You do not have access to this attachment")).toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
      expect(fetchContent).toHaveBeenCalledTimes(2);
    });
  });

  describe("PDF preview", () => {
    it("fetches the PDF through the authenticated API and shows it in-app from a blob: URL", async () => {
      fetchContent.mockResolvedValue(new Blob(["%PDF-1.7"], { type: "application/pdf" }));
      const downloads = captureDownloads();
      const user = userEvent.setup();
      renderAttachments(pdf());

      await user.click(screen.getByRole("button", { name: "Preview Q3 report.pdf" }));
      const dialog = await screen.findByRole("dialog", { name: "Preview of Q3 report.pdf" });
      const frame = within(dialog).getByTitle("PDF preview: Q3 report.pdf");
      expect(frame.getAttribute("src")).toMatch(/^blob:/);
      expect(fetchContent).toHaveBeenCalledWith("test-access-token", "att-pdf");
      expect(downloads).toEqual([]); // previewing doesn't download

      await user.click(within(dialog).getByRole("button", { name: "Download Q3 report.pdf" }));
      expect(downloads).toEqual([{ href: frame.getAttribute("src"), download: "Q3 report.pdf" }]);

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // Re-opening reuses the bytes already loaded.
      await user.click(screen.getByRole("button", { name: "Preview Q3 report.pdf" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(fetchContent).toHaveBeenCalledTimes(1);
    });

    it("doesn't open a preview when the file can't be loaded", async () => {
      fetchContent.mockRejectedValue(new ApiError("You do not have access to this conversation", 403));
      const user = userEvent.setup();
      renderAttachments(pdf());
      await user.click(screen.getByRole("button", { name: "Preview Q3 report.pdf" }));
      await waitFor(() => expect(fetchContent).toHaveBeenCalled());
      expect(await screen.findByText(/You do not have access/)).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("offers no preview for Office documents or other files (download only)", () => {
      renderAttachments(
        attachment({ id: "d1", kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", originalFilename: "notes.docx" }),
        attachment({ id: "d2", kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", originalFilename: "budget.xlsx" }),
        attachment({ id: "d3", kind: "document", mimeType: "text/plain", originalFilename: "todo.txt" })
      );
      expect(screen.queryByRole("button", { name: /^Preview/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download notes.docx" })).toBeInTheDocument();
    });
  });
});

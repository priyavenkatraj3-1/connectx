import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { mediaService } from "../../services/mediaService";
import { statusService } from "../../services/statusService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { OwnStatusDTO } from "../../types/status";
import { CreateStatusModal } from "./CreateStatusModal";

vi.mock("../../services/statusService", () => ({
  statusService: { getPrivacy: vi.fn(), create: vi.fn() },
}));
vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { uploadStatusMedia: vi.fn(), remove: vi.fn() } };
});

const created: OwnStatusDTO = {
  id: "status-1",
  userId: "user-1",
  type: "text",
  text: "hello",
  backgroundColor: "rose",
  media: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  viewedByMe: true,
  visibility: "contacts",
  audienceUserIds: [],
  viewCount: 0,
};

function renderModal() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <AuthProvider>
      <CreateStatusModal onClose={onClose} onCreated={onCreated} />
    </AuthProvider>
  );
  return { onClose, onCreated };
}

describe("CreateStatusModal", () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(statusService.getPrivacy).mockResolvedValue({ visibility: "contacts", userIds: [] });
    vi.mocked(statusService.create).mockReset().mockResolvedValue(created);
    vi.mocked(mediaService.uploadStatusMedia).mockReset();
    vi.mocked(mediaService.remove).mockReset().mockResolvedValue(undefined);
  });

  it("publishes a text status with the saved default privacy, clearly shown", async () => {
    const user = userEvent.setup();
    const { onCreated, onClose } = renderModal();

    expect(await screen.findByTestId("privacy-summary")).toHaveTextContent("Visible to: My contacts");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

    await user.type(screen.getByLabelText("Status text"), "hello");
    await user.click(screen.getByRole("radio", { name: "rose background" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(statusService.create).toHaveBeenCalledWith("test-access-token", {
        type: "text",
        text: "hello",
        backgroundColor: "rose",
        attachmentId: undefined,
        privacy: { visibility: "contacts", userIds: [] },
      })
    );
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(onClose).toHaveBeenCalled();
  });

  it("lets you change privacy per status, and requires people for 'Only share with'", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.type(screen.getByLabelText("Status text"), "secret");

    await user.click(screen.getByRole("radio", { name: /Only share with/ }));
    expect(screen.getByText("Share only with")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Everyone I chat with/ }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(statusService.create).toHaveBeenCalledWith(
        "test-access-token",
        expect.objectContaining({ privacy: { visibility: "everyone", userIds: [] } })
      )
    );
  });

  it("uploads a photo through the media pipeline, then publishes it with a caption", async () => {
    vi.mocked(mediaService.uploadStatusMedia).mockReturnValue({
      promise: Promise.resolve({ id: "att-1" } as never),
      abort: vi.fn(),
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId("privacy-summary");

    await user.click(screen.getByRole("tab", { name: "Photo" }));
    await user.upload(screen.getByLabelText("Choose a photo"), new File(["png"], "beach.png", { type: "image/png" }));
    expect(screen.getByAltText("Status preview")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Caption"), "sunny");
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(statusService.create).toHaveBeenCalled());
    expect(mediaService.uploadStatusMedia).toHaveBeenCalledWith("test-access-token", expect.any(File), expect.any(Function));
    expect(statusService.create).toHaveBeenCalledWith(
      "test-access-token",
      expect.objectContaining({ type: "image", text: "sunny", attachmentId: "att-1", backgroundColor: undefined })
    );
  });

  it("rejects the wrong kind of file before uploading anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderModal();
    await user.click(screen.getByRole("tab", { name: "Photo" }));
    await user.upload(screen.getByLabelText("Choose a photo"), new File(["x"], "clip.mp4", { type: "video/mp4" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a photo");

    await user.upload(screen.getByLabelText("Choose a photo"), new File(["x"], "notes.pdf", { type: "application/pdf" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A status can only be a photo or a video");
    expect(mediaService.uploadStatusMedia).not.toHaveBeenCalled();
  });

  it("cleans up the upload if publishing fails, and shows the server's reason", async () => {
    vi.mocked(mediaService.uploadStatusMedia).mockReturnValue({
      promise: Promise.resolve({ id: "att-2" } as never),
      abort: vi.fn(),
    });
    vi.mocked(statusService.create).mockRejectedValue(new Error("Choose at least one person to share this status with"));
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId("privacy-summary");
    await user.click(screen.getByRole("tab", { name: "Video" }));
    await user.upload(screen.getByLabelText("Choose a video"), new File(["mp4"], "clip.mp4", { type: "video/mp4" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one person");
    expect(mediaService.remove).toHaveBeenCalledWith("test-access-token", "att-2");
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { loadImageFile, renderAvatar } from "../../lib/image/cropImage";
import { ApiError } from "../../services/apiClient";
import { userService } from "../../services/userService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { OwnProfile } from "../../types/user";
import { ProfilePhotoControl } from "./ProfilePhotoControl";

vi.mock("../../services/userService", () => ({ userService: { uploadAvatar: vi.fn(), removeAvatar: vi.fn() } }));
// jsdom can't decode images or draw on a canvas: stub those two steps, keep the real validation and geometry.
vi.mock("../../lib/image/cropImage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/image/cropImage")>();
  return { ...actual, loadImageFile: vi.fn(), renderAvatar: vi.fn() };
});

const profile: OwnProfile = {
  id: "user-1",
  email: "test@example.com",
  displayName: "Test User",
  avatarUrl: null,
  bio: null,
  statusMessage: null,
  createdAt: new Date().toISOString(),
};
const NEW_URL = "/api/v1/users/user-1/avatar/11111111-1111-4111-8111-111111111111";
const cropped = new Blob(["jpeg-bytes"], { type: "image/jpeg" });

function renderControl(current: OwnProfile = profile) {
  const onChange = vi.fn();
  render(
    <AuthProvider>
      <ProfilePhotoControl profile={current} onChange={onChange} />
    </AuthProvider>
  );
  return { onChange };
}

const choose = (file: File) => act(async () => fireEvent.change(screen.getByTestId("avatar-input"), { target: { files: [file] } }));
const png = () => new File([new Uint8Array(100)], "me.png", { type: "image/png" });
const storedUser = () => JSON.parse(localStorage.getItem("connectx.auth")!).user;

describe("ProfilePhotoControl", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(userService.uploadAvatar).mockReset();
    vi.mocked(userService.removeAvatar).mockReset();
    vi.mocked(loadImageFile).mockReset().mockResolvedValue({
      element: {} as HTMLImageElement,
      url: "blob:preview",
      width: 800,
      height: 600,
      release: vi.fn(),
    });
    vi.mocked(renderAvatar).mockReset().mockResolvedValue(cropped);
  });

  it("refuses files that aren't JPEG/PNG/WebP before decoding them", async () => {
    renderControl();
    await choose(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a JPEG, PNG or WebP image.");
    expect(loadImageFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("crops, uploads the re-encoded picture, and updates the profile and the signed-in user", async () => {
    vi.mocked(userService.uploadAvatar).mockResolvedValue({ ...profile, avatarUrl: NEW_URL });
    const user = userEvent.setup();
    const { onChange } = renderControl();

    expect(screen.getByRole("button", { name: "Add photo" })).toBeInTheDocument();
    await choose(png());
    expect(screen.getByRole("dialog", { name: "Profile photo" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    await user.click(screen.getByRole("button", { name: "Save photo" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...profile, avatarUrl: NEW_URL }));
    expect(renderAvatar).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600 }), expect.objectContaining({ zoom: 2 }));
    expect(userService.uploadAvatar).toHaveBeenCalledWith("test-access-token", cropped, expect.any(AbortSignal));
    expect(storedUser().avatarUrl).toBe(NEW_URL);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves the crop with the arrow keys", async () => {
    const user = userEvent.setup();
    vi.mocked(userService.uploadAvatar).mockResolvedValue({ ...profile, avatarUrl: NEW_URL });
    renderControl();
    await choose(png());
    screen.getByRole("img", { name: /Crop preview/ }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Save photo" }));
    // 800×600 at zoom 1: a 600px square centred at x=400; each arrow moves it 5% (30px) → x=460.
    await waitFor(() => expect(renderAvatar).toHaveBeenCalled());
    expect(vi.mocked(renderAvatar).mock.calls[0]![1]).toMatchObject({ zoom: 1, cx: 460, cy: 300 });
  });

  it("Cancel closes without uploading", async () => {
    const user = userEvent.setup();
    renderControl();
    await choose(png());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(userService.uploadAvatar).not.toHaveBeenCalled();
  });

  it("cancelling mid-upload aborts it and keeps the dialog open", async () => {
    let signal!: AbortSignal;
    vi.mocked(userService.uploadAvatar).mockImplementation(
      (_token, _blob, s) =>
        new Promise((_resolve, reject) => {
          signal = s!;
          s!.addEventListener("abort", () => reject(new ApiError("Upload cancelled", 0)));
        })
    );
    const user = userEvent.setup();
    const { onChange } = renderControl();
    await choose(png());
    await user.click(screen.getByRole("button", { name: "Save photo" }));
    await user.click(await screen.findByRole("button", { name: "Cancel upload" }));

    expect(signal.aborted).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload cancelled.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and lets you try again", async () => {
    vi.mocked(userService.uploadAvatar)
      .mockRejectedValueOnce(new ApiError("Profile pictures must be JPEG, PNG or WebP images", 415))
      .mockResolvedValueOnce({ ...profile, avatarUrl: NEW_URL });
    const user = userEvent.setup();
    const { onChange } = renderControl();
    await choose(png());
    await user.click(screen.getByRole("button", { name: "Save photo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Profile pictures must be JPEG, PNG or WebP images");
    await user.click(screen.getByRole("button", { name: "Save photo" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("reports an image that can't be read", async () => {
    vi.mocked(loadImageFile).mockRejectedValueOnce(new Error("Couldn't read that image."));
    renderControl();
    await choose(png());
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read that image.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("removes the current picture", async () => {
    vi.mocked(userService.removeAvatar).mockResolvedValue({ ...profile, avatarUrl: null });
    const user = userEvent.setup();
    const { onChange } = renderControl({ ...profile, avatarUrl: NEW_URL });
    expect(screen.getByRole("button", { name: "Change photo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...profile, avatarUrl: null }));
    expect(storedUser().avatarUrl).toBeNull();
  });
});

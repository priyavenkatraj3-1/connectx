import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import { SettingsView } from "./SettingsView";

const SECTION_LABELS = ["Account", "Privacy & Security", "Productivity", "Notifications", "Devices", "Business", "AI Features"];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderSettings(initialEntry = "/app/settings") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/app/settings"
            element={
              <>
                <SettingsView />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

// jsdom applies no CSS, so pane visibility is asserted through the responsive classes:
// "hidden md:flex" = hidden on mobile, shown on desktop; a bare "flex" = shown on mobile.
const navPane = () => screen.getByTestId("settings-nav-pane");
const contentPane = () => screen.getByTestId("settings-content-pane");
const location = () => screen.getByTestId("location").textContent;
const sectionButton = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label.replace(/[&]/g, "\\$&")}`) });

describe("SettingsView navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
  });

  it("shows the section list (not the content) on mobile when no section is chosen", () => {
    renderSettings();

    expect(navPane().className).toMatch(/(^|\s)flex(\s|$)/);
    expect(navPane().className).not.toContain("hidden");
    expect(contentPane().className).toContain("hidden md:flex");
    for (const label of SECTION_LABELS) expect(sectionButton(label)).toBeInTheDocument();
    // Desktop still falls back to Account in the content pane.
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
  });

  it("selecting a section updates ?section= and swaps to the content pane on mobile", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(sectionButton("Devices"));

    expect(location()).toBe("/app/settings?section=devices");
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument();
    expect(navPane().className).toContain("hidden md:flex");
    expect(contentPane().className).not.toContain("hidden");
    expect(sectionButton("Devices")).toHaveAttribute("aria-current", "page");
  });

  it("every section is reachable and sets its own query parameter", async () => {
    const user = userEvent.setup();
    renderSettings();
    const ids = ["account", "privacy", "productivity", "notifications", "devices", "business", "ai"];

    for (const [index, label] of SECTION_LABELS.entries()) {
      await user.click(sectionButton(label));
      expect(location()).toBe(`/app/settings?section=${ids[index]}`);
      expect(screen.getByRole("heading", { level: 2, name: label })).toBeInTheDocument();
    }
  });

  it("the Back button returns to the Settings overview and clears the section", async () => {
    const user = userEvent.setup();
    renderSettings("/app/settings?section=privacy");

    expect(contentPane().className).not.toContain("hidden");
    const back = screen.getByRole("button", { name: "Back to Settings" });
    expect(back.className).toContain("md:hidden"); // mobile only; desktop layout unchanged

    await user.click(back);

    expect(location()).toBe("/app/settings");
    expect(navPane().className).not.toContain("hidden");
    expect(contentPane().className).toContain("hidden md:flex");
  });

  it("an unknown ?section= value is treated as the overview", () => {
    renderSettings("/app/settings?section=nope");

    expect(navPane().className).not.toContain("hidden");
    expect(contentPane().className).toContain("hidden md:flex");
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
  });

  it("keeps the desktop two-pane layout classes", () => {
    renderSettings("/app/settings?section=account");

    expect(navPane().className).toContain("md:flex");
    expect(navPane().className).toContain("md:w-96");
    expect(contentPane().className).toContain("md:p-8");
  });
});

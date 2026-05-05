import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveDisplay } from "../../src/core/session/viewer-bridge.js";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  // Wipe all signals viewer-bridge cares about, then let each test set what it needs.
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
});

afterEach(() => {
  // Restore.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIG_ENV);
});

describe("resolveDisplay", () => {
  it("undefined → headless", () => {
    expect(resolveDisplay(undefined)).toBe("headless");
  });
  it("'headless' → headless", () => {
    expect(resolveDisplay("headless")).toBe("headless");
  });
  it("'open-terminal' → open-terminal", () => {
    expect(resolveDisplay("open-terminal")).toBe("open-terminal");
  });
});

describe("resolveDisplay 'auto' mode", () => {
  it("auto + CI=true → headless", () => {
    process.env.CI = "true";
    expect(resolveDisplay("auto")).toBe("headless");
  });

  it("auto + GITHUB_ACTIONS → headless", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(resolveDisplay("auto")).toBe("headless");
  });

  it("auto + SSH_CONNECTION → headless", () => {
    process.env.SSH_CONNECTION = "1.2.3.4 22 5.6.7.8 22";
    expect(resolveDisplay("auto")).toBe("headless");
  });

  it("auto + SSH_CLIENT → headless", () => {
    process.env.SSH_CLIENT = "1.2.3.4 22 22";
    expect(resolveDisplay("auto")).toBe("headless");
  });

  it("auto + Linux without DISPLAY → headless (only on linux)", () => {
    if (process.platform !== "linux") {
      // The condition is platform-gated; on macOS/Windows DISPLAY absence
      // doesn't force headless. Skip the assertion meaningfully.
      expect(resolveDisplay("auto")).toBe("open-terminal");
      return;
    }
    expect(resolveDisplay("auto")).toBe("headless");
  });

  it("auto + desktop env (no CI/SSH) → open-terminal", () => {
    if (process.platform === "linux") process.env.DISPLAY = ":0";
    expect(resolveDisplay("auto")).toBe("open-terminal");
  });
});

import { describe, it, expect } from "vitest";
import { inferPlatform, defaultShell, isKnownShell } from "../../src/core/platform.js";

describe("inferPlatform", () => {
  it("darwin", () => {
    const p = inferPlatform("darwin", "arm64");
    expect(p).toMatchObject({
      os: "darwin", arch: "arm64", isDarwin: true, isLinux: false, isWindows: false,
      pathSep: ":", fsSep: "/", lineEnding: "\n",
    });
  });

  it("linux x64", () => {
    const p = inferPlatform("linux", "x64");
    expect(p.os).toBe("linux");
    expect(p.isLinux).toBe(true);
    expect(p.pathSep).toBe(":");
    expect(p.fsSep).toBe("/");
  });

  it("win32", () => {
    const p = inferPlatform("win32", "x64");
    expect(p.os).toBe("win32");
    expect(p.isWindows).toBe(true);
    expect(p.pathSep).toBe(";");
    expect(p.fsSep).toBe("\\");
    expect(p.lineEnding).toBe("\r\n");
  });

  it("rejects unsupported platform", () => {
    expect(() => inferPlatform("aix" as NodeJS.Platform, "x64")).toThrow(/unsupported platform/);
    expect(() => inferPlatform("freebsd" as NodeJS.Platform, "x64")).toThrow(/unsupported platform/);
  });
});

describe("defaultShell", () => {
  it("respects requested override", () => {
    expect(defaultShell("bash", "/bin/zsh", inferPlatform("darwin", "arm64"))).toBe("bash");
  });

  it("uses env SHELL on POSIX", () => {
    expect(defaultShell(undefined, "/bin/fish", inferPlatform("linux", "x64"))).toBe("/bin/fish");
  });

  it("falls back to /bin/zsh on POSIX without env SHELL", () => {
    expect(defaultShell(undefined, undefined, inferPlatform("darwin", "arm64"))).toBe("/bin/zsh");
    expect(defaultShell(undefined, "", inferPlatform("linux", "x64"))).toBe("/bin/zsh");
  });

  it("returns pwsh on Windows regardless of env SHELL", () => {
    expect(defaultShell(undefined, "/bin/zsh", inferPlatform("win32", "x64"))).toBe("pwsh");
  });
});

describe("isKnownShell", () => {
  it.each([
    ["bash", true],
    ["zsh", true],
    ["/bin/sh", true],
    ["/usr/local/bin/fish", true],
    ["pwsh", true],
    ["pwsh.exe", true],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", true],
    ["powershell", true],
    ["cmd", true],
    ["claude", false],
    ["aikey", false],
    ["", false],
    ["nodebashlike", false],
  ])("isKnownShell(%s) = %s", (input, expected) => {
    expect(isKnownShell(input)).toBe(expected);
  });
});

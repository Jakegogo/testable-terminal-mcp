/**
 * Unit tests for env-injector.
 *
 * Pure function: drive with synthetic (sandbox, hostEnv, opts), assert env.
 * Three inheritance modes + denyKeys + virtual HOME + PATH overlay + caller
 * env layer + Windows branch all covered.
 */

import { describe, it, expect } from "vitest";
import { buildSandboxEnv } from "../../src/core/sandbox/env-injector.js";
import { ErrorCode, isTestableTerminalError } from "../../src/core/errors.js";
import { inferPlatform } from "../../src/core/platform.js";
import type { EnvInheritanceConfig, SandboxRef } from "../../src/core/types.js";

const POSIX = inferPlatform("darwin", "arm64");
const WIN = inferPlatform("win32", "x64");

const sbx = (over: Partial<SandboxRef> = {}): SandboxRef => ({
  id: "sbx_test",
  path: over.path ?? "/tmp/sbx-1",
  mode: "ephemeral",
  profile: "minimal",
  createdAt: new Date(),
  ...over,
});

const inheritance = (over: Partial<EnvInheritanceConfig> = {}): EnvInheritanceConfig => ({
  mode: "all_with_overlay",
  denyKeys: ["*KEY*", "*TOKEN*", "*SECRET*", "ANTHROPIC_API_KEY", "AIKEY_*"],
  allowCallerSecretEnv: true,
  strictDeny: false,
  ...over,
});

describe("env-injector — inheritance modes", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/jake",
    EDITOR: "vi",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    USER: "jake",
  };

  it("all_with_overlay (default) inherits all then overlays virtual HOME", () => {
    const { env, hostInherited } = buildSandboxEnv(sbx(), hostEnv, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    // EDITOR / LANG / USER inherited.
    expect(env.EDITOR).toBe("vi");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.USER).toBe("jake");
    // virtual HOME overrides.
    expect(env.HOME).toBe("/tmp/sbx-1");
    // ANTHROPIC_API_KEY blocked by denyKeys.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // hostInherited diagnostic excludes denied keys.
    expect(hostInherited).toContain("EDITOR");
    expect(hostInherited).not.toContain("ANTHROPIC_API_KEY");
  });

  it("whitelist passes only listed keys", () => {
    const { env } = buildSandboxEnv(sbx(), hostEnv, {
      envInheritance: inheritance({ mode: "whitelist" }),
      passthroughEnvKeys: ["LANG", "USER"],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.USER).toBe("jake");
    expect(env.EDITOR).toBeUndefined();
    // virtual HOME still injected even though HOME wasn't whitelisted.
    expect(env.HOME).toBe("/tmp/sbx-1");
  });

  it("none inherits nothing from host (still gets virtual HOME + sandbox PATH)", () => {
    const { env } = buildSandboxEnv(sbx(), hostEnv, {
      envInheritance: inheritance({ mode: "none" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.EDITOR).toBeUndefined();
    expect(env.LANG).toBeUndefined();
    expect(env.USER).toBeUndefined();
    expect(env.HOME).toBe("/tmp/sbx-1");
    // PATH only contains sandbox bins (no host PATH inheritance).
    expect(env.PATH).toBe("/tmp/sbx-1/bin:/tmp/sbx-1/.local/bin:/tmp/sbx-1/.aikey/bin");
  });
});

describe("env-injector — denyKeys filter", () => {
  it("denies host keys matching glob (case-insensitive)", () => {
    const { env, denied } = buildSandboxEnv(sbx(), {
      ANTHROPIC_API_KEY: "secret",
      MyToken: "secret",
      anthropic_secret: "secret",  // lowercase variant
      OTHER: "ok",
    }, {
      envInheritance: inheritance({ denyKeys: ["*KEY*", "*TOKEN*", "*SECRET*"] }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MyToken).toBeUndefined();
    expect(env.anthropic_secret).toBeUndefined();
    expect(env.OTHER).toBe("ok");
    expect(denied.sort()).toEqual(["ANTHROPIC_API_KEY", "MyToken", "anthropic_secret"].sort());
  });

  it("denyKeys empty patterns block nothing", () => {
    const { env, denied } = buildSandboxEnv(sbx(), { SECRET_TOKEN: "x", OK: "y" }, {
      envInheritance: inheritance({ denyKeys: [] }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.SECRET_TOKEN).toBe("x");
    expect(env.OK).toBe("y");
    expect(denied).toEqual([]);
  });
});

describe("env-injector — virtual HOME + PATH composition", () => {
  it("PATH prepends sandbox bin / .local/bin / .aikey/bin then host PATH", () => {
    const { env } = buildSandboxEnv(sbx({ path: "/sbx" }), { PATH: "/usr/bin:/bin" }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.PATH).toBe("/sbx/bin:/sbx/.local/bin:/sbx/.aikey/bin:/usr/bin:/bin");
  });

  it("PATH dedupes duplicates preserving first occurrence", () => {
    const { env } = buildSandboxEnv(sbx({ path: "/sbx" }), {
      PATH: "/sbx/bin:/usr/bin:/usr/bin:/bin",
    }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    // /sbx/bin (sandbox) wins over the duplicate from host PATH; /usr/bin
    // appears once.
    expect(env.PATH).toBe("/sbx/bin:/sbx/.local/bin:/sbx/.aikey/bin:/usr/bin:/bin");
  });

  it("PATH skips empty strings from `:` segments", () => {
    const { env } = buildSandboxEnv(sbx({ path: "/sbx" }), { PATH: ":/usr/bin::/bin:" }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.PATH).toBe("/sbx/bin:/sbx/.local/bin:/sbx/.aikey/bin:/usr/bin:/bin");
  });

  it("isolateTemp injects TMPDIR/TEMP/TMP", () => {
    const { env } = buildSandboxEnv(sbx({ path: "/sbx" }), {}, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: true,
      platform: POSIX,
    });
    expect(env.TMPDIR).toBe("/sbx/tmp");
    expect(env.TEMP).toBe("/sbx/tmp");
    expect(env.TMP).toBe("/sbx/tmp");
  });

  it("isolateTemp=false leaves host TMPDIR alone", () => {
    const { env } = buildSandboxEnv(sbx({ path: "/sbx" }), { TMPDIR: "/host/tmp" }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: POSIX,
    });
    expect(env.TMPDIR).toBe("/host/tmp");
  });
});

describe("env-injector — Windows branch", () => {
  it("injects USERPROFILE / HOMEDRIVE / HOMEPATH + Path mirror on Windows", () => {
    const { env } = buildSandboxEnv(sbx({ path: "C:\\Users\\sandbox\\sbx-1" }), {
      Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
      USERPROFILE: "C:\\Users\\jake",
    }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: WIN,
    });
    expect(env.HOME).toBe("C:\\Users\\sandbox\\sbx-1");
    expect(env.USERPROFILE).toBe("C:\\Users\\sandbox\\sbx-1");
    expect(env.HOMEDRIVE).toBe("C:");
    expect(env.HOMEPATH).toBe("\\Users\\sandbox\\sbx-1");
    // PATH uses ; separator and includes sandbox bins.
    expect(env.PATH).toContain("C:\\Users\\sandbox\\sbx-1\\bin");
    expect(env.PATH.split(";")[0]).toBe("C:\\Users\\sandbox\\sbx-1\\bin");
    // Path mirror.
    expect(env.Path).toBe(env.PATH);
  });

  it("Windows path dedupe is case-insensitive", () => {
    const { env } = buildSandboxEnv(sbx({ path: "C:\\sbx" }), {
      Path: "C:\\sbx\\bin;c:\\sbx\\bin;C:\\Windows",  // dup with different casing
    }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      platform: WIN,
    });
    // The sandbox-injected "C:\\sbx\\bin" wins; both lowercase and uppercase
    // duplicates from host PATH are dropped.
    const parts = env.PATH.split(";");
    const sbxBinCount = parts.filter((p) => p.toLowerCase() === "c:\\sbx\\bin").length;
    expect(sbxBinCount).toBe(1);
  });
});

describe("env-injector — caller env layer (round 7)", () => {
  it("allowCallerSecretEnv=true: caller can pass secret-shape keys", () => {
    const { env } = buildSandboxEnv(sbx(), {}, {
      envInheritance: inheritance({ allowCallerSecretEnv: true }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      callerEnv: { ANTHROPIC_API_KEY: "sk-ant-real" },
      platform: POSIX,
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
  });

  it("allowCallerSecretEnv=false strictDeny=true: throws E_TT_ENV_KEY_NOT_ALLOWED", () => {
    try {
      buildSandboxEnv(sbx(), {}, {
        envInheritance: inheritance({ allowCallerSecretEnv: false, strictDeny: true }),
        passthroughEnvKeys: [],
        isolateTemp: false,
        callerEnv: { ANTHROPIC_API_KEY: "sk-ant" },
        platform: POSIX,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(isTestableTerminalError(err)).toBe(true);
      if (isTestableTerminalError(err)) {
        expect(err.code).toBe(ErrorCode.ENV_KEY_NOT_ALLOWED);
      }
    }
  });

  it("allowCallerSecretEnv=false strictDeny=false: silently drops", () => {
    const { env } = buildSandboxEnv(sbx(), {}, {
      envInheritance: inheritance({ allowCallerSecretEnv: false, strictDeny: false }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      callerEnv: { ANTHROPIC_API_KEY: "sk-ant", MY_PUBLIC: "ok" },
      platform: POSIX,
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MY_PUBLIC).toBe("ok");
  });

  it("caller env overrides host env on collision", () => {
    const { env } = buildSandboxEnv(sbx(), { EDITOR: "vi" }, {
      envInheritance: inheritance({ mode: "all_with_overlay" }),
      passthroughEnvKeys: [],
      isolateTemp: false,
      callerEnv: { EDITOR: "nano" },
      platform: POSIX,
    });
    expect(env.EDITOR).toBe("nano");
  });
});

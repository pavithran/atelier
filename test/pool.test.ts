import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEntry, cleanStatus, familyOf, LOCAL_BUILD } from "../src/models/pool.ts";

const AT = "2026-10-04T12:00:00.000Z";

test("families are recognised by name, so new releases need no update", () => {
  for (const [name, family] of [
    ["opus-5.5", "anthropic"], ["claude-sonnet-5-5", "anthropic"], ["gpt-6-astra", "openai"], ["gpt-6.1", "openai"],
    ["glm-5.3", "zai"], ["GLM-5.4-Flash-4_8bit", "zai"], ["gemini-3.1-pro", "google"], ["gemma-4", "google"],
    ["DeepSeek-V4-Flash-0731-MXFP4-MLX", "deepseek"], ["deepseek-chat", "deepseek"], ["Qwen3-Coder-Next-4bit:studio-code", "qwen"],
    ["MiniMax-M3-Alis-MLX-Dynamic", "minimax"], ["devstral-2", "mistral"], ["llama-5", "meta"], ["mystery-1", "other"],
  ] as const) assert.equal(familyOf(name), family, name);
  assert.ok(LOCAL_BUILD.test("GLM-5.3-Flash-4_8bit") && LOCAL_BUILD.test("Qwen3.8-27B-6bit:studio-balanced") && !LOCAL_BUILD.test("gemini-3.1-pro"));
});

test("an entry is validated, its family derived, and no secret is accepted", () => {
  const e = cleanEntry({ id: "gemini-3.1-pro", harness: "opencode", where: "cloud", provider: "google", keychain: "gemini.API_KEY", aliases: "gemini-pro, gemini-latest" }, "pavi", AT);
  assert.deepEqual(e, { id: "gemini-3.1-pro", harness: "opencode", where: "cloud", provider: "google", keychain: "gemini.API_KEY", aliases: ["gemini-pro", "gemini-latest"], family: "google", note: "", addedBy: "pavi", addedAt: AT });
  const studio = cleanEntry({ id: "GLM-5.3-Flash-4_8bit", harness: "opencode", where: "home", endpoint: "http://10.0.0.110:8000/v1" }, "pavi", AT);
  assert.equal(studio.provider, "ai-studio", "OpenCode at home defaults to the Studio");
  for (const [body, why] of [
    [{ id: "x", harness: "opencode", where: "home", key: "sk-secret" }, /never stores keys/],
    [{ id: "x", harness: "opencode", where: "home", apiKey: "sk" }, /never stores keys/],
    [{ id: "x", harness: "opencode", where: "home", endpoint: "https://user:pass@example.com/v1" }, /user name or password/],
    [{ id: "x", harness: "opencode", where: "home", endpoint: "file:///etc/passwd" }, /http or https/],
    [{ id: "x", harness: "opencode", where: "home", keychain: "has space" }, /entry name/],
    [{ id: "has/slash", harness: "opencode", where: "home" }, /not a model id/],
    [{ id: "x", harness: "bash", where: "home" }, /harness must be/],
    [{ id: "x", harness: "codex", where: "moon" }, /home or cloud/],
  ] as const) assert.throws(() => cleanEntry(body as Record<string, unknown>, "pavi", AT), why);
});

test("a status report is one of four states, with what was served", () => {
  assert.deepEqual(cleanStatus({ state: "available", served: "gemini-3.1-pro-002", detail: "ok\\nfine" }, AT), { state: "available", at: AT, served: "gemini-3.1-pro-002", detail: "ok\\nfine" });
  assert.deepEqual(cleanStatus({ state: "refused", detail: "not supported\n" }, AT), { state: "refused", at: AT, detail: "not supported" });
  assert.throws(() => cleanStatus({ state: "great" }, AT), /available, refused, slow or unknown/);
});

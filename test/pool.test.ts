import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEntry, cleanNote, cleanStatus, familyOf, latestNote, LOCAL_BUILD, noteLine } from "../src/models/pool.ts";

const AT = "2026-10-04T12:00:00.000Z";

test("a note is dated text under a model, naming the task it concerns when it does", () => {
  assert.deepEqual(cleanNote({ text: "  Commits\nwithout the full suite.  ", item: "t406", project: "atelier" }, "pavi", AT), { at: AT, by: "pavi", text: "Commits without the full suite.", item: "t406", project: "atelier" });
  assert.deepEqual(cleanNote({ text: "Stalls on long refactors." }, "pavi", AT), { at: AT, by: "pavi", text: "Stalls on long refactors." });
  for (const [body, why] of [
    [{ text: " \u0001 " }, /needs text/],
    [{ text: "x".repeat(501) }, /at most 500/],
    [{ text: `key ${["sk-proj-", "AbC123xyzQrS456"].join("")}` }, /carries a key/],
    [{ text: "fine", item: "406", project: "alpha" }, /such as t406/],
    [{ text: "fine", item: "t1 and t2", project: "alpha" }, /such as t406/],
    [{ text: "fine", item: "t1" }, /names its project/],
    [{ text: "fine", project: "alpha" }, /names a project only with the task/],
    [{ text: "fine", item: "t1", project: "p".repeat(101) }, /at most 100/],
  ] as const) assert.throws(() => cleanNote(body as Record<string, unknown>, "pavi", AT), why);
});

test("the latest note that bears on a task names its project and id, so another project's same id is not it", () => {
  const entry = {
    notes: [
      { at: "2026-10-01T09:00:00.000Z", by: "pavi", text: "Stalls on long refactors." },
      { at: "2026-10-02T09:00:00.000Z", by: "pavi", text: "Only alpha t1 is affected.", item: "t1", project: "alpha" },
      { at: "2026-10-03T09:00:00.000Z", by: "pavi", text: "Only beta t1 is affected.", item: "t1", project: "beta" },
      { at: "2026-10-04T09:00:00.000Z", by: "pavi", text: "Only alpha t9 is affected.", item: "t9", project: "alpha" },
      { at: "2026-10-05T09:00:00.000Z", by: "pavi", text: "Legacy, no project.", item: "t1" },
    ],
  };
  assert.equal(latestNote(entry, "alpha", "t1")?.text, "Only alpha t1 is affected.");
  assert.equal(latestNote(entry, "beta", "t1")?.text, "Only beta t1 is affected.");
  assert.equal(latestNote(entry, "gamma", "t1")?.text, "Stalls on long refactors.");
  assert.equal(latestNote(entry, "alpha", "t9")?.text, "Only alpha t9 is affected.");
  assert.equal(latestNote({}, "alpha", "t1"), undefined);
  assert.equal(noteLine(entry.notes[1]), "Latest note, 2026-10-02 by pavi on alpha/t1: Only alpha t1 is affected.");
  assert.equal(noteLine(entry.notes[0]), "Latest note, 2026-10-01 by pavi: Stalls on long refactors.");
  assert.equal(noteLine({ ...entry.notes[1], projectName: "alpha-renamed" }), "Latest note, 2026-10-02 by pavi on alpha-renamed/t1: Only alpha t1 is affected.");
});

test("families are recognised by name, so new releases need no update", () => {
  for (const [name, family] of [
    ["opus-5.5", "anthropic"], ["claude-sonnet-5-5", "anthropic"], ["gpt-6-astra", "openai"], ["gpt-6.1", "openai"],
    ["glm-5.3", "zai"], ["GLM-5.4-Flash-4_8bit", "zai"], ["gemini-3.1-pro", "google"], ["gemma-4", "google"],
    ["DeepSeek-V4-Flash-0731-MXFP4-MLX", "deepseek"], ["deepseek-chat", "deepseek"], ["Qwen3-Coder-Next-4bit:studio-code", "qwen"],
    ["MiniMax-M3-Alis-MLX-Dynamic", "minimax"], ["devstral-2", "mistral"], ["llama-5", "meta"], ["mystery-1", "other"],
    ["kimi-k2-0711", "moonshot"], ["moonshot-v1-8k", "moonshot"], ["moonshotai/kimi-k2", "moonshot"],
    ["grok-4", "xai"], ["x-ai/grok-4-fast", "xai"],
    ["mimo-7b-rl", "xiaomi"], ["xiaomi/mimo-7b", "xiaomi"],
    ["seed-1.6-flash", "bytedance"], ["bytedance/seed-oss-36b", "bytedance"], ["doubao-1.5-pro", "bytedance"],
    ["command-a", "cohere"], ["cohere/command-r-plus", "cohere"], ["north", "cohere"],
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
    [{ id: "x", harness: "opencode", where: "home", keychain: "has space" }, /name of a Keychain entry/],
    [{ id: "has/slash", harness: "opencode", where: "home" }, /not a model id/],
    [{ id: "x", harness: "bash", where: "home" }, /harness must be/],
    [{ id: "x", harness: "codex", where: "moon" }, /home or cloud/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "openai-compatible", endpoint: "https://api.example.com/v1?api_key=abc" }, /query or fragment/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "google", keychain: "AIzaSyD-abcdefghijklmnopqrstuvwxyz012345" }, /never the key itself/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "openai", keychain: "sk-proj-abc" }, /never the key itself/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "deepseek", keychain: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" }, /never the key itself/],
    [{ id: "x", harness: "opencode", where: "cloud" }, /which provider serves/],
    [{ id: "sk-proj-AbC123xyzQrS456", harness: "codex", where: "cloud" }, /model id looks like a key/],
    [{ id: "x", harness: "codex", where: "cloud", aliases: "fine, sk-proj-AbC123xyzQrS456" }, /alias looks like a key/],
    [{ id: "x", harness: "codex", where: "cloud", note: "key is AIzaSyD-abcdefghijklmnopqrstu" }, /note looks like it carries a key/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "openai-compatible", endpoint: "https://api.example.com/v1/sk-proj-AbC123xyzQrS456/chat" }, /path looks like it carries a key/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "openai-compatible", endpoint: "https://api.example.com/k/AbCdEfGhIjKlMnOpQrStUvWxYz012345/v1" }, /path looks like it carries a key/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "google", keychain: "my.sk-proj-abc.entry" }, /never the key itself/],
    [{ id: "x", harness: "zcode", where: "cloud", keychain: "0f3a9c2b7d4e1f6a8b5c3d2e1f0a9b8c.Xy7Zq2Lm9Np4Rs6T" }, /never the key itself/],
    [{ id: "x", harness: "opencode", where: "cloud", provider: "openai-compatible", endpoint: "https://open.bigmodel.cn/k/0f3a9c2b7d4e1f6a8b5c3d2e1f0a9b8c.Xy7Zq2Lm9Np4Rs6T/v1" }, /path looks like it carries a key/],
    [{ id: "m".repeat(65), harness: "codex", where: "cloud" }, /not a model id/],
  ] as const) assert.throws(() => cleanEntry(body as Record<string, unknown>, "pavi", AT), why);
});

test("a status report is one of four states, with what was served", () => {
  assert.deepEqual(cleanStatus({ state: "available", served: "gemini-3.1-pro-002" }, AT, "home:studio"), { state: "available", at: AT, by: "home:studio", served: "gemini-3.1-pro-002" });
  // Control characters become spaces, in the served name too; spaces at the ends are trimmed.
  assert.deepEqual(cleanStatus({ state: "refused", served: "evil\u001b[2Jname", detail: "not\nsupported\u009b" }, AT, "home:studio"),
    { state: "refused", at: AT, by: "home:studio", served: "evil [2Jname", detail: "not supported" });
  assert.throws(() => cleanStatus({ state: "great" }, AT, "home:studio"), /available, refused, slow or unknown/);
  // A key echoed back in an error is removed before it is stored or shown.
  assert.equal(cleanStatus({ state: "refused", detail: "invalid key sk-proj-AbC123xyz for model; also 0f3a9c2b7d4e1f6a8b5c3d2e1f0a9b8c.Xy7Zq2Lm9Np4Rs6T" }, AT, "home:studio").detail,
    "invalid key [key removed] for model; also [key removed]");
  // Ordinary words are left alone in a report.
  assert.equal(cleanStatus({ state: "refused", detail: "task-model flask_app ask-me: rate limited" }, AT, "home:studio").detail, "task-model flask_app ask-me: rate limited");
  assert.equal(cleanStatus({ state: "refused", detail: "bad key hf_ABCDEF1234567890abcd" }, AT, "home:studio").detail, "bad key [key removed]");
  // Names that are not keys pass: model names, entry names, endpoints.
  for (const fine of ["gemini.API_KEY", "ai-studio.OMLX_API_KEY", "deepseek.API_KEY", "flask_app", "task-runner.KEY", "desk_top.API"]) assert.doesNotThrow(() => cleanEntry({ id: "x", harness: "codex", where: "cloud", keychain: fine }, "pavi", AT));
  for (const fine of ["https://api.deepseek.com/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "https://openrouter.ai/api/v1", "http://10.0.0.110:8000/v1", "https://api.example.com/ask-me/v1", "https://x.test/task-model/v1"])
    assert.doesNotThrow(() => cleanEntry({ id: "x", harness: "opencode", where: "cloud", provider: "openai-compatible", endpoint: fine }, "pavi", AT));
});

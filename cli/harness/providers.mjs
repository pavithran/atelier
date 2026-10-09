// The providers opencode reaches for Atelier, and the provider configs
// `atelier runner setup` writes for them (docs/runners.md, "Setting up a
// runner"). Each config names the variable its key is read from, never the
// key; the opencode adapter (cli/harness/adapter.mjs) reads the key from the
// credential store at run time and puts it in that variable for opencode
// alone.
//
// Limits. opencode trims a conversation to the context its config gives a
// model and asks for at most the output it gives, so a limit above what the
// provider serves fails the run mid-build (two such limits were wrong on
// 2026-10-09), and a context below what the harness itself starts with
// (system prompt, tool definitions, the brief) leaves the model no room to
// work. `checkLimits` refuses both. What a provider serves comes from the
// provider where it says (OpenRouter's model list, a local server's model
// list), else from SERVED below, the providers' own figures as written down on
// the date beside them. Correct an entry here when a provider changes.

// The context each harness fills before the model reads the task: its system
// prompt and tool definitions, measured from its first request, with room for
// the brief Atelier sends (cut at 40,000 characters, about 10,000 tokens).
export const HARNESS_START = {
  opencode: 24_000,
  "claude-code": 32_000,
  codex: 24_000,
  antigravity: 24_000,
};

// The providers, by the name the generated config gives them. `gateway` is the
// AI Gateway's segment for the provider (the base URL becomes
// https://gateway.ai.cloudflare.com/v1/ACCOUNT/GATEWAY/SEGMENT); a provider
// without one goes direct. `key` is the default credential store entry for the
// provider's key, which a pool entry's own `keychain` overrides; `keyVar` the
// variable opencode reads it from.
export const PROVIDERS = {
  "zai-coding": { name: "Z.ai Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4", key: "zai.API_KEY", keyVar: "ZAI_API_KEY" },
  "deepseek-api": { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", gateway: "deepseek", key: "deepseek.API_KEY", keyVar: "DEEPSEEK_API_KEY" },
  "openrouter-api": { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", gateway: "openrouter", key: "openrouter.API_KEY", keyVar: "OPENROUTER_API_KEY" },
  "ai-studio": { name: "AI Studio", keyVar: "AI_STUDIO_API_KEY", local: true },
};

// What each provider serves for a model, by the provider's model id, and the
// date it was read. Providers that publish a model list with limits
// (OpenRouter, a local server) are asked at setup and these are not used.
export const SERVED = {
  "zai-coding": {
    "glm-5.3": { context: 200_000, output: 128_000, at: "2026-10-09" },
  },
  "deepseek-api": {
    "deepseek-v4-pro": { context: 128_000, output: 64_000, at: "2026-10-09" },
  },
};

// The limits Atelier configures for a model it knows, below what is served
// where a run needs the headroom; a model not listed is configured at what
// its provider serves.
export const CONFIGURED = {
  "zai-coding": { "glm-5.3": { context: 200_000, output: 32_000 } },
  "deepseek-api": { "deepseek-v4-pro": { context: 128_000, output: 32_000 } },
};

// The output a model is configured for when its provider gives a context but
// no output limit.
const DEFAULT_OUTPUT = 32_000;

// The provider a pool entry runs through, from what the pool records:
// { provider, providerModel, baseURL? } or { refused }.
export function providerFor(entry) {
  const endpoint = typeof entry.endpoint === "string" ? entry.endpoint.replace(/\/+$/, "") : "";
  if (entry.provider === "deepseek") return { provider: "deepseek-api", providerModel: entry.id };
  if (entry.provider === "openrouter") return { provider: "openrouter-api", providerModel: null };
  if (entry.provider === "openai-compatible" && /^https:\/\/api\.z\.ai\//.test(endpoint)) return { provider: "zai-coding", providerModel: entry.id };
  if (entry.provider === "ai-studio" || entry.provider === "openai-compatible") {
    if (!endpoint) return { refused: `the pool gives ${entry.id} no endpoint, so Atelier cannot say where opencode should reach it (atelier models add ${entry.id} --endpoint URL)` };
    return { provider: "ai-studio", providerModel: entry.id, baseURL: endpoint };
  }
  return { refused: `opencode cannot serve ${entry.id} from provider ${entry.provider}` };
}

// An OpenRouter model id, VENDOR/MODEL, for the Atelier id the pool records,
// VENDOR-MODEL (a model id holds no "/"): the one listed id that reads as it
// with its "/" made "-". Two that do, or none, leave it unresolved.
export function openRouterId(atelierId, listed) {
  const hits = listed.filter((m) => typeof m.id === "string" && m.id.replace(/\//g, "-").toLowerCase() === atelierId.toLowerCase());
  return hits.length === 1 ? hits[0] : null;
}

// What OpenRouter serves for one listed model: its context length and the
// most output its top provider gives.
export function openRouterServed(listed) {
  const context = listed.top_provider?.context_length ?? listed.context_length;
  const output = listed.top_provider?.max_completion_tokens ?? undefined;
  return Number.isInteger(context) ? { context, ...(Number.isInteger(output) ? { output } : {}) } : null;
}

// What a local OpenAI-compatible server says it serves for one model, from
// its model list: LM Studio's max_context_length (or the context it loaded
// the model with, which is what it actually serves), vLLM's max_model_len, or
// a context_length field.
export function localServed(listed) {
  const context = listed.loaded_context_length ?? listed.max_context_length ?? listed.max_model_len ?? listed.context_length;
  return Number.isInteger(context) ? { context } : null;
}

// Whether a model's configured limits fit: null when they do, else why not.
// An output the provider does not state is bounded by the served context.
export function checkLimits(model, configured, served, harness = "opencode") {
  if (!served) return `Atelier cannot tell what its provider serves for ${model}, so it cannot check the limits it would configure`;
  if (configured.context > served.context) return `${model} would be configured for a context of ${configured.context} tokens, but its provider serves ${served.context}`;
  const outputCap = served.output ?? served.context;
  if (configured.output > outputCap) return `${model} would be configured for ${configured.output} output tokens, but its provider serves ${outputCap}`;
  if (configured.output >= configured.context) return `${model} would be configured for ${configured.output} output tokens, no less than its context of ${configured.context}`;
  const start = HARNESS_START[harness] ?? 0;
  if (configured.context < start) return `${model}'s context of ${configured.context} tokens is below the ${start} that ${harness} itself starts with, so the model would have no room to work`;
  return null;
}

// The limits Atelier would configure for a model: its CONFIGURED entry, else
// what the provider serves (its output capped at DEFAULT_OUTPUT and below the
// context).
export function configuredLimits(provider, providerModel, served, configured = CONFIGURED) {
  const known = configured[provider]?.[providerModel];
  if (known) return { ...known };
  if (!served) return null;
  const output = Math.min(served.output ?? DEFAULT_OUTPUT, DEFAULT_OUTPUT, Math.floor(served.context / 4));
  return { context: served.context, output };
}

// The AI Gateway's base URL for a provider, when the runner goes through one.
export function gatewayURL(gateway, segment) {
  return `https://gateway.ai.cloudflare.com/v1/${gateway.account}/${gateway.id}/${segment}`;
}

// The variable the generated configs read the gateway metadata from. opencode
// replaces each {env:VAR} in the config's raw text before it parses the text,
// so a variable holding JSON, quotes and all, inside a JSON string ends the
// string early and every config fails to parse (t389's run, 2026-10-09). The
// adapter therefore sets this variable to CF_AIG_METADATA escaped for a JSON
// string (metadataEscaped), and the parsed header is the JSON itself.
export const METADATA_VAR = "CF_AIG_METADATA_ESCAPED";
export const GATEWAY_TOKEN_VAR = "CF_AIG_TOKEN";
export const GATEWAY_TOKEN_KEY = "CF_AIG_TOKEN";

// CF_AIG_METADATA (the runner's JSON object, gatewayMetadata in runner.mjs)
// made safe to substitute inside a JSON string: the text JSON.stringify gives
// it, without the outer quotes. A value that is not a JSON object becomes {}.
export function metadataEscaped(raw) {
  let value;
  try { value = JSON.parse(raw ?? ""); } catch { value = null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  return JSON.stringify(JSON.stringify(value)).slice(1, -1);
}

// What opencode does to a config's text before it parses it: each {env:VAR}
// becomes the variable's value, or nothing. Here so a test can show that a
// generated config survives it.
export function substituteEnv(text, env) {
  return text.replace(/\{env:([^}]+)\}/g, (_, name) => env[name] ?? "");
}

// The permissions every generated config gives the agent: it edits and runs
// commands in its workspace and nothing outside it, may stage and commit
// (named explicitly: on 2026-10-09 the Studio config refused git commit, and
// the build ended with no commit), and may not push or run Atelier.
export const PERMISSION = {
  edit: "allow",
  webfetch: "deny",
  external_directory: "deny",
  bash: {
    "*": "allow",
    "git push*": "deny",
    "atelier*": "deny",
    "git add *": "allow",
    "git commit *": "allow",
  },
};

// One provider's opencode config, for the models given as
// [{ providerModel, atelierId, limit }]. No key: the key's variable only.
export function opencodeConfig(provider, models, { baseURL, gateway } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unknown provider ${provider}`);
  const viaGateway = !!(gateway && spec.gateway);
  const headers = { "cf-aig-metadata": `{env:${METADATA_VAR}}` };
  if (viaGateway) headers["cf-aig-authorization"] = `Bearer {env:${GATEWAY_TOKEN_VAR}}`;
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    mcp: {},
    permission: PERMISSION,
    provider: {
      [provider]: {
        npm: "@ai-sdk/openai-compatible",
        name: spec.name,
        options: {
          baseURL: viaGateway ? gatewayURL(gateway, spec.gateway) : (baseURL ?? spec.baseURL),
          apiKey: `{env:${spec.keyVar}}`,
          headers,
        },
        models: Object.fromEntries(models.map((m) => [m.providerModel, { name: m.atelierId, limit: { context: m.limit.context, output: m.limit.output } }])),
      },
    },
  };
}

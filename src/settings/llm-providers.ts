export interface LlmProvider {
  id: string;
  name: string;
  envKey: string;
  defaultBaseUrl?: string;
  models: { id: string; name: string }[];
  /**
   * How the credential is entered. `"apiKey"` (default) is a single-line key
   * set in the Environment Variables editor. `"json"` is a multi-line blob
   * (e.g. a Vertex service-account JSON) entered inline and stored in the OS
   * keychain by the backend.
   */
  credentialKind?: "apiKey" | "json";
}

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-r1", name: "DeepSeek R1" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
    ],
  },
  {
    id: "vertex",
    name: "Google Vertex AI",
    envKey: "VERTEX_SA_JSON",
    credentialKind: "json",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    models: [{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" }],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    envKey: "",
    defaultBaseUrl: "http://localhost:11434",
    models: [],
  },
  { id: "dashscope", name: "DashScope", envKey: "DASHSCOPE_API_KEY", models: [] },
  { id: "nvidia", name: "NVIDIA", envKey: "NVIDIA_API_KEY", models: [] },
  {
    id: "minimax",
    name: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    models: [
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
      { id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    ],
  },
  { id: "zhipu", name: "Zhipu (GLM)", envKey: "ZHIPU_API_KEY", models: [] },
  { id: "moonshot", name: "Moonshot", envKey: "MOONSHOT_API_KEY", models: [] },
  { id: "perplexity", name: "Perplexity", envKey: "PERPLEXITY_API_KEY", models: [] },
  {
    id: "mistral",
    name: "Mistral",
    envKey: "MISTRAL_API_KEY",
    models: [{ id: "mistral-large-2512", name: "Mistral Large" }],
  },
  { id: "openrouter", name: "OpenRouter", envKey: "OPENROUTER_API_KEY", models: [] },
  {
    id: "vllm",
    name: "vLLM",
    envKey: "VLLM_API_KEY",
    defaultBaseUrl: "http://localhost:8000",
    models: [],
  },
  { id: "__custom_family__", name: "Custom Provider", envKey: "", models: [] },
];

/** Find provider by ID, falling back to custom */
export function findProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** Whether this provider should show a base URL field */
export function showsBaseUrl(provider: LlmProvider): boolean {
  return (
    provider.id === "ollama" ||
    provider.id === "vllm" ||
    provider.id === "__custom_family__"
  );
}

/** Whether this provider's credential is a multi-line JSON blob (entered inline). */
export function usesJsonCredential(provider: LlmProvider | undefined): boolean {
  return provider?.credentialKind === "json";
}

/**
 * Build the env_vars patch for a JSON-credential provider. Returns the full
 * existing map with the credential overlaid (so the backend's masked-value
 * merge preserves other keys), or `undefined` when nothing should change
 * (non-JSON provider, or a blank input meaning "keep what's stored").
 */
export function buildCredentialEnvPatch(
  provider: LlmProvider | undefined,
  existing: Record<string, string>,
  credentialInput: string,
): Record<string, string> | undefined {
  if (!usesJsonCredential(provider)) return undefined;
  const value = credentialInput.trim();
  if (!value) return undefined;
  return { ...existing, [provider!.envKey]: value };
}

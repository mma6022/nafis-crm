import OpenAI from "openai";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export type ConsultationProviderConfig = {
  provider: "gemini" | "replit-openai";
  apiKey: string;
  baseURL: string;
  model: string;
};

export function resolveConsultationProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ConsultationProviderConfig {
  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    const configuredGeminiModel = env.GEMINI_MODEL?.trim() || undefined;
    if (configuredGeminiModel && !configuredGeminiModel.startsWith("gemini-")) {
      throw new Error("GEMINI_MODEL must be a Gemini model name.");
    }

    const openAiModel = env.OPENAI_MODEL?.trim();
    return {
      provider: "gemini",
      apiKey: geminiApiKey,
      baseURL: GEMINI_OPENAI_BASE_URL,
      model: configuredGeminiModel ??
        (openAiModel?.startsWith("gemini-") ? openAiModel : DEFAULT_GEMINI_MODEL),
    };
  }

  if (!env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }
  if (!env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }

  return {
    provider: "replit-openai",
    apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
  };
}

export function createConsultationClient(
  env: Record<string, string | undefined> = process.env,
) {
  const config = resolveConsultationProviderConfig(env);
  return {
    client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
    model: config.model,
    provider: config.provider,
  };
}
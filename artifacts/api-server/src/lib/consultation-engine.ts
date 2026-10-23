import { createConsultationClient } from "@workspace/integrations-openai-ai-server/consultation";

const consultation = createConsultationClient();

export type ConsultationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function assertConsultationFinishReason(
  finishReason: string | null | undefined,
  requireComplete = false,
): void {
  if (requireComplete && finishReason !== "stop") {
    throw new Error("INCOMPLETE_AI_RESPONSE");
  }
}

/**
 * Shared model invocation for staff consultations and public, thread-scoped
 * advice. GEMINI_API_KEY selects the direct Gemini OpenAI-compatible endpoint;
 * otherwise the existing Replit OpenAI integration is used.
 */
export async function invokeConsultationModel(
  messages: ConsultationMessage[],
  options: {
    maxCompletionTokens?: number;
    timeoutMs?: number;
    maxOutputChars?: number;
    maxOutputBytes?: number;
    requireComplete?: boolean;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const parameters = {
      model: consultation.model,
      max_completion_tokens: options.maxCompletionTokens ?? 1200,
      messages,
    };
    const request = timeoutMs
      ? consultation.client.chat.completions.create(parameters, { timeout: timeoutMs, maxRetries: 0 })
      : consultation.client.chat.completions.create(parameters);
    const completion = timeoutMs
      ? await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("CONSULTATION_MODEL_TIMEOUT")), timeoutMs);
            timeout.unref();
          }),
        ])
      : await request;
    assertConsultationFinishReason(completion.choices[0]?.finish_reason, options.requireComplete);
    const answer = completion.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error("EMPTY_AI_RESPONSE");
    if (options.maxOutputChars && answer.length > options.maxOutputChars) {
      throw new Error("AI_RESPONSE_TOO_LARGE");
    }
    if (options.maxOutputBytes && Buffer.byteLength(answer, "utf8") > options.maxOutputBytes) {
      throw new Error("AI_RESPONSE_TOO_LARGE");
    }
    return answer;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
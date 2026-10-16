import {
  GRADING_OUTPUT_JSON_SCHEMA,
  GradingOutputSchema,
  type GradingOutput
} from './schema';
import {
  buildGradingPrompt,
  type BuildGradingPromptParams
} from './prompt';

export interface EvaluateDocumentOptions {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  temperature?: number;
}

const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_TEMPERATURE = 0.1;

/**
 * Menghitung ulang `final_weighted_score` secara deterministik di backend
 * menggunakan rumus: SUM(score_given * (weight_percentage / 100))
 * dibulatkan 2 angka di belakang koma, lalu meng-override nilai dari LLM.
 */
export function verifyAndRecalculateScore(output: GradingOutput): GradingOutput {
  const rawTotal = output.grading_breakdown.reduce((acc, item) => {
    return acc + item.score_given * (item.weight_percentage / 100);
  }, 0);

  const roundedScore = Math.round((rawTotal + Number.EPSILON) * 100) / 100;
  const clampedScore = Math.min(100, Math.max(0, roundedScore));

  return {
    ...output,
    final_weighted_score: clampedScore
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RetryableGradingError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RetryableGradingError';
  }
}

/**
 * Mengevaluasi dokumen tugas mahasiswa menggunakan Google Gemini Structured Outputs,
 * memvalidasi kontrak JSON via Zod, dan menghitung ulang skor akhir secara deterministik.
 */
export async function evaluateDocument(
  params: BuildGradingPromptParams,
  options: EvaluateDocumentOptions = {}
): Promise<GradingOutput> {
  const apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing API Key: Berikan options.apiKey atau set environment variable LLM_API_KEY / GEMINI_API_KEY.'
    );
  }

  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  const { systemInstruction, userPrompt } = buildGradingPrompt(params);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
            responseSchema: GRADING_OUTPUT_JSON_SCHEMA
          }
        })
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        // Rate limit (429) atau Server Error (5xx) dapat di-retry
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableGradingError(
            `Gemini API HTTP ${response.status}: ${errorBody || response.statusText}`,
            response.status
          );
        }
        throw new Error(
          `Gemini API gagal dengan status ${response.status}: ${errorBody || response.statusText}`
        );
      }

      const payload = await response.json();
      const rawText: string | undefined =
        payload?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText || typeof rawText !== 'string') {
        throw new RetryableGradingError(
          'Respons Gemini API tidak mengandung teks kandidat JSON yang valid.'
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (parseErr) {
        throw new RetryableGradingError(
          'Gagal melakukan JSON.parse pada output LLM.',
          undefined,
          parseErr
        );
      }

      let validatedOutput: GradingOutput;
      try {
        validatedOutput = GradingOutputSchema.parse(parsedJson);
      } catch (validationErr) {
        const message =
          validationErr instanceof Error
            ? validationErr.message
            : String(validationErr);
        throw new RetryableGradingError(
          `Validasi Zod gagal: ${message}`,
          undefined,
          validationErr
        );
      }

      return verifyAndRecalculateScore(validatedOutput);
    } catch (error) {
      lastError = error;

      const isRetryable =
        error instanceof RetryableGradingError ||
        (error instanceof TypeError && error.message.includes('fetch'));

      if (!isRetryable || attempt >= maxRetries) {
        break;
      }

      const backoffDelay = baseDelayMs * Math.pow(2, attempt);
      await sleep(backoffDelay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gagal mengevaluasi dokumen setelah batas percobaan maksimum.');
}

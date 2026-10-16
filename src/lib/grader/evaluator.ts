import {
  GRADING_OUTPUT_JSON_SCHEMA,
  GradingOutputSchema,
  type GradingOutput
} from './schema';
import {
  buildGradingPrompt,
  MAX_DOCUMENT_CHAR_LENGTH,
  truncateDocumentText,
  type BuildGradingPromptParams
} from './prompt';

export interface EvaluateDocumentOptions {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxRetryDelayMs?: number;
  temperature?: number;
}

export interface ExtractedIdentityFallback {
  name?: string;
  id?: string;
}

export const MIN_DOCUMENT_WORD_COUNT = 20;
export const EMPTY_DOCUMENT_REASONING =
  'Dokumen kosong atau tidak terbaca (< 20 kata, indikasi scan gambar/corrupt). Tidak memotong token API.';

export const GEMINI_ROTATION_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite'
] as const;

const DEFAULT_GEMINI_MODEL = GEMINI_ROTATION_MODELS[0];
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
export const MAX_SMART_RETRY_DELAY_MS = 15000;
const DEFAULT_TEMPERATURE = 0.1;

const FILENAME_STOP_TOKENS = new Set([
  'uas',
  'uts',
  'tugas',
  'makalah',
  'laporan',
  'esai',
  'essay',
  'analisis',
  'studi',
  'kasus',
  'rpl',
  'si',
  'ti',
  'if',
  'ilkom',
  'sistem',
  'informasi',
  'rekayasa',
  'perangkat',
  'lunak',
  'fix',
  'final',
  'revisi',
  'rev',
  'update',
  'baru',
  'draft',
  'v1',
  'v2',
  'v3',
  'kelas',
  'kelompok',
  'submission',
  'doc',
  'dokumen',
  'file',
  'copy',
  'scan',
  'kosong',
  'mahasiswa',
  'jawaban',
  'soal'
]);

function toTitleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.length > 0
        ? word[0].toUpperCase() + word.slice(1).toLowerCase()
        : ''
    )
    .join(' ');
}

/**
 * Membaca informasi "retryDelay" dari response error JSON Google Gemini (misal "28s" atau "12.5s")
 * saat seluruh model rotasi terkena HTTP 429, dengan batas tunggu maksimal `maxCapMs` (default 15 detik).
 */
export function parseGoogleRetryDelayMs(
  errorBody: string,
  maxCapMs: number = MAX_SMART_RETRY_DELAY_MS
): number | null {
  if (!errorBody || typeof errorBody !== 'string') {
    return null;
  }

  const retryDelayFieldMatch = errorBody.match(
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i
  );
  const retryInMessageMatch = errorBody.match(
    /retry\s+in\s+(\d+(?:\.\d+)?)s/i
  );

  const secondsStr = retryDelayFieldMatch?.[1] ?? retryInMessageMatch?.[1];
  if (!secondsStr) {
    return null;
  }

  const parsedSeconds = parseFloat(secondsStr);
  if (Number.isNaN(parsedSeconds) || parsedSeconds <= 0) {
    return null;
  }

  const delayMs = Math.ceil(parsedSeconds * 1000);
  return Math.min(maxCapMs, delayMs);
}

/**
 * Fallback ekstraksi identitas lokal (Regex) jika LLM mengembalikan "Tidak Tertera".
 * Mencari Nama Mahasiswa dan NIM/NPM dari bagian awal teks dokumen (header/cover)
 * maupun dari pola penamaan file (contoh: `UAS_RPL_112204510088_Rizky_Pratama.pdf`).
 */
export function extractIdentityFallback(
  text: string,
  filename: string
): ExtractedIdentityFallback {
  let extractedName: string | undefined;
  let extractedId: string | undefined;

  const headerSlice = (text ?? '').slice(0, 2000);

  // 1. Cari Nama Mahasiswa eksplisit di teks awal
  const nameLabelMatch = headerSlice.match(
    /(?:^|\n)\s*(?:nama(?:\s+mahasiswa|\s+lengkap)?|name|disusun\s+oleh|oleh)\s*[:=-]\s*([^\r\n|()[\]{}<>0-9]{2,60})/i
  );
  if (nameLabelMatch?.[1]) {
    const candidateName = nameLabelMatch[1]
      .replace(/\b(?:nim|npm|nrp|kelas)\b.*$/i, '')
      .trim();
    if (candidateName.length >= 2) {
      extractedName = candidateName;
    }
  }

  // 2. Cari NIM / NPM / ID eksplisit berlabel di teks awal (mendukung titik, strip, garis miring, atau spasi antar blok angka)
  const idLabelMatch = headerSlice.match(
    /(?:^|\n|\b)(?:nim|npm|nrp|no\.?\s*(?:induk|pokok|mahasiswa)|student\s*id|id\s*mahasiswa)\s*[:=-]?\s*([A-Za-z0-9]{2,}(?:[./-][A-Za-z0-9]{1,})+|\d{4}\s+\d{3,5}\s+\d{2,5}|\d{8,15})/i
  );
  if (idLabelMatch?.[1]) {
    extractedId = idLabelMatch[1].trim().replace(/\s+/g, '');
  }

  // 3. Jika belum ketemu ID berlabel di teks, cari pola mandiri NIM di teks awal
  if (!extractedId) {
    const standaloneDottedMatch = headerSlice.match(
      /\b(\d{2,4}(?:\.\d{2,4}){2,4}|\d{4}\/[A-Za-z]{2,6}\/\d{2,6}|\d{8,15})\b/
    );
    if (standaloneDottedMatch?.[1]) {
      extractedId = standaloneDottedMatch[1].trim();
    }
  }

  // 4. Ekstraksi dari nama file jika Nama atau NIM masih belum ditemukan
  if ((!extractedId || !extractedName) && filename) {
    const baseFilename =
      filename
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.replace(/\.[a-zA-Z0-9]+$/, '') ?? '';

    const fileDottedId = baseFilename.match(
      /(?:^|[_-\s])(\d{2,4}(?:\.\d{2,4}){2,4}|\d{8,15})(?:$|[_-\s])/
    );
    const fileIdFound = fileDottedId?.[1];

    if (!extractedId && fileIdFound) {
      extractedId = fileIdFound;
    }

    // Hanya ekstrak nama dari nama file jika nama file mengikuti konvensi yang menyertakan NIM/ID
    if (!extractedName && (fileIdFound || extractedId)) {
      const rawTokens = baseFilename.split(/[_-\s]+/).filter(Boolean);
      const nameTokens: string[] = [];

      for (const token of rawTokens) {
        const lower = token.toLowerCase();
        if (
          /^\d+$/.test(token) ||
          /^\d+(?:\.\d+)+$/.test(token) ||
          /^[a-z]{1,3}\d+[a-z]?$/i.test(token) ||
          FILENAME_STOP_TOKENS.has(lower) ||
          token.length < 2
        ) {
          continue;
        }

        if (/^[a-zA-Z'.]+$/.test(token)) {
          nameTokens.push(token);
        }
      }

      if (nameTokens.length >= 1) {
        extractedName = toTitleCase(nameTokens.join(' '));
      }
    }
  }

  return {
    ...(extractedName ? { name: extractedName } : {}),
    ...(extractedId ? { id: extractedId } : {})
  };
}

/**
 * Mengisi `extracted_name` atau `extracted_id` yang bernilai "Tidak Tertera"
 * menggunakan hasil `extractIdentityFallback` lokal.
 */
export function applyIdentityFallback(
  output: GradingOutput,
  text: string,
  filename: string
): GradingOutput {
  const needsName =
    !output.student_identity.extracted_name ||
    output.student_identity.extracted_name === 'Tidak Tertera';
  const needsId =
    !output.student_identity.extracted_id ||
    output.student_identity.extracted_id === 'Tidak Tertera';

  if (!needsName && !needsId) {
    return output;
  }

  const fallback = extractIdentityFallback(text, filename);

  return {
    ...output,
    student_identity: {
      ...output.student_identity,
      extracted_name:
        needsName && fallback.name
          ? fallback.name
          : output.student_identity.extracted_name,
      extracted_id:
        needsId && fallback.id
          ? fallback.id
          : output.student_identity.extracted_id
    }
  };
}

/**
 * Menghitung jumlah kata pada teks dokumen.
 */
export function countDocumentWords(text: string): number {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

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
    public readonly cause?: unknown,
    public readonly rotatedModel: boolean = false,
    public readonly retryDelayMs?: number
  ) {
    super(message);
    this.name = 'RetryableGradingError';
  }
}

/**
 * Mengevaluasi dokumen tugas mahasiswa menggunakan Google Gemini Structured Outputs,
 * dilengkapi dengan:
 * - Empty Text Pre-Filter (< 20 kata bypass langsung di backend tanpa panggil API Gemini)
 * - Token Exhaustion Guard (hard truncate maksimal 30.000 karakter)
 * - Multi-Model Quota Rotation saat HTTP 429 / 404 (beralih instan antar model Free Tier)
 * - Smart Retry Delay (membaca retryDelay dari error JSON Google, dibatasi maks 15 detik)
 * - Fallback Ekstraksi Identitas Lokal (Regex teks & nama file)
 * - Validasi kontrak JSON via Zod dan kalkulasi ulang skor akhir secara deterministik.
 */
export async function evaluateDocument(
  params: BuildGradingPromptParams,
  options: EvaluateDocumentOptions = {}
): Promise<GradingOutput> {
  const truncatedText = truncateDocumentText(
    params.extractedDocumentText ?? '',
    MAX_DOCUMENT_CHAR_LENGTH
  );
  const wordCount = countDocumentWords(truncatedText);

  // Empty Text Pre-Filter: Bypass panggilan ke LLM jika dokumen < 20 kata
  if (wordCount < MIN_DOCUMENT_WORD_COUNT) {
    const emptyOutput: GradingOutput = {
      student_identity: {
        extracted_name: 'Tidak Tertera',
        extracted_id: 'Tidak Tertera',
        filename: params.originalFilename
      },
      grading_breakdown: params.rubricCriteria.map((criterion) => ({
        criterion_name: criterion.name,
        weight_percentage: criterion.weightPercentage,
        score_given: 0,
        short_reasoning: EMPTY_DOCUMENT_REASONING
      })),
      final_weighted_score: 0,
      feedback_for_student:
        'Dokumen yang dikumpulkan kosong atau memiliki teks kurang dari 20 kata (indikasi hasil scan gambar tanpa OCR atau file corrupt). Mohon periksa kembali file tugas Anda.',
      ai_writing_suspicion: 'Low'
    };

    return applyIdentityFallback(
      emptyOutput,
      truncatedText,
      params.originalFilename
    );
  }

  const apiKey =
    options.apiKey?.trim() ||
    process.env.LLM_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'Missing API Key: Berikan options.apiKey atau set environment variable LLM_API_KEY / GEMINI_API_KEY.'
    );
  }

  let currentModel =
    options.model?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    DEFAULT_GEMINI_MODEL;
  const triedModels = new Set<string>([currentModel]);

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxRetryDelayMs =
    options.maxRetryDelayMs ?? MAX_SMART_RETRY_DELAY_MS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  const { systemInstruction, userPrompt } = buildGradingPrompt({
    ...params,
    extractedDocumentText: truncatedText
  });

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      currentModel
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

        // Multi-Model Quota Rotation saat terkena HTTP 429 (Rate Limit / RESOURCE_EXHAUSTED) atau HTTP 404
        if (response.status === 429 || response.status === 404) {
          const nextRotationModel = GEMINI_ROTATION_MODELS.find(
            (m) => !triedModels.has(m)
          );

          if (nextRotationModel) {
            const prevModel = currentModel;
            currentModel = nextRotationModel;
            triedModels.add(nextRotationModel);
            throw new RetryableGradingError(
              `Gemini API HTTP ${response.status} pada model ${prevModel}, rotasi langsung ke model ${nextRotationModel}: ${errorBody || response.statusText}`,
              response.status,
              undefined,
              true
            );
          }

          // Jika seluruh model di daftar rotasi sudah dicoba dan terkena 429:
          // Reset daftar rotasi ke model pertama dan gunakan Smart Retry Delay dari response JSON Google
          if (response.status === 429) {
            triedModels.clear();
            currentModel = GEMINI_ROTATION_MODELS[0];
            triedModels.add(currentModel);

            const smartDelayMs = parseGoogleRetryDelayMs(
              errorBody,
              maxRetryDelayMs
            );
            throw new RetryableGradingError(
              `Seluruh model rotasi terkena HTTP 429: ${errorBody || response.statusText}`,
              429,
              undefined,
              false,
              smartDelayMs ?? undefined
            );
          }
        }

        // Server Error (5xx) dapat di-retry
        if (response.status >= 500) {
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

      const withIdentityFallback = applyIdentityFallback(
        validatedOutput,
        truncatedText,
        params.originalFilename
      );
      return verifyAndRecalculateScore(withIdentityFallback);
    } catch (error) {
      lastError = error;

      const isRetryable =
        error instanceof RetryableGradingError ||
        (error instanceof TypeError && error.message.includes('fetch'));

      if (!isRetryable || attempt >= maxRetries) {
        break;
      }

      if (error instanceof RetryableGradingError && error.rotatedModel) {
        // Jangan menunggu lama ketika melakukan failover ke model berbeda karena kuota dihitung PerModel
        const quickSwitchDelay = Math.min(baseDelayMs, 15);
        if (quickSwitchDelay > 0) {
          await sleep(quickSwitchDelay);
        }
      } else if (
        error instanceof RetryableGradingError &&
        typeof error.retryDelayMs === 'number'
      ) {
        await sleep(error.retryDelayMs);
      } else {
        const backoffDelay = baseDelayMs * Math.pow(2, attempt);
        await sleep(backoffDelay);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gagal mengevaluasi dokumen setelah batas percobaan maksimum.');
}

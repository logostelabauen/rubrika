import type { GradingOutput } from './schema';
import type { GradingTone, RubricCriterion } from './prompt';
import {
  evaluateDocument,
  type EvaluateDocumentOptions
} from './evaluator';

export interface BatchInputDocument {
  id?: string;
  originalFilename: string;
  extractedDocumentText: string;
}

export interface GradingConfig {
  assignmentContext: string;
  rubricCriteria: RubricCriterion[];
  tone: GradingTone;
  calibrationNotes?: string;
}

export interface IntegrityCheckResult {
  similarity_flagged: boolean;
  max_similarity_score: number;
  closest_match_file: string | null;
}

export interface SimilarityRecord extends IntegrityCheckResult {
  filename?: string;
  documentId?: string;
}

export type SimilarityResultsInput =
  | Record<string, IntegrityCheckResult>
  | Map<string, IntegrityCheckResult>
  | SimilarityRecord[];

export type BatchDocumentStatus = 'COMPLETED' | 'MANUAL_REVIEW_REQUIRED';

export interface BatchDocumentResult {
  document_id?: string;
  filename: string;
  status: BatchDocumentStatus;
  processed_at: string;
  integrity_check: IntegrityCheckResult;
  evaluation: GradingOutput | null;
  error_message?: string;
}

export interface CalibrationSampleItem {
  document_id?: string;
  filename: string;
  status: BatchDocumentStatus;
  processed_at: string;
  evaluation: GradingOutput | null;
  error_message?: string;
}

export interface CalibrationSampleOutput {
  sample_size: number;
  samples: CalibrationSampleItem[];
  remaining_documents: BatchInputDocument[];
}

export interface BatchGradingQueueOptions extends EvaluateDocumentOptions {
  concurrency?: number;
  onProgress?: (
    completed: number,
    total: number,
    latestResult: BatchDocumentResult
  ) => void;
}

const DEFAULT_SAMPLE_SIZE = 3;
const DEFAULT_BATCH_CONCURRENCY = 5;

const DEFAULT_INTEGRITY_CHECK: IntegrityCheckResult = {
  similarity_flagged: false,
  max_similarity_score: 0,
  closest_match_file: null
};

function resolveIntegrityCheck(
  doc: BatchInputDocument,
  similarityResults?: SimilarityResultsInput
): IntegrityCheckResult {
  if (!similarityResults) {
    return { ...DEFAULT_INTEGRITY_CHECK };
  }

  if (similarityResults instanceof Map) {
    const match =
      (doc.id ? similarityResults.get(doc.id) : undefined) ??
      similarityResults.get(doc.originalFilename);
    return match ? { ...match } : { ...DEFAULT_INTEGRITY_CHECK };
  }

  if (Array.isArray(similarityResults)) {
    const match = similarityResults.find(
      (item) =>
        (doc.id && item.documentId === doc.id) ||
        item.filename === doc.originalFilename
    );
    if (!match) {
      return { ...DEFAULT_INTEGRITY_CHECK };
    }
    return {
      similarity_flagged: match.similarity_flagged,
      max_similarity_score: match.max_similarity_score,
      closest_match_file: match.closest_match_file
    };
  }

  const recordMatch =
    (doc.id ? similarityResults[doc.id] : undefined) ??
    similarityResults[doc.originalFilename];
  return recordMatch ? { ...recordMatch } : { ...DEFAULT_INTEGRITY_CHECK };
}

/**
 * Menjalankan evaluasi sampel kalibrasi (dry run) pada maksimal N dokumen pertama
 * secara paralel agar dosen dapat meninjau hasil awal dan memberikan revisi `calibrationNotes`.
 */
export async function runCalibrationSample(
  docs: BatchInputDocument[],
  gradingConfig: GradingConfig,
  sampleSize: number = DEFAULT_SAMPLE_SIZE,
  options: EvaluateDocumentOptions = {}
): Promise<CalibrationSampleOutput> {
  const normalizedSampleSize = Math.max(0, Math.floor(sampleSize));
  const sampleDocs = docs.slice(0, normalizedSampleSize);
  const remainingDocs = docs.slice(normalizedSampleSize);

  const samples = await Promise.all(
    sampleDocs.map(async (doc): Promise<CalibrationSampleItem> => {
      try {
        const evaluation = await evaluateDocument(
          {
            assignmentContext: gradingConfig.assignmentContext,
            rubricCriteria: gradingConfig.rubricCriteria,
            tone: gradingConfig.tone,
            calibrationNotes:
              gradingConfig.calibrationNotes ?? 'Tidak ada instruksi khusus.',
            originalFilename: doc.originalFilename,
            extractedDocumentText: doc.extractedDocumentText
          },
          options
        );

        return {
          document_id: doc.id,
          filename: doc.originalFilename,
          status: 'COMPLETED',
          processed_at: new Date().toISOString(),
          evaluation
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        return {
          document_id: doc.id,
          filename: doc.originalFilename,
          status: 'MANUAL_REVIEW_REQUIRED',
          processed_at: new Date().toISOString(),
          evaluation: null,
          error_message: errorMessage
        };
      }
    })
  );

  return {
    sample_size: samples.length,
    samples,
    remaining_documents: remainingDocs
  };
}

/**
 * Menjalankan antrean penilaian seluruh batch dokumen menggunakan Promise-based worker pool
 * dengan batas konkurensi terkontrol (default 5 dokumen paralel), menggabungkan hasil
 * deteksi kemiripan lokal, serta mengisolasi error dokumen ke status 'MANUAL_REVIEW_REQUIRED'.
 */
export async function runBatchGradingQueue(
  docs: BatchInputDocument[],
  similarityResults: SimilarityResultsInput | undefined,
  gradingConfig: GradingConfig,
  options: BatchGradingQueueOptions = {}
): Promise<BatchDocumentResult[]> {
  const total = docs.length;
  if (total === 0) {
    return [];
  }

  const {
    concurrency = DEFAULT_BATCH_CONCURRENCY,
    onProgress,
    ...evaluateOptions
  } = options;

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), total));
  const results = new Array<BatchDocumentResult>(total);
  let nextIndex = 0;
  let completedCount = 0;

  async function worker(): Promise<void> {
    while (nextIndex < total) {
      const currentIndex = nextIndex++;
      const doc = docs[currentIndex];
      const integrityCheck = resolveIntegrityCheck(doc, similarityResults);

      let result: BatchDocumentResult;

      try {
        const evaluation = await evaluateDocument(
          {
            assignmentContext: gradingConfig.assignmentContext,
            rubricCriteria: gradingConfig.rubricCriteria,
            tone: gradingConfig.tone,
            calibrationNotes: gradingConfig.calibrationNotes,
            originalFilename: doc.originalFilename,
            extractedDocumentText: doc.extractedDocumentText
          },
          evaluateOptions
        );

        result = {
          document_id: doc.id,
          filename: doc.originalFilename,
          status: 'COMPLETED',
          processed_at: new Date().toISOString(),
          integrity_check: integrityCheck,
          evaluation
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        result = {
          document_id: doc.id,
          filename: doc.originalFilename,
          status: 'MANUAL_REVIEW_REQUIRED',
          processed_at: new Date().toISOString(),
          integrity_check: integrityCheck,
          evaluation: null,
          error_message: errorMessage
        };
      }

      results[currentIndex] = result;
      completedCount += 1;

      if (onProgress) {
        try {
          onProgress(completedCount, total, result);
        } catch {
          // Jangan hentikan worker jika callback UI mengalami error
        }
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

import type {
  BatchDocumentResult,
  CalibrationSampleItem,
  GradingTone,
  RubricCriterion,
  SimilarityRecord
} from './grader';
import type { ExtractedDocument } from './parser';
import { INITIAL_FREE_CREDITS } from './credits';

export const SESSION_STORAGE_KEY = 'rubrika_v1_session_store';

export interface SavedGradingSession {
  id: string;
  title: string;
  updatedAt: string;
  currentStep: number;
  assignmentContext: string;
  selectedTone: GradingTone;
  rubricCriteria: RubricCriterion[];
  calibrationRunsUsed: number;
  calibrationNotes: string;
  extractedDocuments: ExtractedDocument[];
  similarityResults: SimilarityRecord[];
  calibrationSamples: CalibrationSampleItem[];
  batchResults: BatchDocumentResult[];
  rawTextPurged?: boolean;
}

export interface SessionStoreSnapshot {
  version: 1;
  activeSessionId: string;
  creditBalance: number;
  sessions: SavedGradingSession[];
}

/**
 * Mengubah snapshot sesi menjadi string JSON untuk disimpan ke localStorage / penyimpanan persisten.
 */
export function serializeSessionStore(snapshot: SessionStoreSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Memulihkan SessionStoreSnapshot dari string JSON secara aman (anti-crash jika JSON corrupt).
 */
export function deserializeSessionStore(
  rawJson: string | null | undefined
): SessionStoreSnapshot | null {
  if (!rawJson || typeof rawJson !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(rawJson);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.activeSessionId !== 'string' ||
      !Array.isArray(parsed.sessions)
    ) {
      return null;
    }

    const creditBalance =
      typeof parsed.creditBalance === 'number' &&
      !Number.isNaN(parsed.creditBalance)
        ? Math.max(0, Math.floor(parsed.creditBalance))
        : INITIAL_FREE_CREDITS;

    return {
      version: 1,
      activeSessionId: parsed.activeSessionId,
      creditBalance,
      sessions: parsed.sessions
    };
  } catch {
    return null;
  }
}

/**
 * Menambahkan atau memperbarui sesi penilaian di dalam daftar riwayat sesi,
 * diurutkan dari yang paling baru diperbarui.
 */
export function upsertGradingSession(
  sessions: SavedGradingSession[],
  updatedSession: SavedGradingSession
): SavedGradingSession[] {
  const filtered = sessions.filter((s) => s.id !== updatedSession.id);
  return [updatedSession, ...filtered];
}

/**
 * Menghapus satu sesi penilaian dari daftar riwayat berdasarkan ID.
 */
export function deleteGradingSession(
  sessions: SavedGradingSession[],
  sessionId: string
): SavedGradingSession[] {
  return sessions.filter((s) => s.id !== sessionId);
}

/**
 * Fitur #6 (Data Purge / Jaminan Privasi Akademik):
 * Menghapus seluruh teks mentah dokumen mahasiswa (`extractedDocumentText`) dari sesi
 * sambil tetap mempertahankan seluruh nilai akhir, rincian skor rubrik, metrik kemiripan,
 * dan feedback mahasiswa.
 */
export function purgeSessionRawText(
  session: SavedGradingSession
): SavedGradingSession {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    rawTextPurged: true,
    extractedDocuments: session.extractedDocuments.map((doc) => ({
      ...doc,
      extractedDocumentText: ''
    }))
  };
}

/**
 * Fitur #2 (Manual Grading dari Extracted Text Viewer):
 * Membuat evaluasi manual deterministik untuk dokumen yang berstatus MANUAL_REVIEW_REQUIRED
 * setelah dosen membaca teks asli dokumen mahasiswa di UI.
 */
export function createManualEvaluationForDocument(
  item: BatchDocumentResult,
  criteria: RubricCriterion[],
  manualScore: number,
  manualFeedback: string = 'Dinilai secara manual oleh dosen melalui peninjauan teks dokumen asli.',
  studentName: string = 'Tidak Tertera',
  studentId: string = 'Tidak Tertera'
): BatchDocumentResult {
  const clampedScore = Math.min(
    100,
    Math.max(0, Math.round(manualScore * 100) / 100)
  );
  const roundedIntScore = Math.round(clampedScore);

  return {
    ...item,
    status: 'COMPLETED',
    processed_at: new Date().toISOString(),
    error_message: undefined,
    evaluation: {
      student_identity: {
        extracted_name:
          item.evaluation?.student_identity.extracted_name ?? studentName,
        extracted_id:
          item.evaluation?.student_identity.extracted_id ?? studentId,
        filename: item.filename
      },
      grading_breakdown: criteria.map((c) => ({
        criterion_name: c.name,
        weight_percentage: c.weightPercentage,
        score_given: roundedIntScore,
        short_reasoning: 'Penilaian manual oleh dosen.'
      })),
      final_weighted_score: clampedScore,
      feedback_for_student:
        manualFeedback.trim() ||
        'Dinilai secara manual oleh dosen melalui peninjauan teks dokumen asli.',
      ai_writing_suspicion: item.evaluation?.ai_writing_suspicion ?? 'Low'
    }
  };
}

/**
 * Menyimpan snapshot ke browser localStorage (aman dipanggil di lingkungan SSR/Node).
 */
export function saveSnapshotToStorage(snapshot: SessionStoreSnapshot): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      serializeSessionStore(snapshot)
    );
  } catch {
    // Abaikan jika kuota localStorage penuh
  }
}

/**
 * Memuat snapshot dari browser localStorage (aman dipanggil di lingkungan SSR/Node).
 */
export function loadSnapshotFromStorage(): SessionStoreSnapshot | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return deserializeSessionStore(raw);
  } catch {
    return null;
  }
}

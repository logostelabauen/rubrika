import { describe, expect, it } from 'vitest';
import {
  createManualEvaluationForDocument,
  deleteGradingSession,
  deserializeSessionStore,
  purgeSessionRawText,
  serializeSessionStore,
  upsertGradingSession,
  type SavedGradingSession,
  type SessionStoreSnapshot
} from '../session-store';
import type { BatchDocumentResult, RubricCriterion } from '../grader';

const sampleCriteria: RubricCriterion[] = [
  {
    name: 'Ketajaman Analisis',
    weightPercentage: 60,
    description: 'Analisis studi kasus dan solusi'
  },
  {
    name: 'Referensi & Tata Bahasa',
    weightPercentage: 40,
    description: 'Kualitas sitasi dan kerapihan penulisan'
  }
];

function createMockSession(id: string, title: string): SavedGradingSession {
  return {
    id,
    title,
    updatedAt: '2026-10-16T08:00:00.000Z',
    currentStep: 4,
    assignmentContext: 'UAS Rekayasa Perangkat Lunak',
    selectedTone: 'Balanced',
    rubricCriteria: sampleCriteria,
    calibrationRunsUsed: 1,
    calibrationNotes: 'Fokus pada arsitektur sistem',
    extractedDocuments: [
      {
        id: 'doc-1',
        originalFilename: 'UAS_13520001_Budi.pdf',
        extractedDocumentText:
          'Ini adalah teks lengkap jawaban mahasiswa Budi mengenai arsitektur microservices dan database.',
        wordCount: 14,
        fileType: 'pdf'
      },
      {
        id: 'doc-2',
        originalFilename: 'UAS_13520002_Siti.pdf',
        extractedDocumentText:
          'Ini adalah teks lengkap jawaban mahasiswa Siti mengenai arsitektur sistem terdistribusi.',
        wordCount: 12,
        fileType: 'pdf'
      }
    ],
    similarityResults: [
      {
        documentId: 'doc-1',
        filename: 'UAS_13520001_Budi.pdf',
        similarity_flagged: true,
        max_similarity_score: 62.5,
        closest_match_file: 'UAS_13520002_Siti.pdf'
      }
    ],
    calibrationSamples: [],
    batchResults: [
      {
        document_id: 'doc-1',
        filename: 'UAS_13520001_Budi.pdf',
        status: 'COMPLETED',
        evaluation: {
          student_identity: {
            extracted_name: 'Budi Santoso',
            extracted_id: '13520001',
            filename: 'UAS_13520001_Budi.pdf'
          },
          grading_breakdown: [
            {
              criterion_name: 'Ketajaman Analisis',
              weight_percentage: 60,
              score_given: 85,
              short_reasoning: 'Analisis sangat mendalam.'
            },
            {
              criterion_name: 'Referensi & Tata Bahasa',
              weight_percentage: 40,
              score_given: 90,
              short_reasoning: 'Sitasi lengkap dan rapi.'
            }
          ],
          final_weighted_score: 87,
          feedback_for_student: 'Pertahankan analisis yang terstruktur.',
          ai_writing_suspicion: 'Low'
        },
        integrity_check: {
          similarity_flagged: true,
          max_similarity_score: 62.5,
          closest_match_file: 'UAS_13520002_Siti.pdf'
        },
        processed_at: '2026-10-16T08:05:00.000Z'
      }
    ],
    rawTextPurged: false
  };
}

describe('Rilis Publik v1.0 — Session Persistence, History, Manual Grading & Data Purge', () => {
  it('menyimpan dan memulihkan state sesi penilaian (serializeSessionStore & deserializeSessionStore) secara utuh', () => {
    const session1 = createMockSession('session-01', 'UAS RPL Kelas A');
    const snapshot: SessionStoreSnapshot = {
      version: 1,
      activeSessionId: 'session-01',
      creditBalance: 25,
      sessions: [session1]
    };

    const rawJson = serializeSessionStore(snapshot);
    const restored = deserializeSessionStore(rawJson);

    expect(restored).not.toBeNull();
    expect(restored?.activeSessionId).toBe('session-01');
    expect(restored?.creditBalance).toBe(25);
    expect(restored?.sessions).toHaveLength(1);
    expect(restored?.sessions[0].title).toBe('UAS RPL Kelas A');
    expect(restored?.sessions[0].batchResults[0].evaluation?.final_weighted_score).toBe(87);
  });

  it('mengembalikan null dengan aman jika JSON penyimpanan sesi corrupt atau tidak valid', () => {
    expect(deserializeSessionStore(null)).toBeNull();
    expect(deserializeSessionStore('')).toBeNull();
    expect(deserializeSessionStore('{corrupt-json')).toBeNull();
    expect(deserializeSessionStore(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('mengelola daftar riwayat multi-sesi dengan upsertGradingSession dan deleteGradingSession', () => {
    const s1 = createMockSession('session-01', 'Kelas A');
    const s2 = createMockSession('session-02', 'Kelas B');

    let history = upsertGradingSession([], s1);
    history = upsertGradingSession(history, s2);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe('session-02');

    // Update s1 -> harus pindah ke urutan paling atas
    const s1Updated = { ...s1, title: 'Kelas A (Revisi)' };
    history = upsertGradingSession(history, s1Updated);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe('session-01');
    expect(history[0].title).toBe('Kelas A (Revisi)');

    // Hapus s1
    history = deleteGradingSession(history, 'session-01');
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('session-02');
  });

  it('menghapus seluruh teks mentah dokumen (purgeSessionRawText) namun tetap menjaga nilai, feedback, dan kemiripan tetap utuh', () => {
    const session = createMockSession('session-purge', 'Sesi Uji Privasi');
    expect(session.extractedDocuments[0].extractedDocumentText.length).toBeGreaterThan(20);
    expect(session.rawTextPurged).toBe(false);

    const purged = purgeSessionRawText(session);

    expect(purged.rawTextPurged).toBe(true);
    expect(purged.extractedDocuments).toHaveLength(2);
    expect(purged.extractedDocuments[0].extractedDocumentText).toBe('');
    expect(purged.extractedDocuments[1].extractedDocumentText).toBe('');
    // Word count dan nama file asli tetap tersimpan untuk metadata audit
    expect(purged.extractedDocuments[0].wordCount).toBe(14);
    expect(purged.extractedDocuments[0].originalFilename).toBe('UAS_13520001_Budi.pdf');

    // Rekap nilai, breakdown rubrik, feedback, dan similarity tetap utuh 100%
    expect(purged.batchResults).toHaveLength(1);
    expect(purged.batchResults[0].evaluation?.final_weighted_score).toBe(87);
    expect(purged.batchResults[0].evaluation?.feedback_for_student).toBe(
      'Pertahankan analisis yang terstruktur.'
    );
    expect(purged.batchResults[0].integrity_check.max_similarity_score).toBe(62.5);
  });

  it('mengubah dokumen berstatus MANUAL_REVIEW_REQUIRED menjadi COMPLETED dengan createManualEvaluationForDocument', () => {
    const manualDoc: BatchDocumentResult = {
      document_id: 'doc-manual',
      filename: 'UAS_13520099_Rizky.pdf',
      status: 'MANUAL_REVIEW_REQUIRED',
      evaluation: null,
      error_message: 'Gagal memvalidasi output AI setelah 2x percobaan.',
      integrity_check: {
        similarity_flagged: false,
        max_similarity_score: 12,
        closest_match_file: null
      },
      processed_at: '2026-10-16T08:10:00.000Z'
    };

    const resolved = createManualEvaluationForDocument(
      manualDoc,
      sampleCriteria,
      82.5,
      'Sudah diperiksa manual dari teks asli dokumen.',
      'Rizky Pratama',
      '13520099'
    );

    expect(resolved.status).toBe('COMPLETED');
    expect(resolved.error_message).toBeUndefined();
    expect(resolved.evaluation?.final_weighted_score).toBe(82.5);
    expect(resolved.evaluation?.student_identity.extracted_name).toBe('Rizky Pratama');
    expect(resolved.evaluation?.student_identity.extracted_id).toBe('13520099');
    expect(resolved.evaluation?.grading_breakdown).toHaveLength(2);
    expect(resolved.evaluation?.feedback_for_student).toBe(
      'Sudah diperiksa manual dari teks asli dokumen.'
    );
  });
});

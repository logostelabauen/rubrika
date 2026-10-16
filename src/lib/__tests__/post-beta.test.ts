import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateDocument,
  extractIdentityFallback,
  runBatchGradingQueue,
  type BatchInputDocument,
  type RubricCriterion
} from '../grader';

const testCriteria: RubricCriterion[] = [
  {
    name: 'Kedalaman Analisis Teknis',
    weightPercentage: 60,
    description: 'Trade-off latency dan skalabilitas.'
  },
  {
    name: 'Referensi & Sitasi',
    weightPercentage: 40,
    description: 'Minimal 3 referensi valid.'
  }
];

describe('Post-Beta Adjustment & High-Concurrency Unit Tests (Tahap 6 & 7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. extractIdentityFallback() - Berbagai Format NIM & Ekstraksi Nama File', () => {
    it('mengekstrak NIM dengan format titik (11.22.045) dan Nama dari header teks dokumen', () => {
      const text = `UNIVERSITAS TEKNOLOGI NUSANTARA
Nama Mahasiswa : Dimas Anggara Putra
NIM : 11.22.045.88
Kelas : SI-3B`;

      const fallback = extractIdentityFallback(text, 'Tugas1.pdf');
      expect(fallback.name).toBe('Dimas Anggara Putra');
      expect(fallback.id).toBe('11.22.045.88');
    });

    it('mengekstrak NIM dengan pemisah spasi (1122 0451 0088) dan menormalisasi spasinya', () => {
      const text = `Laporan Praktikum RPL
Oleh: Nadia Vega
NPM: 1122 0451 0088`;

      const fallback = extractIdentityFallback(text, 'Laporan.docx');
      expect(fallback.name).toBe('Nadia Vega');
      expect(fallback.id).toBe('112204510088');
    });

    it('mengekstrak NIM dan Nama Mahasiswa langsung dari pola nama file saat tidak tertera di dalam teks', () => {
      const plainTextWithoutHeader =
        'Arsitektur monolitik menyatukan seluruh komponen aplikasi di dalam satu basis kode dan proses yang sama.';

      const fromStandardFile = extractIdentityFallback(
        plainTextWithoutHeader,
        'UAS_RPL_112204510088_Rizky_Pratama.pdf'
      );
      expect(fromStandardFile.id).toBe('112204510088');
      expect(fromStandardFile.name).toBe('Rizky Pratama');

      const fromDottedFile = extractIdentityFallback(
        plainTextWithoutHeader,
        'Tugas_Final_11.22.045_Budi-Santoso_Revisi.docx'
      );
      expect(fromDottedFile.id).toBe('11.22.045');
      expect(fromDottedFile.name).toBe('Budi Santoso');
    });

    it('meng-override "Tidak Tertera" dari LLM dengan hasil fallback identitas lokal pada evaluateDocument()', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        student_identity: {
                          extracted_name: 'Tidak Tertera',
                          extracted_id: 'Tidak Tertera',
                          filename: 'UAS_RPL_112204510088_Rizky_Pratama.pdf'
                        },
                        grading_breakdown: [
                          {
                            criterion_name: 'Kedalaman Analisis Teknis',
                            weight_percentage: 60,
                            score_given: 80,
                            short_reasoning: 'Analisis baik.'
                          },
                          {
                            criterion_name: 'Referensi & Sitasi',
                            weight_percentage: 40,
                            score_given: 85,
                            short_reasoning: 'Referensi lengkap.'
                          }
                        ],
                        final_weighted_score: 82,
                        feedback_for_student: 'Pertahankan kualitas analisis.',
                        ai_writing_suspicion: 'Low'
                      })
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      vi.stubGlobal('fetch', fetchMock);

      const twentyPlusWordsText =
        'Arsitektur monolitik menyatukan seluruh komponen aplikasi di dalam satu basis kode yang sama sedangkan microservices memecah modul menjadi layanan independen yang saling berkomunikasi.';

      const output = await evaluateDocument(
        {
          assignmentContext: 'Analisis Monolitik vs Microservices.',
          rubricCriteria: testCriteria,
          tone: 'Balanced',
          originalFilename: 'UAS_RPL_112204510088_Rizky_Pratama.pdf',
          extractedDocumentText: twentyPlusWordsText
        },
        { apiKey: 'test-key' }
      );

      expect(output.student_identity.extracted_name).toBe('Rizky Pratama');
      expect(output.student_identity.extracted_id).toBe('112204510088');
      expect(output.final_weighted_score).toBe(82);
    });
  });

  describe('2. Konkurensi 20 Dokumen pada runBatchGradingQueue() (Retry 429 & Isolasi Gagal Permanen)', () => {
    it('menjaga urutan array hasil 100% sinkron dengan urutan 20 dokumen input meski dokumen ke-7 & ke-15 terkena HTTP 429 dan 1 dokumen gagal permanen', async () => {
      const totalDocs = 20;
      const validBodyWords =
        'Pembahasan arsitektur perangkat lunak antara monolitik dan microservices mencakup aspek latensi jaringan kompleksitas devops containerization serta skalabilitas horizontal pada sistem terdistribusi modern.';

      const docs: BatchInputDocument[] = Array.from(
        { length: totalDocs },
        (_, i) => {
          const docNum = i + 1;
          return {
            id: `doc-${docNum}`,
            originalFilename: `UAS_Mahasiswa_${String(docNum).padStart(2, '0')}.pdf`,
            extractedDocumentText: `Nama: Mahasiswa ${docNum}\nNIM: 11220000${String(docNum).padStart(2, '0')}\n${validBodyWords}`
          };
        }
      );

      const attemptsPerFilename = new Map<string, number>();

      const fetchMock = vi
        .fn()
        .mockImplementation(async (_url: string, init?: RequestInit) => {
          const bodyStr = String(init?.body ?? '');
          const match = bodyStr.match(/UAS_Mahasiswa_(\d{2})\.pdf/);
          const filename = match ? match[0] : 'unknown';
          const docNumber = match ? parseInt(match[1], 10) : 0;

          const prevAttempts = attemptsPerFilename.get(filename) ?? 0;
          const currentAttempt = prevAttempts + 1;
          attemptsPerFilename.set(filename, currentAttempt);

          // Simulasi jitter latensi acak (1ms - 10ms) agar urutan selesai worker paralel acak
          await new Promise((r) => setTimeout(r, (docNumber % 5) + 1));

          // Dokumen ke-7 dan ke-15 mengalami HTTP 429 satu kali sebelum berhasil di-retry
          if (
            (docNumber === 7 || docNumber === 15) &&
            currentAttempt === 1
          ) {
            return new Response('Rate limit exceeded', { status: 429 });
          }

          // Dokumen ke-11 gagal permanen di semua percobaan
          if (docNumber === 11) {
            return new Response('Permanent upstream error', { status: 500 });
          }

          const score = 70 + docNumber; // Nilai unik per dokumen untuk memastikan tidak tertukar
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          student_identity: {
                            extracted_name: `Mahasiswa ${docNumber}`,
                            extracted_id: `11220000${String(docNumber).padStart(2, '0')}`,
                            filename
                          },
                          grading_breakdown: [
                            {
                              criterion_name: 'Kedalaman Analisis Teknis',
                              weight_percentage: 60,
                              score_given: score,
                              short_reasoning: `Analisis dokumen #${docNumber} baik.`
                            },
                            {
                              criterion_name: 'Referensi & Sitasi',
                              weight_percentage: 40,
                              score_given: score,
                              short_reasoning: `Referensi dokumen #${docNumber} baik.`
                            }
                          ],
                          final_weighted_score: score,
                          feedback_for_student: `Feedback untuk mahasiswa #${docNumber}.`,
                          ai_writing_suspicion: 'Low'
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        });

      vi.stubGlobal('fetch', fetchMock);

      const progressEvents: number[] = [];

      const results = await runBatchGradingQueue(
        docs,
        undefined,
        {
          assignmentContext: 'Analisis Monolitik vs Microservices.',
          rubricCriteria: testCriteria,
          tone: 'Balanced'
        },
        {
          concurrency: 5,
          apiKey: 'test-key',
          maxRetries: 2,
          baseDelayMs: 2,
          onProgress: (completed, total) => {
            expect(total).toBe(20);
            progressEvents.push(completed);
          }
        }
      );

      expect(results).toHaveLength(20);
      expect(progressEvents).toHaveLength(20);
      expect(progressEvents[progressEvents.length - 1]).toBe(20);

      // Pastikan dokumen ke-7 dan ke-15 dipanggil tepat 2 kali (1x gagal 429 + 1x sukses retry)
      expect(attemptsPerFilename.get('UAS_Mahasiswa_07.pdf')).toBe(2);
      expect(attemptsPerFilename.get('UAS_Mahasiswa_15.pdf')).toBe(2);

      // Pastikan urutan array hasil 100% sinkron dengan urutan dokumen input
      results.forEach((res, idx) => {
        const expectedDocNum = idx + 1;
        const expectedFilename = `UAS_Mahasiswa_${String(expectedDocNum).padStart(2, '0')}.pdf`;

        expect(res.document_id).toBe(`doc-${expectedDocNum}`);
        expect(res.filename).toBe(expectedFilename);

        if (expectedDocNum === 11) {
          expect(res.status).toBe('MANUAL_REVIEW_REQUIRED');
          expect(res.evaluation).toBeNull();
          expect(res.error_message).toContain('500');
        } else {
          expect(res.status).toBe('COMPLETED');
          expect(res.evaluation).not.toBeNull();
          expect(res.evaluation?.student_identity.extracted_name).toBe(
            `Mahasiswa ${expectedDocNum}`
          );
          expect(res.evaluation?.final_weighted_score).toBe(
            70 + expectedDocNum
          );
        }
      });
    });
  });
});

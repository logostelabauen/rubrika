import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateDocument,
  GradingOutputSchema,
  verifyAndRecalculateScore,
  type BuildGradingPromptParams,
  type GradingOutput
} from '../grader';

const samplePromptParams: BuildGradingPromptParams = {
  assignmentContext:
    'Analisis perbandingan arsitektur Monolitik vs Microservices beserta studi kasus.',
  rubricCriteria: [
    {
      name: 'Kedalaman Analisis Teknis',
      weightPercentage: 50,
      description: 'Trade-off latency, DevOps, dan skalabilitas.'
    },
    {
      name: 'Studi Kasus & Relevansi',
      weightPercentage: 30,
      description: 'Contoh riil skenario migrasi.'
    },
    {
      name: 'Referensi & Sitasi',
      weightPercentage: 20,
      description: 'Minimal 3 referensi valid.'
    }
  ],
  tone: 'Balanced',
  originalFilename: 'UAS_Rizky.pdf',
  extractedDocumentText:
    'Nama: Rizky Pratama\nNIM: 112204510088\nArsitektur monolitik menyatukan seluruh komponen aplikasi di dalam satu basis kode tunggal, sedangkan microservices memecah aplikasi menjadi layanan independen yang berkomunikasi melalui jaringan.'
};

describe('Evaluator & Schema Unit Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('verifyAndRecalculateScore()', () => {
    it('menghitung ulang final_weighted_score secara deterministik dan meng-override nilai keliru dari LLM', () => {
      const llmOutputWithWrongTotal: GradingOutput = {
        student_identity: {
          extracted_name: 'Rizky Pratama',
          extracted_id: '112204510088',
          filename: 'UAS_Rizky.pdf'
        },
        grading_breakdown: [
          {
            criterion_name: 'Kedalaman Analisis Teknis',
            weight_percentage: 50,
            score_given: 80,
            short_reasoning: 'Analisis tepat.'
          },
          {
            criterion_name: 'Studi Kasus & Relevansi',
            weight_percentage: 30,
            score_given: 85,
            short_reasoning: 'Studi kasus relevan.'
          },
          {
            criterion_name: 'Referensi & Sitasi',
            weight_percentage: 20,
            score_given: 65,
            short_reasoning: 'Ada 2 referensi kredibel.'
          }
        ],
        // LLM salah menghitung (mis. 99.9), harus di-override menjadi 80*0.5 + 85*0.3 + 65*0.2 = 78.5
        final_weighted_score: 99.9,
        feedback_for_student: 'Pertahankan analisis dan lengkapi daftar pustaka.',
        ai_writing_suspicion: 'Low'
      };

      const verified = verifyAndRecalculateScore(llmOutputWithWrongTotal);
      expect(verified.final_weighted_score).toBe(78.5);
    });

    it('membulatkan pecahan desimal (33.3%, 33.3%, 33.4%) ke 2 angka di belakang koma dan berada di rentang [0, 100]', () => {
      const fractionalOutput: GradingOutput = {
        student_identity: {
          extracted_name: 'Siti Nurbaya',
          extracted_id: '112204510092',
          filename: 'Tugas_Siti.docx'
        },
        grading_breakdown: [
          {
            criterion_name: 'Kriteria A',
            weight_percentage: 33.3,
            score_given: 87,
            short_reasoning: 'Baik.'
          },
          {
            criterion_name: 'Kriteria B',
            weight_percentage: 33.3,
            score_given: 79,
            short_reasoning: 'Cukup baik.'
          },
          {
            criterion_name: 'Kriteria C',
            weight_percentage: 33.4,
            score_given: 91,
            short_reasoning: 'Sangat baik.'
          }
        ],
        final_weighted_score: 0,
        feedback_for_student: 'Bagus sekali.',
        ai_writing_suspicion: 'Low'
      };

      // 87 * 0.333 (= 28.971) + 79 * 0.333 (= 26.307) + 91 * 0.334 (= 30.394) = 85.672 -> 85.67
      const verified = verifyAndRecalculateScore(fractionalOutput);
      expect(verified.final_weighted_score).toBe(85.67);
      expect(verified.final_weighted_score).toBeGreaterThanOrEqual(0);
      expect(verified.final_weighted_score).toBeLessThanOrEqual(100);
    });
  });

  describe('GradingOutputSchema (Zod Validator)', () => {
    it('meloloskan payload JSON yang 100% sesuai kontrak Rubrika', () => {
      const validPayload = {
        student_identity: {
          extracted_name: 'Budi Santoso',
          extracted_id: '1122025100045',
          filename: 'UAS_Budi.pdf'
        },
        grading_breakdown: [
          {
            criterion_name: 'Analisis',
            weight_percentage: 100,
            score_given: 88,
            short_reasoning: 'Sangat tajam.'
          }
        ],
        final_weighted_score: 88,
        feedback_for_student: 'Jawaban sangat komprehensif.',
        ai_writing_suspicion: 'Low'
      };

      const parsed = GradingOutputSchema.parse(validPayload);
      expect(parsed.student_identity.extracted_name).toBe('Budi Santoso');
      expect(parsed.final_weighted_score).toBe(88);
    });

    it('menolak payload jika score_given berupa string, di luar rentang 0-100, atau ada field wajib yang hilang', () => {
      // 1. score_given berupa string
      expect(() =>
        GradingOutputSchema.parse({
          student_identity: {
            extracted_name: 'Budi',
            extracted_id: '123',
            filename: 'a.pdf'
          },
          grading_breakdown: [
            {
              criterion_name: 'Analisis',
              weight_percentage: 100,
              score_given: 'delapan puluh',
              short_reasoning: 'Alasan.'
            }
          ],
          final_weighted_score: 80,
          feedback_for_student: 'Feedback.',
          ai_writing_suspicion: 'Low'
        })
      ).toThrow();

      // 2. score_given di luar 0-100 (misal 105 atau -5)
      expect(() =>
        GradingOutputSchema.parse({
          student_identity: {
            extracted_name: 'Budi',
            extracted_id: '123',
            filename: 'a.pdf'
          },
          grading_breakdown: [
            {
              criterion_name: 'Analisis',
              weight_percentage: 100,
              score_given: 105,
              short_reasoning: 'Alasan.'
            }
          ],
          final_weighted_score: 105,
          feedback_for_student: 'Feedback.',
          ai_writing_suspicion: 'Low'
        })
      ).toThrow();

      // 3. Field wajib feedback_for_student hilang
      expect(() =>
        GradingOutputSchema.parse({
          student_identity: {
            extracted_name: 'Budi',
            extracted_id: '123',
            filename: 'a.pdf'
          },
          grading_breakdown: [
            {
              criterion_name: 'Analisis',
              weight_percentage: 100,
              score_given: 80,
              short_reasoning: 'Alasan.'
            }
          ],
          final_weighted_score: 80,
          ai_writing_suspicion: 'Low'
        })
      ).toThrow();
    });
  });

  describe('evaluateDocument() dengan mock fetch', () => {
    const validMockLlmJson: GradingOutput = {
      student_identity: {
        extracted_name: 'Rizky Pratama',
        extracted_id: '112204510088',
        filename: 'UAS_Rizky.pdf'
      },
      grading_breakdown: [
        {
          criterion_name: 'Kedalaman Analisis Teknis',
          weight_percentage: 50,
          score_given: 80,
          short_reasoning: 'Penjelasan trade-off baik.'
        },
        {
          criterion_name: 'Studi Kasus & Relevansi',
          weight_percentage: 30,
          score_given: 90,
          short_reasoning: 'Studi kasus relevan.'
        },
        {
          criterion_name: 'Referensi & Sitasi',
          weight_percentage: 20,
          score_given: 70,
          short_reasoning: 'Referensi cukup.'
        }
      ],
      final_weighted_score: 50, // Sengaja salah untuk menguji override verifyAndRecalculateScore (seharusnya 40 + 27 + 14 = 81)
      feedback_for_student: 'Analisis sudah baik, tingkatkan referensi.',
      ai_writing_suspicion: 'Low'
    };

    it('melakukan retry otomatis saat terkena HTTP 429 (Rate Limit) dan berhasil pada percobaan berikutnya', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Too Many Requests', { status: 429 })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(validMockLlmJson) }]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

      vi.stubGlobal('fetch', fetchMock);

      const result = await evaluateDocument(samplePromptParams, {
        apiKey: 'test-api-key',
        baseDelayMs: 1,
        maxRetries: 2
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.final_weighted_score).toBe(81);
      expect(result.student_identity.extracted_name).toBe('Rizky Pratama');
    });

    it('melakukan fallback model otomatis saat menerima HTTP 404 pada model awal', async () => {
      const calledUrls: string[] = [];

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        if (calledUrls.length === 1) {
          return new Response('Model not found', { status: 404 });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(validMockLlmJson) }]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      vi.stubGlobal('fetch', fetchMock);

      const result = await evaluateDocument(samplePromptParams, {
        apiKey: 'test-api-key',
        model: 'gemini-deprecated-model',
        baseDelayMs: 1,
        maxRetries: 2
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(calledUrls[0]).toContain('gemini-deprecated-model');
      expect(calledUrls[1]).toContain('gemini-2.0-flash');
      expect(result.final_weighted_score).toBe(81);
    });
  });
});

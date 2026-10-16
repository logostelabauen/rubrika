import { z } from 'zod';

export const AIWritingSuspicionSchema = z
  .enum(['Low', 'Medium', 'High'])
  .describe('Indikasi teks dibuat menggunakan AI tanpa editing personal');

export const StudentIdentitySchema = z.object({
  extracted_name: z
    .string()
    .min(1)
    .describe("Nama mahasiswa dari dokumen atau 'Tidak Tertera'"),
  extracted_id: z
    .string()
    .min(1)
    .describe("NIM / NPM / Nomor Mahasiswa atau 'Tidak Tertera'"),
  filename: z.string().min(1).describe('Nama file asli submission')
});

export const CriterionEvaluationSchema = z.object({
  criterion_name: z.string().min(1),
  weight_percentage: z.number().min(0).max(100),
  score_given: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Skor skala 0-100'),
  short_reasoning: z
    .string()
    .min(1)
    .describe('Alasan penilaian maksimal 2 kalimat')
});

export const GradingOutputSchema = z.object({
  student_identity: StudentIdentitySchema,
  grading_breakdown: z
    .array(CriterionEvaluationSchema)
    .min(1)
    .describe('Rincian penilaian per kriteria rubrik'),
  final_weighted_score: z
    .number()
    .min(0)
    .max(100)
    .describe('Total nilai akhir terbobot (0-100)'),
  feedback_for_student: z
    .string()
    .min(1)
    .describe('Ulasan konstruktif langsung ditujukan kepada mahasiswa'),
  ai_writing_suspicion: AIWritingSuspicionSchema
});

export type AIWritingSuspicion = z.infer<typeof AIWritingSuspicionSchema>;
export type StudentIdentity = z.infer<typeof StudentIdentitySchema>;
export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>;
export type GradingOutput = z.infer<typeof GradingOutputSchema>;

/**
 * Raw JSON Schema compatible with Google Gemini (responseSchema) and OpenAI (json_schema).
 */
export const GRADING_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    student_identity: {
      type: 'object',
      properties: {
        extracted_name: {
          type: 'string',
          description: "Nama mahasiswa dari dokumen atau 'Tidak Tertera'"
        },
        extracted_id: {
          type: 'string',
          description: "NIM / NPM / Nomor Mahasiswa atau 'Tidak Tertera'"
        },
        filename: {
          type: 'string',
          description: 'Nama file asli submission'
        }
      },
      required: ['extracted_name', 'extracted_id', 'filename']
    },
    grading_breakdown: {
      type: 'array',
      description: 'Rincian penilaian per kriteria rubrik',
      items: {
        type: 'object',
        properties: {
          criterion_name: { type: 'string' },
          weight_percentage: { type: 'number' },
          score_given: { type: 'integer', description: 'Skor skala 0-100' },
          short_reasoning: {
            type: 'string',
            description: 'Alasan penilaian maksimal 2 kalimat'
          }
        },
        required: [
          'criterion_name',
          'weight_percentage',
          'score_given',
          'short_reasoning'
        ]
      }
    },
    final_weighted_score: {
      type: 'number',
      description: 'Total nilai akhir terbobot (0-100)'
    },
    feedback_for_student: {
      type: 'string',
      description: 'Ulasan konstruktif langsung ditujukan kepada mahasiswa'
    },
    ai_writing_suspicion: {
      type: 'string',
      enum: ['Low', 'Medium', 'High'],
      description: 'Indikasi teks dibuat menggunakan AI tanpa editing personal'
    }
  },
  required: [
    'student_identity',
    'grading_breakdown',
    'final_weighted_score',
    'feedback_for_student',
    'ai_writing_suspicion'
  ]
} as const;

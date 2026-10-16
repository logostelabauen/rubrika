import type { BatchDocumentResult } from '../grader/batch';
import type { RubricCriterion } from '../grader/prompt';

/**
 * Melakukan escaping nilai sel CSV sesuai standar RFC 4180
 * serta mencegah CSV Formula Injection (jika diawali =, +, -, @).
 */
function escapeCSVCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '""';
  }

  let str = String(value).replace(/\r?\n/g, ' ').trim();

  // Mitigasi CSV Injection di Excel/Spreadsheet jika string dimulai dengan karakter formula
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  const escapedQuotes = str.replace(/"/g, '""');
  return `"${escapedQuotes}"`;
}

/**
 * Menghasilkan string CSV rekapitulasi nilai (Gradebook) yang siap dibuka
 * di Microsoft Excel, Google Sheets, atau diimpor ke sistem akademik kampus.
 */
export function generateGradebookCSV(
  results: BatchDocumentResult[],
  criteria: RubricCriterion[]
): string {
  const criterionHeaders: string[] = [];
  for (const criterion of criteria) {
    criterionHeaders.push(
      `${criterion.name} (${criterion.weightPercentage}%) - Skor`,
      `${criterion.name} - Alasan Penilaian`
    );
  }

  const headers = [
    'No',
    'Nama Mahasiswa',
    'NIM/ID',
    'Nama File',
    'Status',
    'Nilai Akhir',
    'Flag Kemiripan',
    'Skor Kemiripan (%)',
    'Mirip Dengan File',
    'Indikasi AI',
    ...criterionHeaders,
    'Feedback Mahasiswa'
  ];

  const rows: string[] = [headers.map(escapeCSVCell).join(',')];

  results.forEach((item, index) => {
    const evaluation = item.evaluation;
    const studentName =
      evaluation?.student_identity.extracted_name ?? 'Tidak Tertera';
    const studentId =
      evaluation?.student_identity.extracted_id ?? 'Tidak Tertera';
    const finalScore =
      evaluation !== null ? evaluation.final_weighted_score.toFixed(2) : '-';
    const similarityFlag = item.integrity_check.similarity_flagged
      ? 'TERINDIKASI PLAGIASI'
      : 'Aman';
    const similarityPercent = (
      item.integrity_check.max_similarity_score * 100
    ).toFixed(0);
    const closestMatch = item.integrity_check.closest_match_file ?? '-';
    const aiSuspicion = evaluation?.ai_writing_suspicion ?? '-';
    const feedback =
      evaluation?.feedback_for_student ?? item.error_message ?? '-';

    const criterionCells: (string | number)[] = [];
    for (const criterion of criteria) {
      const matchedBreakdown = evaluation?.grading_breakdown.find(
        (b) =>
          b.criterion_name.toLowerCase().trim() ===
          criterion.name.toLowerCase().trim()
      );

      if (matchedBreakdown) {
        criterionCells.push(
          matchedBreakdown.score_given,
          matchedBreakdown.short_reasoning
        );
      } else {
        criterionCells.push('-', '-');
      }
    }

    const row = [
      index + 1,
      studentName,
      studentId,
      item.filename,
      item.status,
      finalScore,
      similarityFlag,
      `${similarityPercent}%`,
      closestMatch,
      aiSuspicion,
      ...criterionCells,
      feedback
    ];

    rows.push(row.map(escapeCSVCell).join(','));
  });

  // Sertakan UTF-8 BOM (\uFEFF) agar Microsoft Excel otomatis mengenali encoding UTF-8 dengan benar
  return '\uFEFF' + rows.join('\r\n');
}

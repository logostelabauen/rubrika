import { json, type RequestHandler } from '@sveltejs/kit';
import { generateGradebookCSV } from '$lib/exporter';
import type { BatchDocumentResult, RubricCriterion } from '$lib/grader';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const results: BatchDocumentResult[] = Array.isArray(body?.results)
      ? body.results
      : [];
    const criteria: RubricCriterion[] = Array.isArray(body?.criteria)
      ? body.criteria
      : [];
    const rawFilename =
      typeof body?.filename === 'string' && body.filename.trim().length > 0
        ? body.filename.trim()
        : 'Rubrika_Gradebook.csv';

    if (results.length === 0) {
      return json(
        { error: 'Tidak ada data hasil penilaian untuk diekspor.' },
        { status: 400 }
      );
    }

    const csvContent = generateGradebookCSV(results, criteria);
    const safeFilename = rawFilename.endsWith('.csv')
      ? rawFilename
      : `${rawFilename}.csv`;

    return new Response(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFilename}"`
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Gagal mengekspor rekapitulasi nilai CSV.';
    return json({ error: message }, { status: 500 });
  }
};

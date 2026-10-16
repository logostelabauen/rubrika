import { json, type RequestHandler } from '@sveltejs/kit';
import {
  parseUploadedFiles,
  type UploadedFileInput
} from '$lib/parser';
import { computeBatchSimilarity } from '$lib/similarity';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    const uploadedInputs: UploadedFileInput[] = [];
    let threshold = Number(process.env.SIMILARITY_THRESHOLD ?? 0.8);

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const thresholdParam = formData.get('similarityThreshold');
      if (thresholdParam !== null && !Number.isNaN(Number(thresholdParam))) {
        threshold = Number(thresholdParam);
      }

      const fileEntries = [
        ...formData.getAll('files'),
        ...formData.getAll('file')
      ];

      for (const entry of fileEntries) {
        if (entry instanceof File && entry.size > 0) {
          const arrayBuffer = await entry.arrayBuffer();
          uploadedInputs.push({
            filename: entry.name,
            buffer: new Uint8Array(arrayBuffer)
          });
        }
      }
    } else {
      const body = await request.json();
      if (
        typeof body?.similarityThreshold === 'number' &&
        !Number.isNaN(body.similarityThreshold)
      ) {
        threshold = body.similarityThreshold;
      }

      if (Array.isArray(body?.files)) {
        for (const item of body.files) {
          if (!item?.filename) continue;
          if (typeof item.base64 === 'string') {
            uploadedInputs.push({
              filename: item.filename,
              buffer: Buffer.from(item.base64, 'base64')
            });
          } else if (typeof item.text === 'string') {
            uploadedInputs.push({
              filename: item.filename,
              buffer: Buffer.from(item.text, 'utf8')
            });
          }
        }
      }
    }

    if (uploadedInputs.length === 0) {
      return json(
        { error: 'Tidak ada file valid yang diunggah untuk diekstrak.' },
        { status: 400 }
      );
    }

    const documents = await parseUploadedFiles(uploadedInputs);

    const similarityResults = computeBatchSimilarity(
      documents.map((doc) => ({
        id: doc.id,
        filename: doc.originalFilename,
        text: doc.extractedDocumentText
      })),
      threshold
    );

    const flaggedCount = similarityResults.filter(
      (r) => r.similarity_flagged
    ).length;
    const parseErrorCount = documents.filter((d) => Boolean(d.parseError)).length;

    return json({
      documents,
      similarityResults,
      summary: {
        totalDocuments: documents.length,
        flaggedSimilarityCount: flaggedCount,
        parseErrorCount,
        threshold
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Gagal memproses unggahan dokumen.';
    return json({ error: message }, { status: 500 });
  }
};

import { json, type RequestHandler } from '@sveltejs/kit';
import {
  checkBatchCreditSufficiency,
  INITIAL_FREE_CREDITS,
  TOPUP_PACKAGE
} from '$lib/credits';
import {
  runBatchGradingQueue,
  type BatchInputDocument,
  type GradingConfig,
  type SimilarityRecord
} from '$lib/grader';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const documents: BatchInputDocument[] = Array.isArray(body?.documents)
      ? body.documents
      : [];
    const similarityResults: SimilarityRecord[] | undefined = Array.isArray(
      body?.similarityResults
    )
      ? body.similarityResults
      : undefined;
    const gradingConfig: GradingConfig | undefined = body?.gradingConfig;
    const creditBalance =
      typeof body?.creditBalance === 'number'
        ? body.creditBalance
        : INITIAL_FREE_CREDITS;
    const concurrency: number | undefined = body?.concurrency;
    const apiKey: string | undefined = body?.apiKey;
    const model: string | undefined = body?.model;

    if (documents.length === 0) {
      return json(
        { error: 'Tidak ada dokumen untuk dinilai dalam antrean batch.' },
        { status: 400 }
      );
    }

    if (
      !gradingConfig ||
      !gradingConfig.assignmentContext ||
      !Array.isArray(gradingConfig.rubricCriteria) ||
      gradingConfig.rubricCriteria.length === 0
    ) {
      return json(
        { error: 'Konfigurasi tugas dan rubrik penilaian belum lengkap.' },
        { status: 400 }
      );
    }

    const creditCheck = checkBatchCreditSufficiency(
      creditBalance,
      documents.length
    );

    if (!creditCheck.sufficient) {
      return json(
        {
          error: `Saldo kredit tidak mencukupi. Dibutuhkan ${creditCheck.required} kredit, saldo saat ini ${creditCheck.currentBalance} kredit (kurang ${creditCheck.deficit} kredit).`,
          creditCheck,
          topupOffer: creditCheck.topupOffer ?? TOPUP_PACKAGE
        },
        { status: 402 }
      );
    }

    const remainingBalance = creditCheck.currentBalance - creditCheck.required;

    const results = await runBatchGradingQueue(
      documents,
      similarityResults,
      gradingConfig,
      {
        concurrency,
        apiKey,
        model
      }
    );

    const completedCount = results.filter(
      (r) => r.status === 'COMPLETED'
    ).length;
    const manualReviewCount = results.filter(
      (r) => r.status === 'MANUAL_REVIEW_REQUIRED'
    ).length;

    return json({
      results,
      creditSummary: {
        previousBalance: creditCheck.currentBalance,
        deducted: creditCheck.required,
        remainingBalance
      },
      batchSummary: {
        totalProcessed: results.length,
        completedCount,
        manualReviewCount
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Gagal mengeksekusi penilaian batch.';
    return json({ error: message }, { status: 500 });
  }
};

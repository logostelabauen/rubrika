import { json, type RequestHandler } from '@sveltejs/kit';
import {
  canRunCalibration,
  MAX_FREE_CALIBRATION_RUNS
} from '$lib/credits';
import {
  runCalibrationSample,
  type BatchInputDocument,
  type GradingConfig
} from '$lib/grader';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const documents: BatchInputDocument[] = Array.isArray(body?.documents)
      ? body.documents
      : [];
    const gradingConfig: GradingConfig | undefined = body?.gradingConfig;
    const calibrationRunsUsed = Number(body?.calibrationRunsUsed ?? 0);
    const sampleSize = Number(body?.sampleSize ?? 3);
    const apiKey: string | undefined = body?.apiKey;
    const model: string | undefined = body?.model;

    if (documents.length === 0) {
      return json(
        { error: 'Daftar dokumen kosong. Unggah dokumen terlebih dahulu.' },
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

    const eligibility = canRunCalibration(calibrationRunsUsed);
    if (!eligibility.allowed) {
      return json(
        {
          allowed: false,
          error: eligibility.reason,
          calibrationRunsUsed,
          maxFreeCalibrationRuns: MAX_FREE_CALIBRATION_RUNS
        },
        { status: 403 }
      );
    }

    const calibrationOutput = await runCalibrationSample(
      documents,
      gradingConfig,
      sampleSize,
      { apiKey, model }
    );

    const updatedRunsUsed = calibrationRunsUsed + 1;

    return json({
      allowed: true,
      calibrationRunsUsed: updatedRunsUsed,
      maxFreeCalibrationRuns: MAX_FREE_CALIBRATION_RUNS,
      remainingFreeCalibrationRuns: Math.max(
        0,
        MAX_FREE_CALIBRATION_RUNS - updatedRunsUsed
      ),
      ...calibrationOutput
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Gagal menjalankan uji sampel kalibrasi.';
    return json({ error: message }, { status: 500 });
  }
};

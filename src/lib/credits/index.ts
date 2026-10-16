export const INITIAL_FREE_CREDITS = 30;
export const MAX_FREE_CALIBRATION_RUNS = 2;

export const TOPUP_PACKAGE = {
  credits: 150,
  priceIdr: 25000,
  label: 'Top-up 150 Kredit cuma Rp 25.000 (Aktif Instan)'
} as const;

export interface CalibrationEligibilityResult {
  allowed: boolean;
  reason?: string;
}

export interface BatchCreditSufficiencyResult {
  sufficient: boolean;
  required: number;
  currentBalance: number;
  deficit: number;
  topupOffer?: typeof TOPUP_PACKAGE;
}

/**
 * Memeriksa apakah dosen masih memiliki jatah uji sampel kalibrasi gratis
 * pada sesi penilaian saat ini (maksimal 2x kalibrasi gratis per sesi).
 */
export function canRunCalibration(
  calibrationRunsUsed: number
): CalibrationEligibilityResult {
  const used = Math.max(0, Math.floor(calibrationRunsUsed));

  if (used >= MAX_FREE_CALIBRATION_RUNS) {
    return {
      allowed: false,
      reason: `Batas kalibrasi sampel gratis (${MAX_FREE_CALIBRATION_RUNS}x per sesi) telah tercapai. Silakan lanjutkan ke penilaian penuh seluruh batch.`
    };
  }

  return {
    allowed: true
  };
}

/**
 * Memeriksa kecukupan saldo kredit dosen untuk memproses sejumlah dokumen dalam batch
 * dengan rasio 1 Kredit = 1 Dokumen.
 */
export function checkBatchCreditSufficiency(
  creditBalance: number,
  documentCount: number
): BatchCreditSufficiencyResult {
  const currentBalance = Math.max(0, Math.floor(creditBalance));
  const required = Math.max(0, Math.floor(documentCount));
  const deficit = Math.max(0, required - currentBalance);
  const sufficient = currentBalance >= required;

  if (!sufficient) {
    return {
      sufficient: false,
      required,
      currentBalance,
      deficit,
      topupOffer: TOPUP_PACKAGE
    };
  }

  return {
    sufficient: true,
    required,
    currentBalance,
    deficit: 0
  };
}

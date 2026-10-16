<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    BatchDocumentResult,
    CalibrationSampleItem,
    GradingTone,
    RubricCriterion,
    SimilarityRecord
  } from '$lib/grader';
  import type { ExtractedDocument } from '$lib/parser';
  import {
    INITIAL_FREE_CREDITS,
    MAX_FREE_CALIBRATION_RUNS,
    TOPUP_PACKAGE
  } from '$lib/credits';
  import {
    createManualEvaluationForDocument,
    deleteGradingSession,
    loadSnapshotFromStorage,
    purgeSessionRawText,
    saveSnapshotToStorage,
    upsertGradingSession,
    type SavedGradingSession
  } from '$lib/session-store';

  const DEFAULT_CRITERIA: RubricCriterion[] = [
    {
      name: 'Kedalaman Analisis Teknis',
      weightPercentage: 50,
      description:
        'Menjelaskan trade-off latency, kompleksitas DevOps, dan skalabilitas secara sistematis.'
    },
    {
      name: 'Studi Kasus & Relevansi',
      weightPercentage: 30,
      description:
        'Memberikan contoh riil skenario kapan harus migrasi dari monolitik ke microservices.'
    },
    {
      name: 'Referensi & Sitasi Akademik',
      weightPercentage: 20,
      description:
        'Minimal 3 referensi buku teks, jurnal, atau standar industri yang kredibel.'
    }
  ];

  // --- State: Wallet, API Key & Session Persistence ---
  let activeSessionId = 'session-default-1';
  let savedSessions: SavedGradingSession[] = [];
  let showSessionDrawer = false;
  let isHydrated = false;
  let rawTextPurged = false;

  let creditBalance = INITIAL_FREE_CREDITS;
  let showTopupModal = false;
  let topupReason = '';
  let customApiKey = '';
  let showApiKeyInput = false;

  // --- State: Wizard Step (1..4) ---
  let currentStep = 1;
  let errorMessage = '';
  let statusNotice = '';

  // --- Step 1: "The Study Desk" (Setup Tugas & Rubrik) ---
  let sessionTitle = 'UAS Rekayasa Perangkat Lunak - Kelas TI-4A';
  let assignmentContext =
    'Mata Kuliah: Rekayasa Perangkat Lunak\nTugas: Buat esai analisis perbandingan arsitektur Monolitik vs Microservices beserta studi kasus penerapannya. Wajib sertakan minimal 3 referensi akademik/industri.';
  let referenceMaterial = '';
  let showReferenceInput = false;
  let selectedTone: GradingTone = 'Balanced';
  let rubricCriteria: RubricCriterion[] = structuredClone(DEFAULT_CRITERIA);

  // --- Step 2: "The Sorting Tray" (Bulk Upload & Similarity Matrix) ---
  let isDragging = false;
  let isParsing = false;
  let extractedDocuments: ExtractedDocument[] = [];
  let similarityResults: SimilarityRecord[] = [];
  let similarityThreshold = 0.8;

  // --- Step 3: "The Calibration Lab" (3 Sampel & Penyesuaian Standar) ---
  let calibrationRunsUsed = 0;
  let calibrationNotes = '';
  let isCalibrating = false;
  let isExecutingBatch = false;
  let calibrationSamples: CalibrationSampleItem[] = [];
  let remainingDocsAfterSample: ExtractedDocument[] = [];
  let lastRefundedCredits = 0;

  // --- Step 4: "The Official Ledger" (Rekap Nilai Akhir, Diff Viewer & Export) ---
  let batchResults: BatchDocumentResult[] = [];
  let selectedResultForModal: BatchDocumentResult | null = null;
  let selectedResultIndex: number = -1;
  let activeModalTab: 'grading' | 'extracted_text' | 'side_by_side' = 'grading';
  let manualScoreInput = 75;
  let manualFeedbackInput =
    'Dinilai secara manual oleh dosen melalui peninjauan teks dokumen asli.';
  let manualStudentNameInput = '';
  let manualStudentIdInput = '';
  let isExporting = false;
  let siakadSyncEnabled = false;
  let recentlyUpdatedRowIndex: number | null = null;

  function triggerRowFlash(index: number) {
    recentlyUpdatedRowIndex = index;
    setTimeout(() => {
      if (recentlyUpdatedRowIndex === index) {
        recentlyUpdatedRowIndex = null;
      }
    }, 900);
  }

  // Combine assignmentContext with optional <reference_material> when calling API
  $: effectiveAssignmentContext = referenceMaterial.trim()
    ? `${assignmentContext.trim()}\n\n<reference_material>\n${referenceMaterial.trim()}\n</reference_material>`
    : assignmentContext;

  // --- Lifecycle: Hydrate & Persist Session State (Anti-Refresh F5) ---
  function buildCurrentSessionObject(): SavedGradingSession {
    return {
      id: activeSessionId,
      title: sessionTitle.trim() || 'Sesi Penilaian Tanpa Judul',
      updatedAt: new Date().toISOString(),
      currentStep,
      assignmentContext,
      selectedTone,
      rubricCriteria,
      calibrationRunsUsed,
      calibrationNotes,
      extractedDocuments,
      similarityResults,
      calibrationSamples,
      batchResults,
      rawTextPurged
    };
  }

  function applySessionToState(session: SavedGradingSession) {
    activeSessionId = session.id;
    sessionTitle = session.title;
    currentStep = session.currentStep;
    assignmentContext = session.assignmentContext;
    selectedTone = session.selectedTone;
    rubricCriteria =
      session.rubricCriteria.length > 0
        ? session.rubricCriteria
        : structuredClone(DEFAULT_CRITERIA);
    calibrationRunsUsed = session.calibrationRunsUsed;
    calibrationNotes = session.calibrationNotes;
    extractedDocuments = session.extractedDocuments ?? [];
    similarityResults = session.similarityResults ?? [];
    calibrationSamples = session.calibrationSamples ?? [];
    batchResults = session.batchResults ?? [];
    rawTextPurged = Boolean(session.rawTextPurged);
  }

  function persistCurrentState() {
    if (!isHydrated) return;
    const currentSession = buildCurrentSessionObject();
    savedSessions = upsertGradingSession(savedSessions, currentSession);
    saveSnapshotToStorage({
      version: 1,
      activeSessionId,
      creditBalance,
      sessions: savedSessions
    });
  }

  onMount(() => {
    const restored = loadSnapshotFromStorage();
    if (restored && restored.sessions.length > 0) {
      creditBalance = restored.creditBalance;
      savedSessions = restored.sessions;
      const target =
        restored.sessions.find((s) => s.id === restored.activeSessionId) ??
        restored.sessions[0];
      if (target) {
        applySessionToState(target);
      }
    } else {
      const initial = buildCurrentSessionObject();
      savedSessions = [initial];
    }
    isHydrated = true;
    persistCurrentState();
  });

  // Auto-sync state ke localStorage setiap ada perubahan
  $: if (isHydrated) {
    void [
      sessionTitle,
      currentStep,
      assignmentContext,
      selectedTone,
      rubricCriteria,
      calibrationRunsUsed,
      calibrationNotes,
      extractedDocuments,
      similarityResults,
      calibrationSamples,
      batchResults,
      rawTextPurged,
      creditBalance
    ];
    persistCurrentState();
  }

  function createNewGradingSession() {
    const newId = `session-${Date.now()}`;
    activeSessionId = newId;
    sessionTitle = `Sesi Penilaian Baru (${new Date().toLocaleDateString('id-ID')})`;
    currentStep = 1;
    assignmentContext =
      'Mata Kuliah: Rekayasa Perangkat Lunak\nTugas: Buat esai analisis perbandingan arsitektur Monolitik vs Microservices beserta studi kasus penerapannya. Wajib sertakan minimal 3 referensi akademik/industri.';
    referenceMaterial = '';
    selectedTone = 'Balanced';
    rubricCriteria = structuredClone(DEFAULT_CRITERIA);
    calibrationRunsUsed = 0;
    calibrationNotes = '';
    extractedDocuments = [];
    similarityResults = [];
    calibrationSamples = [];
    batchResults = [];
    rawTextPurged = false;
    lastRefundedCredits = 0;
    errorMessage = '';
    statusNotice = 'Sesi penilaian kelas baru siap dikonfigurasi.';
    showSessionDrawer = false;
    persistCurrentState();
  }

  function switchGradingSession(sessionId: string) {
    const target = savedSessions.find((s) => s.id === sessionId);
    if (!target) return;
    applySessionToState(target);
    showSessionDrawer = false;
    errorMessage = '';
    statusNotice = `Berpindah ke sesi "${target.title}".`;
    persistCurrentState();
  }

  function handleRemoveSession(sessionId: string) {
    const updated = deleteGradingSession(savedSessions, sessionId);
    savedSessions = updated;

    if (sessionId === activeSessionId) {
      if (updated.length > 0) {
        applySessionToState(updated[0]);
      } else {
        createNewGradingSession();
        return;
      }
    }
    saveSnapshotToStorage({
      version: 1,
      activeSessionId,
      creditBalance,
      sessions: savedSessions
    });
  }

  function handlePurgeRawText() {
    const current = buildCurrentSessionObject();
    const purged = purgeSessionRawText(current);
    extractedDocuments = purged.extractedDocuments;
    rawTextPurged = true;
    persistCurrentState();
    statusNotice =
      'Seluruh teks mentah dokumen mahasiswa telah dihapus permanen dari penyimpanan sesi ini. Rekap nilai akhir, rincian skor rubrik, dan feedback tetap tersimpan utuh.';
  }

  $: totalWeight = rubricCriteria.reduce(
    (sum, item) => sum + (Number(item.weightPercentage) || 0),
    0
  );
  $: weightProgressPercent = Math.min(100, Math.max(0, totalWeight));
  $: isStep1Valid =
    assignmentContext.trim().length > 10 &&
    rubricCriteria.length > 0 &&
    rubricCriteria.every(
      (c) => c.name.trim().length > 0 && c.weightPercentage > 0
    ) &&
    totalWeight === 100;

  function addCriterion() {
    rubricCriteria = [
      ...rubricCriteria,
      {
        name: '',
        weightPercentage: Math.max(5, 100 - totalWeight),
        description: ''
      }
    ];
  }

  function rebalanceCriteriaWeights() {
    if (rubricCriteria.length === 0) return;
    const count = rubricCriteria.length;
    const baseWeight = Math.floor(100 / count);
    const remainder = 100 - baseWeight * count;
    rubricCriteria = rubricCriteria.map((c, idx) => ({
      ...c,
      weightPercentage: idx === 0 ? baseWeight + remainder : baseWeight
    }));
  }

  function removeCriterion(index: number) {
    if (rubricCriteria.length <= 1) return;
    rubricCriteria = rubricCriteria.filter((_, i) => i !== index);
  }

  function getSimilarityForDoc(doc: ExtractedDocument): SimilarityRecord {
    return (
      similarityResults.find(
        (s) => s.documentId === doc.id || s.filename === doc.originalFilename
      ) ?? {
        filename: doc.originalFilename,
        similarity_flagged: false,
        max_similarity_score: 0,
        closest_match_file: null
      }
    );
  }

  function getExtractedTextByFilename(
    filename: string | null | undefined,
    docId?: string
  ): string {
    if (!filename && !docId) return '';
    const match = extractedDocuments.find(
      (d) =>
        (docId && d.id === docId) ||
        (filename && d.originalFilename === filename)
    );
    return match?.extractedDocumentText ?? '';
  }

  // Telemetry & KPI computations
  $: bypassedDocCount = extractedDocuments.filter(
    (doc) => doc.wordCount < 20
  ).length;
  $: flaggedSimilarityCount = similarityResults.filter(
    (s) => s.similarity_flagged
  ).length;
  $: safeSimilarityCount = Math.max(
    0,
    extractedDocuments.length - flaggedSimilarityCount
  );
  $: activeLlmDocCount = Math.max(
    0,
    extractedDocuments.length - bypassedDocCount
  );
  $: estimatedBatchSeconds =
    activeLlmDocCount === 0
      ? 1
      : Math.max(2, Math.ceil(activeLlmDocCount / 3) * 3);

  $: completedBatchItems = batchResults.filter(
    (r) => r.status === 'COMPLETED' && r.evaluation !== null
  );
  $: manualReviewCount = batchResults.filter(
    (r) => r.status === 'MANUAL_REVIEW_REQUIRED'
  ).length;
  $: classAverageScore =
    completedBatchItems.length > 0
      ? Math.round(
          (completedBatchItems.reduce(
            (acc, r) => acc + (r.evaluation?.final_weighted_score ?? 0),
            0
          ) /
            completedBatchItems.length) *
            10
        ) / 10
      : 0;
  $: highestClassScore =
    completedBatchItems.length > 0
      ? Math.max(
          ...completedBatchItems.map(
            (r) => r.evaluation?.final_weighted_score ?? 0
          )
        )
      : 0;

  async function handleFileUpload(fileList: FileList | File[]) {
    if (isParsing) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    errorMessage = '';
    statusNotice = '';
    isParsing = true;

    try {
      const formData = new FormData();
      formData.set('similarityThreshold', String(similarityThreshold));
      for (const file of files) {
        formData.append('files', file);
      }

      const response = await fetch('/api/session/parse', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Gagal mengekstrak dokumen.');
      }

      extractedDocuments = data.documents;
      similarityResults = data.similarityResults;
      rawTextPurged = false;
      statusNotice = `Berhasil mengekstrak ${data.summary.totalDocuments} dokumen (${data.summary.flaggedSimilarityCount} terdeteksi mirip >= ${Math.round(similarityThreshold * 100)}%).`;
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : 'Terjadi kesalahan saat upload.';
    } finally {
      isParsing = false;
    }
  }

  async function loadDemoDocuments() {
    if (isParsing) return;
    errorMessage = '';
    statusNotice = '';
    isParsing = true;

    const demoFiles = [
      {
        filename: 'UAS_RPL_112204510088_Rizky.txt',
        text: `TUGAS AKHIR SEMESTER: REKAYASA PERANGKAT LUNAK
Nama: Rizky Pratama
NIM: 112204510088

Judul: Analisis Perbandingan Monolitik vs Microservices

Arsitektur monolitik menyatukan seluruh komponen aplikasi dalam satu basis kode dan proses yang sama. Kelebihannya adalah kemudahan pengembangan di fase awal, pengujian end-to-end yang sederhana, dan tidak ada network latency antar-modul. Namun, saat skala membesar, deployment menjadi lambat dan satu bug memory leak dapat merobohkan seluruh sistem.

Sebaliknya, microservices memecah sistem menjadi layanan independen yang berkomunikasi melalui REST API atau message broker seperti Kafka. Keuntungannya adalah independensi deployment dan skalabilitas horizontal per layanan. Trade-off utamanya adalah kompleksitas DevOps (containerization, service discovery, distributed tracing) serta overhead network latency dan eventual consistency.

Studi Kasus:
Pada platform penjualan tiket konser, lonjakan traffic ekstrem hanya terjadi pada modul antrean dan pembayaran. Dengan microservices, tim cukup men-scale service pembayaran dan antrean tanpa menduplikasi modul katalog. Migrasi sebaiknya dilakukan ketika ukuran tim engineering melebihi 20 developer dan bounded context domain sudah jelas.

Referensi:
1. Newman, Sam. (2021). Building Microservices (2nd Edition). O'Reilly Media.
2. Fowler, Martin & Lewis, James. (2014). Microservices: A Definition of This New Architectural Term.
3. Richardson, Chris. (2018). Microservices Patterns. Manning Publications.`
      },
      {
        filename: 'UAS_RPL_112204510092_Siti.txt',
        text: `Nama Mahasiswa: Siti Nurbaya
NIM: 112204510092

Perbandingan Arsitektur Monolitik dan Microservices

Pada arsitektur monolitik, modul UI, logika bisnis, dan akses data digabung dalam satu artefak deployment. Komunikasi berlangsung via in-process function call sehingga latensi sangat rendah. Namun, skalabilitas bersifat vertikal atau menduplikasi seluruh instance monolit.

Pada arsitektur microservices, setiap layanan memiliki database sendiri (database per service). Skalabilitas sangat fleksibel, tetapi membutuhkan infrastruktur DevOps matang seperti Kubernetes, CI/CD terotomasi, dan observability.

Studi Kasus:
Startup logistik pada awalnya menggunakan monolitik untuk validasi pasar (MVP). Ketika volume pelacakan kurir mencapai ribuan request per detik, modul real-time tracking dipisah menjadi microservice tersendiri agar tidak membebani modul akuntansi.

Referensi:
1. Newman, S. (2021). Building Microservices. O'Reilly.
2. Kleppmann, M. (2017). Designing Data-Intensive Applications. O'Reilly.`
      },
      {
        filename: 'Tugas_RPL_Fix_Final.txt',
        text: `Di era digital yang berkembang pesat dan dinamis ini, lanskap teknologi terus bertransformasi secara revolusioner. Arsitektur perangkat lunak memainkan peran yang sangat krusial dalam menentukan keberhasilan suatu organisasi.

Dalam konteks ini, monolitik dan microservices adalah dua paradigma terkemuka. Monolitik menawarkan kesederhanaan komprehensif, sementara microservices menghadirkan fleksibilitas tanpa batas dan skalabilitas holistik yang tak tertandingi. Berbagai studi kasus di industri menunjukkan bahwa adopsi arsitektur yang tepat akan mengoptimalkan efisiensi operasional secara signifikan.

Referensi:
- Artikel Teknologi Masa Depan (2024)
- Berbagai sumber terpercaya di internet`
      },
      {
        filename: 'UAS_RPL_112204510105_Andi_Copy.txt',
        text: `TUGAS AKHIR SEMESTER: REKAYASA PERANGKAT LUNAK
Nama: Andi Saputra
NIM: 112204510105

Judul: Analisis Perbandingan Monolitik vs Microservices

Arsitektur monolitik menyatukan seluruh komponen aplikasi dalam satu basis kode dan proses yang sama. Kelebihannya adalah kemudahan pengembangan di fase awal, pengujian end-to-end yang sederhana, dan tidak ada network latency antar-modul. Namun, saat skala membesar, deployment menjadi lambat dan satu bug memory leak dapat merobohkan seluruh sistem.

Sebaliknya, microservices memecah sistem menjadi layanan independen yang berkomunikasi melalui REST API atau message broker seperti Kafka. Keuntungannya adalah independensi deployment dan skalabilitas horizontal per layanan. Trade-off utamanya adalah kompleksitas DevOps (containerization, service discovery, distributed tracing) serta overhead network latency dan eventual consistency.

Studi Kasus:
Pada platform penjualan tiket konser, lonjakan traffic ekstrem hanya terjadi pada modul antrean dan pembayaran. Dengan microservices, tim cukup men-scale service pembayaran dan antrean tanpa menduplikasi modul katalog. Migrasi sebaiknya dilakukan ketika ukuran tim engineering melebihi 20 developer dan bounded context domain sudah jelas.

Referensi:
1. Newman, Sam. (2021). Building Microservices (2nd Edition). O'Reilly Media.
2. Fowler, Martin & Lewis, James. (2014). Microservices: A Definition of This New Architectural Term.
3. Richardson, Chris. (2018). Microservices Patterns. Manning Publications.`
      }
    ];

    try {
      const response = await fetch('/api/session/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          similarityThreshold,
          files: demoFiles
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Gagal memuat dokumen demo.');
      }

      extractedDocuments = data.documents;
      similarityResults = data.similarityResults;
      rawTextPurged = false;
      statusNotice = `Berhasil memuat ${data.summary.totalDocuments} dokumen sampel (${data.summary.flaggedSimilarityCount} pasangan terdeteksi indikasi menyontek >= ${Math.round(similarityThreshold * 100)}%).`;
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : 'Gagal memuat sampel demo.';
    } finally {
      isParsing = false;
    }
  }

  async function triggerCalibrationSample() {
    if (isCalibrating || isExecutingBatch) return;
    if (calibrationRunsUsed >= MAX_FREE_CALIBRATION_RUNS) return;

    errorMessage = '';
    statusNotice = '';
    isCalibrating = true;

    try {
      const response = await fetch('/api/session/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents: extractedDocuments,
          gradingConfig: {
            assignmentContext: effectiveAssignmentContext,
            rubricCriteria,
            tone: selectedTone,
            calibrationNotes
          },
          calibrationRunsUsed,
          sampleSize: 3,
          apiKey: customApiKey.trim() || undefined
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Gagal menjalankan kalibrasi sampel.');
      }

      calibrationRunsUsed = data.calibrationRunsUsed;
      calibrationSamples = data.samples;
      remainingDocsAfterSample = data.remaining_documents;
      statusNotice = `Kalibrasi ${calibrationSamples.length} sampel selesai (0 Kredit terpotong). Kuota kalibrasi gratis terpakai: ${calibrationRunsUsed}/${MAX_FREE_CALIBRATION_RUNS}.`;
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : 'Gagal menjalankan kalibrasi.';
    } finally {
      isCalibrating = false;
    }
  }

  async function executeRemainingOrFullBatch() {
    if (isExecutingBatch || isCalibrating) return;

    errorMessage = '';
    statusNotice = '';
    lastRefundedCredits = 0;
    isExecutingBatch = true;

    const docsToProcess = extractedDocuments;

    try {
      const response = await fetch('/api/session/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents: docsToProcess,
          similarityResults,
          gradingConfig: {
            assignmentContext: effectiveAssignmentContext,
            rubricCriteria,
            tone: selectedTone,
            calibrationNotes
          },
          creditBalance,
          concurrency: 3,
          apiKey: customApiKey.trim() || undefined
        })
      });

      const data = await response.json();

      if (response.status === 402) {
        topupReason = data.error;
        showTopupModal = true;
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Gagal mengeksekusi batch penilaian.');
      }

      batchResults = data.results;
      creditBalance = data.creditSummary.remainingBalance;
      lastRefundedCredits = Number(data.creditSummary.refundedCredits ?? 0);
      currentStep = 4;

      if (lastRefundedCredits > 0) {
        statusNotice = `Penilaian kelas selesai. ${data.batchSummary.completedCount} dokumen berhasil dinilai, dan +${lastRefundedCredits} Kredit otomatis di-refund karena ${lastRefundedCredits} dokumen memerlukan tinjauan manual.`;
      } else {
        statusNotice = `Penilaian kelas selesai. ${data.batchSummary.completedCount} dokumen berhasil dinilai (${data.creditSummary.deducted} kredit terpakai).`;
      }
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : 'Gagal mengeksekusi batch.';
    } finally {
      isExecutingBatch = false;
    }
  }

  function handleInlineFinalScoreChange(index: number, newValue: string) {
    const parsed = parseFloat(newValue);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(100, Math.max(0, Math.round(parsed * 100) / 100));

    const item = batchResults[index];
    if (!item.evaluation) return;

    batchResults[index] = {
      ...item,
      evaluation: {
        ...item.evaluation,
        final_weighted_score: clamped
      }
    };
    batchResults = [...batchResults];
    triggerRowFlash(index);
  }

  function handleCriterionScoreEdit(
    resultIndex: number,
    criterionIndex: number,
    newScoreStr: string
  ) {
    const parsed = parseInt(newScoreStr, 10);
    if (Number.isNaN(parsed)) return;
    const clampedScore = Math.min(100, Math.max(0, parsed));

    const target = batchResults[resultIndex];
    if (!target?.evaluation) return;

    const updatedBreakdown = target.evaluation.grading_breakdown.map(
      (crit, idx) =>
        idx === criterionIndex ? { ...crit, score_given: clampedScore } : crit
    );

    const recalculatedTotal = updatedBreakdown.reduce(
      (acc, c) => acc + c.score_given * (c.weight_percentage / 100),
      0
    );
    const roundedTotal =
      Math.round((recalculatedTotal + Number.EPSILON) * 100) / 100;

    const updatedItem: BatchDocumentResult = {
      ...target,
      status: 'COMPLETED',
      evaluation: {
        ...target.evaluation,
        grading_breakdown: updatedBreakdown,
        final_weighted_score: roundedTotal
      }
    };

    batchResults[resultIndex] = updatedItem;
    batchResults = [...batchResults];
    if (selectedResultIndex === resultIndex) {
      selectedResultForModal = updatedItem;
    }
    triggerRowFlash(resultIndex);
  }

  function saveManualGradingForCurrentModal() {
    if (!selectedResultForModal || selectedResultIndex < 0) return;

    const updated = createManualEvaluationForDocument(
      selectedResultForModal,
      rubricCriteria,
      manualScoreInput,
      manualFeedbackInput,
      manualStudentNameInput.trim() || 'Tidak Tertera',
      manualStudentIdInput.trim() || 'Tidak Tertera'
    );

    batchResults[selectedResultIndex] = updated;
    batchResults = [...batchResults];
    selectedResultForModal = updated;
    activeModalTab = 'grading';
    triggerRowFlash(selectedResultIndex);
    statusNotice = `Nilai manual (${updated.evaluation?.final_weighted_score}) berhasil disimpan untuk ${updated.filename}.`;
  }

  function openDetailModal(
    item: BatchDocumentResult,
    index: number,
    initialTab: 'grading' | 'extracted_text' | 'side_by_side' = 'grading'
  ) {
    selectedResultForModal = item;
    selectedResultIndex = index;
    activeModalTab = initialTab;
    manualScoreInput = item.evaluation?.final_weighted_score ?? 75;
    manualFeedbackInput =
      item.evaluation?.feedback_for_student ??
      'Dinilai secara manual oleh dosen melalui peninjauan teks dokumen asli.';
    manualStudentNameInput =
      item.evaluation?.student_identity.extracted_name ?? '';
    manualStudentIdInput =
      item.evaluation?.student_identity.extracted_id ?? '';
  }

  function closeDetailModal() {
    selectedResultForModal = null;
    selectedResultIndex = -1;
  }

  async function downloadGradebookCSV() {
    if (isExporting || batchResults.length === 0) return;
    isExporting = true;
    errorMessage = '';

    try {
      const response = await fetch('/api/session/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          results: batchResults,
          criteria: rubricCriteria,
          filename: `${sessionTitle.replace(/[^a-zA-Z0-9_-]+/g, '_')}_Gradebook.csv`
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Gagal mengunduh CSV.');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sessionTitle.replace(/[^a-zA-Z0-9_-]+/g, '_')}_Gradebook.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      errorMessage =
        err instanceof Error ? err.message : 'Gagal mengekspor CSV.';
    } finally {
      isExporting = false;
    }
  }

  function confirmQrisTopup() {
    creditBalance += TOPUP_PACKAGE.credits;
    showTopupModal = false;
    topupReason = '';
    statusNotice = `Top-up QRIS berhasil diverifikasi. +${TOPUP_PACKAGE.credits} Kredit telah ditambahkan ke dompet Anda.`;
  }

  function canNavigateToStep(stepNumber: number): boolean {
    if (stepNumber === 1) return true;
    if (stepNumber === 2) return isStep1Valid;
    if (stepNumber === 3) return isStep1Valid && extractedDocuments.length > 0;
    if (stepNumber === 4) return batchResults.length > 0;
    return false;
  }
</script>

<div class="min-h-[100dvh] flex flex-col bg-[#FAF8F5] text-[#0F172A]">
  <!-- Academic Privacy & Auto-Save Ribbon -->
  <div class="bg-[#0F172A] text-stone-200 px-4 py-2 text-xs border-b border-slate-800">
    <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>
          <strong class="font-semibold text-white">Jaminan Privasi Akademik:</strong> Naskah mahasiswa diproses terisolasi di RAM, tidak melatih AI publik, dan dapat dibersihkan kapan saja.
        </span>
      </div>
      <div class="flex items-center gap-4 text-[11px] font-medium text-emerald-400">
        <span class="inline-flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Auto-Save Aktif (Tahan Refresh F5)
        </span>
      </div>
    </div>
  </div>

  <!-- Top Persistent Context Bar -->
  <header class="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-stone-200/90 shadow-[0_4px_20px_-10px_rgba(15,23,42,0.06)]">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-4">
      <!-- Left: Brand Identity + Active Session Selector -->
      <div class="flex items-center gap-3.5">
        <div class="w-11 h-11 rounded-2xl bg-[#0F172A] flex items-center justify-center text-white font-extrabold text-lg tracking-tight shadow-sm border border-slate-800">
          R
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-extrabold tracking-tight text-[#0F172A]">
              Rubrika
            </h1>
            <span class="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-md bg-stone-100 text-slate-700 border border-stone-200">
              v1.0
            </span>
          </div>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="text-xs font-medium text-slate-600 truncate max-w-[180px] sm:max-w-[260px]" title={sessionTitle}>
              {sessionTitle}
            </span>
          </div>
        </div>

        <button
          type="button"
          on:click={() => (showSessionDrawer = true)}
          class="min-h-[44px] px-3.5 py-2 rounded-xl border border-stone-200/90 bg-[#FAF8F5] hover:bg-stone-100 text-xs font-semibold text-slate-800 transition inline-flex items-center gap-2 active:scale-[0.98]"
        >
          <svg class="w-4 h-4 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" />
          </svg>
          <span>Riwayat Sesi</span>
          <span class="font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded-md bg-white border border-stone-200 text-slate-700">
            {savedSessions.length}
          </span>
        </button>
      </div>

      <!-- Center: Interactive 4-Step Pill Stepper (Desktop) -->
      <nav aria-label="Tahapan Penilaian" class="hidden xl:flex items-center bg-[#FAF8F5] p-1.5 rounded-2xl border border-stone-200/90">
        {#each [
          {
            step: 1,
            label: '1. Setup & Rubrik',
            activeClass: 'bg-indigo-600 text-white shadow-sm',
            dotClass: 'bg-indigo-600'
          },
          {
            step: 2,
            label: '2. Unggah & Plagiasi',
            activeClass: 'bg-sky-600 text-white shadow-sm',
            dotClass: 'bg-sky-600'
          },
          {
            step: 3,
            label: '3. Lab Kalibrasi',
            activeClass: 'bg-violet-600 text-white shadow-sm',
            dotClass: 'bg-violet-600'
          },
          {
            step: 4,
            label: '4. Buku Nilai',
            activeClass: 'bg-emerald-600 text-white shadow-sm',
            dotClass: 'bg-emerald-600'
          }
        ] as stepPill}
          {@const unlocked = canNavigateToStep(stepPill.step)}
          <button
            type="button"
            disabled={!unlocked}
            on:click={() => {
              if (unlocked) currentStep = stepPill.step;
            }}
            class="min-h-[40px] px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 {currentStep === stepPill.step
              ? stepPill.activeClass
              : unlocked
                ? 'text-slate-700 hover:bg-white/90'
                : 'text-slate-400 cursor-not-allowed opacity-60'}"
          >
            {#if currentStep > stepPill.step}
              <svg class="w-3.5 h-3.5 text-emerald-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            {:else}
              <span
                class="w-2 h-2 rounded-full {currentStep === stepPill.step
                  ? 'bg-white'
                  : unlocked
                    ? stepPill.dotClass
                    : 'bg-slate-300'}"
              ></span>
            {/if}
            <span>{stepPill.label}</span>
          </button>
        {/each}
      </nav>

      <!-- Right: API Key Toggle & Tactile Credit Wallet Pill -->
      <div class="flex items-center gap-2.5">
        <button
          type="button"
          on:click={() => (showApiKeyInput = !showApiKeyInput)}
          class="min-h-[44px] px-3.5 py-2 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-xs font-semibold text-slate-700 transition inline-flex items-center gap-2"
          title="Konfigurasi Kunci API Gemini Kustom"
        >
          <svg class="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
          <span class="hidden sm:inline">
            {customApiKey ? 'API Key Aktif' : 'API Key'}
          </span>
        </button>

        <div class="flex items-center gap-3 bg-[#FAF8F5] border border-stone-200/90 rounded-2xl pl-4 pr-2 py-1.5">
          <div class="text-left">
            <span class="block text-[10px] uppercase tracking-wider font-bold text-slate-500">
              Saldo Dompet
            </span>
            <span class="text-sm font-extrabold font-mono tabular-nums text-[#0F172A]">
              {creditBalance}
              <span class="font-sans font-semibold text-xs text-slate-600">Kredit</span>
            </span>
          </div>
          <button
            type="button"
            on:click={() => {
              topupReason = '';
              showTopupModal = true;
            }}
            class="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold shadow-sm transition active:scale-[0.98]"
          >
            + Top Up QRIS
          </button>
        </div>
      </div>
    </div>

    {#if showApiKeyInput}
      <div class="bg-[#0F172A] text-white px-4 py-3.5 border-t border-slate-800">
        <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <label for="header-api-key-input" class="text-xs text-stone-300">
            Masukkan <strong>Google Gemini API Key</strong> pribadi jika Anda tidak menggunakan kunci bawaan server (<code>.env</code>):
          </label>
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <input
              id="header-api-key-input"
              type="password"
              bind:value={customApiKey}
              placeholder="AIzaSy..."
              class="min-h-[40px] w-full sm:w-80 px-3.5 py-2 rounded-xl bg-slate-800 border border-slate-700 text-xs font-mono text-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <button
              type="button"
              on:click={() => (showApiKeyInput = false)}
              class="min-h-[40px] px-4 py-2 rounded-xl bg-indigo-600 text-xs font-bold hover:bg-indigo-500 transition"
            >
              Simpan
            </button>
          </div>
        </div>
      </div>
    {/if}
  </header>

  <!-- Main Workspace Container -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
    <!-- Mobile/Tablet Stepper Bar (< xl) -->
    <nav aria-label="Navigasi Langkah Mobile" class="xl:hidden grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      {#each [
        { step: 1, title: '1. Meja Studi', subtitle: 'Konteks & Rubrik', color: 'border-indigo-600 bg-indigo-600 text-white' },
        { step: 2, title: '2. Baki Sortir', subtitle: 'Upload & Plagiasi', color: 'border-sky-600 bg-sky-600 text-white' },
        { step: 3, title: '3. Lab Kalibrasi', subtitle: 'Uji 3 Sampel Gratis', color: 'border-violet-600 bg-violet-600 text-white' },
        { step: 4, title: '4. Buku Nilai', subtitle: 'Edit & Unduh Excel', color: 'border-emerald-600 bg-emerald-600 text-white' }
      ] as item}
        {@const unlocked = canNavigateToStep(item.step)}
        <button
          type="button"
          disabled={!unlocked}
          on:click={() => {
            if (unlocked) currentStep = item.step;
          }}
          class="min-h-[56px] text-left p-3.5 rounded-2xl border transition {currentStep === item.step
            ? item.color
            : unlocked
              ? 'bg-white text-[#0F172A] border-stone-200 hover:border-stone-300'
              : 'bg-stone-100/70 text-slate-400 border-stone-200/60 cursor-not-allowed'}"
        >
          <div class="text-xs font-extrabold tracking-tight">{item.title}</div>
          <div class="text-[11px] mt-0.5 {currentStep === item.step ? 'text-white/85' : 'text-slate-500'}">
            {item.subtitle}
          </div>
        </button>
      {/each}
    </nav>

    <!-- Inline Feedback Alerts -->
    {#if errorMessage}
      <div role="alert" class="rounded-2xl bg-rose-50 border border-rose-200 p-4 flex items-start justify-between gap-3 shadow-sm">
        <div class="flex items-start gap-3 text-sm text-rose-900">
          <svg class="w-5 h-5 text-rose-600 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <strong class="font-bold">Perhatian:</strong> {errorMessage}
          </div>
        </div>
        <button
          type="button"
          on:click={() => (errorMessage = '')}
          class="min-h-[36px] px-3 rounded-lg text-xs text-rose-700 hover:bg-rose-100 font-bold transition"
        >
          Tutup
        </button>
      </div>
    {/if}

    {#if statusNotice}
      <div role="status" class="rounded-2xl bg-emerald-50/90 border border-emerald-200 p-4 flex items-start justify-between gap-3 shadow-sm">
        <div class="flex items-start gap-3 text-sm text-emerald-950">
          <svg class="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>{statusNotice}</span>
        </div>
        <button
          type="button"
          on:click={() => (statusNotice = '')}
          class="min-h-[36px] px-3 rounded-lg text-xs text-emerald-800 hover:bg-emerald-100 font-bold transition"
        >
          Tutup
        </button>
      </div>
    {/if}

    <!-- ===================================================================== -->
    <!-- STEP 1: "THE STUDY DESK" (SETUP KONTEKS & RUBRIK)                     -->
    <!-- Nuance: Calm, structured, editorial. Warm Indigo & Amber accents.     -->
    <!-- ===================================================================== -->
    {#if currentStep === 1}
      <section aria-labelledby="step1-heading" class="bg-white rounded-3xl border border-stone-200/90 border-t-4 border-t-indigo-600 shadow-[0_20px_40px_-15px_rgba(15,23,42,0.05)] p-6 sm:p-8 lg:p-10 space-y-8">
        <!-- Workspace Header -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-stone-200/80">
          <div>
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-200/80 text-indigo-700 text-xs font-bold uppercase tracking-wider mb-2">
              <span>Tahap 1 dari 4 • Meja Studi Dosen</span>
            </div>
            <h2 id="step1-heading" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A]">
              Konfigurasi Konteks Tugas & Rubrik Penilaian
            </h2>
            <p class="text-[15px] text-slate-600 mt-1 leading-relaxed max-w-2xl">
              Susun instruksi soal, pedoman kunci jawaban, dan bobot kriteria rubrik sebagaimana Anda menyiapkan rencana evaluasi di meja kerja.
            </p>
          </div>
          <button
            type="button"
            on:click={createNewGradingSession}
            class="min-h-[44px] px-4 py-2.5 rounded-xl border border-stone-200 bg-[#FAF8F5] hover:bg-stone-100 text-xs font-bold text-slate-700 transition inline-flex items-center gap-2 self-start sm:self-auto active:scale-[0.98]"
          >
            <svg class="w-4 h-4 text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Sesi Kelas Baru</span>
          </button>
        </div>

        <!-- 2-Column Asymmetric Split on Desktop (5 cols Left / 7 cols Right) -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <!-- LEFT COLUMN (5 cols): Assignment Identity, Context Prompt & Reference Answer Key -->
          <div class="lg:col-span-5 space-y-6 bg-[#FAF8F5] p-6 rounded-2xl border border-stone-200/80">
            <div class="space-y-2">
              <label for="session-title" class="block text-sm font-bold text-[#0F172A]">
                Identitas Kelas & Mata Kuliah
              </label>
              <p class="text-xs text-slate-500">
                Digunakan sebagai nama sesi dan nama file ekspor nilai akhir.
              </p>
              <input
                id="session-title"
                type="text"
                bind:value={sessionTitle}
                placeholder="Contoh: UAS Sistem Terdistribusi - Kelas IF-3B"
                class="min-h-[44px] w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-[15px] font-medium text-[#0F172A] focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition"
              />
            </div>

            <div class="space-y-2">
              <label for="assignment-context" class="block text-sm font-bold text-[#0F172A]">
                Deskripsi Soal & Instruksi Tugas
              </label>
              <p class="text-xs text-slate-500">
                Jelaskan topik tugas, studi kasus yang diminta, dan batasan format jawaban mahasiswa.
              </p>
              <textarea
                id="assignment-context"
                rows="6"
                bind:value={assignmentContext}
                placeholder="Masukkan soal ujian atau instruksi tugas secara lengkap di sini..."
                class="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] leading-relaxed text-[#0F172A] focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition"
              ></textarea>
            </div>

            <!-- Optional Reference Answer Key (<reference_material>) -->
            <div class="pt-2 border-t border-stone-200/90 space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <span class="block text-sm font-bold text-[#0F172A]">
                    Kunci Jawaban / Materi Referensi Dosen
                  </span>
                  <span class="text-xs text-slate-500">
                    Opsional • Mengunci acuan fakta akademik AI
                  </span>
                </div>
                <button
                  type="button"
                  on:click={() => (showReferenceInput = !showReferenceInput)}
                  class="min-h-[38px] px-3 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-xs font-bold text-indigo-700 transition"
                >
                  {showReferenceInput ? 'Sembunyikan' : '+ Tambah Kunci Jawaban'}
                </button>
              </div>

              {#if showReferenceInput}
                <div class="space-y-1.5">
                  <label for="reference-material" class="sr-only">
                    Kunci Jawaban atau Materi Referensi
                  </label>
                  <textarea
                    id="reference-material"
                    rows="4"
                    bind:value={referenceMaterial}
                    placeholder="Tempelkan poin kunci jawaban, rumus utama, atau ringkasan bab referensi yang wajib menjadi patokan kebenaran..."
                    class="w-full rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm leading-relaxed text-[#0F172A] focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition"
                  ></textarea>
                </div>
              {/if}
            </div>
          </div>

          <!-- RIGHT COLUMN (7 cols): Interactive Rubric Builder & Tone Selector -->
          <div class="lg:col-span-7 space-y-8">
            <!-- Rubric Builder Card with Live Weight Progress Bar -->
            <div class="rounded-2xl border border-stone-200/90 bg-white p-6 space-y-5 shadow-sm">
              <!-- Live Weight Progress Header -->
              <div class="space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 class="text-base font-extrabold text-[#0F172A]">
                      Komposisi Rubrik Penilaian
                    </h3>
                    <p class="text-xs text-slate-500">
                      Atur bobot tiap aspek penilaian hingga total mencapai tepat 100%.
                    </p>
                  </div>

                  <div class="flex items-center gap-2">
                    {#if totalWeight !== 100}
                      <button
                        type="button"
                        on:click={rebalanceCriteriaWeights}
                        class="min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 text-xs font-bold transition"
                      >
                        Ratakannya ke 100%
                      </button>
                    {/if}
                    <span
                      class="font-mono tabular-nums text-xs font-extrabold px-3.5 py-1.5 rounded-full border {totalWeight === 100
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                        : 'bg-amber-50 text-amber-800 border-amber-300'}"
                    >
                      Total Bobot: {totalWeight}% {totalWeight === 100 ? '• Siap' : '• Harus 100%'}
                    </span>
                  </div>
                </div>

                <!-- Live Weight Progress Bar -->
                <div class="w-full h-3 bg-stone-100 rounded-full overflow-hidden border border-stone-200/80 p-0.5">
                  <div
                    class="h-full rounded-full transition-all duration-300 {totalWeight === 100
                      ? 'bg-[#10B981]'
                      : 'bg-[#F59E0B]'}"
                    style="width: {weightProgressPercent}%"
                  ></div>
                </div>

                {#if totalWeight !== 100}
                  <p class="text-xs font-medium text-amber-800 bg-amber-50/90 border border-amber-200 rounded-xl px-3.5 py-2">
                    Total bobot saat ini <strong class="font-mono tabular-nums">{totalWeight}%</strong> ({totalWeight < 100 ? `kurang ${100 - totalWeight}%` : `lebih ${totalWeight - 100}%`}). Sesuaikan slider bobot atau klik <strong>Ratakannya ke 100%</strong>.
                  </p>
                {/if}
              </div>

              <!-- Criterion Tactile Cards -->
              <div class="space-y-3.5">
                {#each rubricCriteria as criterion, idx}
                  <div class="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200/90 hover:border-indigo-200 transition space-y-3">
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div class="flex items-center gap-2.5 flex-1">
                        <span class="w-7 h-7 rounded-lg bg-indigo-600/10 text-indigo-700 font-mono tabular-nums text-xs font-extrabold flex items-center justify-center shrink-0">
                          0{idx + 1}
                        </span>
                        <div class="flex-1">
                          <label for="crit-name-{idx}" class="sr-only">
                            Nama Kriteria #{idx + 1}
                          </label>
                          <input
                            id="crit-name-{idx}"
                            type="text"
                            bind:value={criterion.name}
                            placeholder="Nama Kriteria (mis. Ketajaman Analisis)"
                            class="min-h-[42px] w-full rounded-xl border border-stone-300 bg-white px-3.5 py-2 text-sm font-bold text-[#0F172A] focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                          />
                        </div>
                      </div>

                      <!-- Tactile Weight Slider + Number Input -->
                      <div class="flex items-center gap-2.5 sm:w-56">
                        <label for="crit-slider-{idx}" class="sr-only">
                          Slider Bobot Kriteria #{idx + 1}
                        </label>
                        <input
                          id="crit-slider-{idx}"
                          type="range"
                          min="5"
                          max="100"
                          step="5"
                          bind:value={criterion.weightPercentage}
                          class="w-full accent-indigo-600 cursor-pointer"
                        />
                        <div class="relative w-20 shrink-0">
                          <label for="crit-weight-{idx}" class="sr-only">
                            Persentase Bobot #{idx + 1}
                          </label>
                          <input
                            id="crit-weight-{idx}"
                            type="number"
                            min="1"
                            max="100"
                            bind:value={criterion.weightPercentage}
                            class="min-h-[42px] w-full rounded-xl border border-amber-300 bg-amber-50/70 pr-6 pl-2.5 py-1.5 text-right font-mono tabular-nums text-sm font-extrabold text-amber-900 focus:border-indigo-600 focus:outline-none"
                          />
                          <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-mono font-bold text-amber-700 pointer-events-none">
                            %
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={rubricCriteria.length <= 1}
                          on:click={() => removeCriterion(idx)}
                          class="min-h-[42px] px-2.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 transition"
                          title="Hapus kriteria ini"
                          aria-label="Hapus kriteria {idx + 1}"
                        >
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    <div>
                      <label for="crit-desc-{idx}" class="sr-only">
                        Deskripsi Indikator Kriteria #{idx + 1}
                      </label>
                      <input
                        id="crit-desc-{idx}"
                        type="text"
                        bind:value={criterion.description}
                        placeholder="Jelaskan indikator jawaban yang berhak mendapat nilai penuh pada kriteria ini..."
                        class="min-h-[42px] w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2 text-sm text-slate-700 focus:border-indigo-600 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                      />
                    </div>
                  </div>
                {/each}
              </div>

              <button
                type="button"
                on:click={addCriterion}
                class="min-h-[44px] w-full py-2.5 px-4 rounded-xl border-2 border-dashed border-stone-300 hover:border-indigo-400 hover:bg-indigo-50/40 text-xs font-bold text-slate-700 hover:text-indigo-700 transition flex items-center justify-center gap-2"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Tambah Baris Kriteria Rubrik</span>
              </button>
            </div>

            <!-- Tone Selector: 3 Selectable Visual Radio Cards -->
            <div class="space-y-3">
              <div>
                <h3 class="text-sm font-extrabold uppercase tracking-wider text-slate-700">
                  Karakter & Standar Ketegasan Penilai (Grading Tone)
                </h3>
                <p class="text-xs text-slate-500 mt-0.5">
                  Pilih bagaimana asisten penilai menyikapi kekurangan minor pada lembar jawaban mahasiswa.
                </p>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                {#each [
                  {
                    id: 'Lenient',
                    title: 'Santai / Apresiatif',
                    badge: 'Lenient',
                    desc: 'Toleran terhadap kekurangan minor selama esensi pemahaman konsep utama sudah terjawab.'
                  },
                  {
                    id: 'Balanced',
                    title: 'Standar Objektif',
                    badge: 'Balanced',
                    desc: 'Proporsional sesuai bobot rubrik; memberikan apresiasi adil dan koreksi yang seimbang.'
                  },
                  {
                    id: 'Rigorous',
                    title: 'Kritis / Ketat',
                    badge: 'Rigorous',
                    desc: 'Menguji kedalaman argumen, kelengkapan bukti/sitasi, dan ketepatan terminologi secara ketat.'
                  }
                ] as toneOption}
                  {@const isSelected = selectedTone === toneOption.id}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    on:click={() => (selectedTone = toneOption.id as GradingTone)}
                    class="text-left p-4 rounded-2xl border-2 transition-all flex flex-col justify-between gap-3 active:scale-[0.99] {isSelected
                      ? 'border-indigo-600 bg-indigo-50/50 shadow-sm'
                      : 'border-stone-200/90 bg-white hover:border-stone-300'}"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <span class="block text-sm font-extrabold text-[#0F172A]">
                          {toneOption.title}
                        </span>
                        <span class="inline-block font-mono text-[11px] font-semibold text-indigo-700 mt-0.5">
                          {toneOption.badge}
                        </span>
                      </div>
                      <span
                        class="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 {isSelected
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-stone-300 bg-white'}"
                      >
                        {#if isSelected}
                          <span class="w-2 h-2 rounded-full bg-white"></span>
                        {/if}
                      </span>
                    </div>
                    <p class="text-xs text-slate-600 leading-relaxed">
                      {toneOption.desc}
                    </p>
                  </button>
                {/each}
              </div>
            </div>
          </div>
        </div>

        <!-- Step 1 Footer CTA -->
        <div class="pt-6 border-t border-stone-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="text-xs text-slate-500">
            {#if isStep1Valid}
              <span class="text-emerald-700 font-semibold">
                Konfigurasi rubrik telah valid (Total bobot 100%). Siap mengunggah berkas mahasiswa.
              </span>
            {:else}
              <span>
                Pastikan deskripsi tugas terisi dan total bobot rubrik berjumlah tepat 100%.
              </span>
            {/if}
          </div>
          <button
            type="button"
            disabled={!isStep1Valid}
            on:click={() => (currentStep = 2)}
            class="min-h-[48px] px-7 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-300 text-white text-sm font-bold shadow-sm transition inline-flex items-center justify-center gap-2.5 active:scale-[0.98]"
          >
            <span>Lanjut ke Baki Sortir & Upload Berkas</span>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </section>
    {/if}

    <!-- ===================================================================== -->
    <!-- STEP 2: "THE SORTING TRAY" (BULK UPLOAD & LOCAL SIMILARITY RADAR)     -->
    <!-- Nuance: Kinetic, tactile, transparent. Sky Teal & Coral Rose.         -->
    <!-- ===================================================================== -->
    {#if currentStep === 2}
      <section aria-labelledby="step2-heading" class="bg-white rounded-3xl border border-stone-200/90 border-t-4 border-t-sky-600 shadow-[0_20px_40px_-15px_rgba(15,23,42,0.05)] p-6 sm:p-8 lg:p-10 space-y-8">
        <!-- Workspace Header -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-stone-200/80">
          <div>
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-50 border border-sky-200 text-sky-800 text-xs font-bold uppercase tracking-wider mb-2">
              <span>Tahap 2 dari 4 • Baki Sortir & Radar Kemiripan Lokal</span>
            </div>
            <h2 id="step2-heading" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A]">
              Unggah Berkas Kelas & Pindai Plagiasi (0 Token Cost)
            </h2>
            <p class="text-[15px] text-slate-600 mt-1 leading-relaxed max-w-2xl">
              Masukkan seluruh berkas tugas mahasiswa sekaligus. Mesin lokal kami mengekstrak teks dan memetakan kemiripan TF-IDF Cosine secara instan tanpa memotong kuota kredit.
            </p>
          </div>
          <div class="flex items-center gap-2 self-start sm:self-auto">
            <span class="text-xs font-mono font-semibold px-3 py-2 rounded-xl bg-[#FAF8F5] border border-stone-200 text-slate-700">
              Ambang Plagiasi: &ge;{Math.round(similarityThreshold * 100)}%
            </span>
          </div>
        </div>

        <!-- Top Hero Zone: Inviting Drag-and-Drop Vault -->
        <div class="space-y-4">
          <label
            on:dragover|preventDefault={() => (isDragging = true)}
            on:dragleave={() => (isDragging = false)}
            on:drop|preventDefault={(e) => {
              isDragging = false;
              if (e.dataTransfer?.files) {
                handleFileUpload(e.dataTransfer.files);
              }
            }}
            class="flex flex-col items-center justify-center border-2 border-dashed rounded-3xl p-10 sm:p-12 cursor-pointer transition-all text-center {isDragging
              ? 'border-sky-600 bg-sky-50/90 scale-[0.995]'
              : 'border-sky-300 bg-sky-50/40 hover:bg-sky-50/80 hover:border-sky-400'}"
          >
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.zip"
              class="hidden"
              on:change={(e) => {
                const input = e.currentTarget;
                if (input.files) handleFileUpload(input.files);
              }}
            />
            <div class="w-16 h-16 rounded-2xl bg-sky-600 text-white flex items-center justify-center shadow-sm mb-4">
              {#if isParsing}
                <svg class="w-7 h-7 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              {:else}
                <svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              {/if}
            </div>
            <p class="text-base sm:text-lg font-extrabold text-[#0F172A]">
              {isParsing
                ? 'Mengekstrak teks dokumen & menghitung matriks kemiripan lintas mahasiswa...'
                : 'Tarik & Lepaskan Berkas Tugas Mahasiswa ke Baki Ini, atau Klik untuk Memilih'}
            </p>
            <p class="text-sm text-slate-600 mt-1.5 max-w-xl">
              Mendukung banyak berkas <code>.PDF</code>, <code>.DOCX</code>, <code>.TXT</code> sekaligus, atau 1 bundel arsip <code>.ZIP</code> satu kelas (maksimal 100 berkas, 5 MB/berkas).
            </p>
          </label>

          <!-- Zero-Friction Onboarding Pill -->
          <div class="flex justify-center">
            <button
              type="button"
              disabled={isParsing}
              on:click={loadDemoDocuments}
              class="min-h-[44px] px-5 py-2.5 rounded-full border border-sky-200 bg-white hover:bg-sky-50 text-sky-800 text-xs sm:text-sm font-bold shadow-sm transition inline-flex items-center gap-2.5 active:scale-[0.98]"
            >
              <svg class="w-4 h-4 text-sky-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>Belum menyiapkan file? Muat 4 Dokumen Sampel Demo</span>
            </button>
          </div>
        </div>

        <!-- Bottom Inspection Matrix (Appears after parsing) -->
        {#if extractedDocuments.length > 0}
          <div class="space-y-6 pt-2">
            <!-- Summary KPI Strip -->
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200/90">
                <span class="text-xs font-bold uppercase tracking-wider text-slate-500 block">
                  Total Dokumen Terbaca
                </span>
                <span class="text-2xl font-extrabold font-mono tabular-nums text-[#0F172A] mt-1 block">
                  {extractedDocuments.length}
                </span>
              </div>

              <div class="p-4 rounded-2xl bg-emerald-50/60 border border-emerald-200">
                <span class="text-xs font-bold uppercase tracking-wider text-emerald-800 block">
                  Aman (&lt;{Math.round(similarityThreshold * 100)}% Mirip)
                </span>
                <span class="text-2xl font-extrabold font-mono tabular-nums text-emerald-800 mt-1 block">
                  {safeSimilarityCount}
                </span>
              </div>

              <div class="p-4 rounded-2xl bg-rose-50/70 border border-rose-200">
                <span class="text-xs font-bold uppercase tracking-wider text-rose-800 block">
                  Indikasi Menyontek (&ge;{Math.round(similarityThreshold * 100)}%)
                </span>
                <span class="text-2xl font-extrabold font-mono tabular-nums text-rose-700 mt-1 block">
                  {flaggedSimilarityCount}
                </span>
              </div>

              <div class="p-4 rounded-2xl bg-amber-50/70 border border-amber-200">
                <span class="text-xs font-bold uppercase tracking-wider text-amber-900 block">
                  Dokumen Kosong / Bypass (&lt;20 Kata)
                </span>
                <span class="text-2xl font-extrabold font-mono tabular-nums text-amber-800 mt-1 block">
                  {bypassedDocCount}
                </span>
              </div>
            </div>

            <!-- Inspection Matrix Table -->
            <div class="overflow-x-auto rounded-2xl border border-stone-200/90">
              <table class="min-w-full divide-y divide-stone-200 text-sm">
                <thead class="bg-[#FAF8F5] text-xs font-extrabold uppercase tracking-wider text-slate-600">
                  <tr>
                    <th class="px-4 py-3.5 text-left w-12">No</th>
                    <th class="px-4 py-3.5 text-left">Nama File Mahasiswa</th>
                    <th class="px-4 py-3.5 text-left">Format</th>
                    <th class="px-4 py-3.5 text-left">Volume Teks</th>
                    <th class="px-4 py-3.5 text-left">Radar Kemiripan Lokal</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-stone-200/80 bg-white">
                  {#each extractedDocuments as doc, idx}
                    {@const sim = getSimilarityForDoc(doc)}
                    <tr class="hover:bg-[#FAF8F5] transition">
                      <td class="px-4 py-3.5 font-mono tabular-nums text-xs text-slate-500">
                        {idx + 1}
                      </td>
                      <td class="px-4 py-3.5 font-semibold text-[#0F172A]">
                        {doc.originalFilename}
                        {#if doc.parseError}
                          <span class="block text-xs font-medium text-rose-600 mt-0.5">
                            Gagal Ekstrak: {doc.parseError}
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-3.5">
                        <span class="font-mono uppercase text-xs font-bold px-2.5 py-1 rounded-md bg-stone-100 text-slate-700 border border-stone-200">
                          {doc.fileType}
                        </span>
                      </td>
                      <td class="px-4 py-3.5">
                        <span class="font-mono tabular-nums font-semibold text-slate-800">
                          {doc.wordCount} kata
                        </span>
                        {#if doc.wordCount < 20}
                          <span class="inline-flex items-center gap-1 ml-2 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                            Auto-Bypass API (0 Token)
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-3.5">
                        {#if sim.similarity_flagged}
                          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300">
                            <span class="w-2 h-2 rounded-full bg-rose-600"></span>
                            <span class="font-mono tabular-nums">
                              Mirip {Math.round(sim.max_similarity_score * 100)}%
                            </span>
                            {#if sim.closest_match_file}
                              <span>dengan {sim.closest_match_file}</span>
                            {/if}
                          </span>
                        {:else}
                          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono tabular-nums">
                            Aman ({Math.round(sim.max_similarity_score * 100)}%)
                          </span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}

        <!-- Step 2 Footer Navigation -->
        <div class="pt-6 border-t border-stone-200/80 flex flex-col sm:flex-row items-center justify-between gap-4">
          <button
            type="button"
            on:click={() => (currentStep = 1)}
            class="min-h-[44px] w-full sm:w-auto px-5 py-2.5 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-slate-700 text-sm font-bold transition"
          >
            Kembali ke Meja Studi
          </button>
          <button
            type="button"
            disabled={extractedDocuments.length === 0}
            on:click={() => (currentStep = 3)}
            class="min-h-[48px] w-full sm:w-auto px-7 py-3 rounded-2xl bg-sky-600 hover:bg-sky-700 disabled:bg-stone-300 text-white text-sm font-bold shadow-sm transition inline-flex items-center justify-center gap-2.5 active:scale-[0.98]"
          >
            <span>Lanjut ke Lab Kalibrasi (Uji 3 Sampel Gratis)</span>
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </section>
    {/if}

    <!-- ===================================================================== -->
    <!-- STEP 3: "THE CALIBRATION LAB" (UJI 3 SAMPEL & PENYESUAIAN STANDAR)    -->
    <!-- Nuance: Analytical, reassuring, controlled. Royal Violet & Emerald.   -->
    <!-- ===================================================================== -->
    {#if currentStep === 3}
      <section aria-labelledby="step3-heading" class="bg-white rounded-3xl border border-stone-200/90 border-t-4 border-t-violet-600 shadow-[0_20px_40px_-15px_rgba(15,23,42,0.05)] p-6 sm:p-8 lg:p-10 space-y-8">
        <!-- Top Control Banner -->
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-stone-200/80">
          <div>
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-50 border border-violet-200 text-violet-800 text-xs font-bold uppercase tracking-wider mb-2">
              <span>Tahap 3 dari 4 • Laboratorium Kalibrasi Standar Dosen</span>
            </div>
            <h2 id="step3-heading" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A]">
              Uji 3 Sampel Pertama &amp; Selaraskan Standar Nilai
            </h2>
            <p class="text-[15px] text-slate-600 mt-1 leading-relaxed max-w-2xl">
              Tinjau cara AI menilai 3 naskah pertama secara gratis sebelum memproses seluruh kelas. Anda memegang kendali penuh untuk mengoreksi standar penilaian.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <div class="px-4 py-2.5 rounded-2xl bg-violet-50/90 border border-violet-200 text-violet-950 text-xs font-bold">
              Uji Kalibrasi Gratis (Kuota Sesi:
              <span class="font-mono tabular-nums text-violet-700">
                {MAX_FREE_CALIBRATION_RUNS - calibrationRunsUsed}/{MAX_FREE_CALIBRATION_RUNS}
              </span>
              Tersisa)
            </div>

            <button
              type="button"
              disabled={isCalibrating || isExecutingBatch || calibrationRunsUsed >= MAX_FREE_CALIBRATION_RUNS}
              on:click={triggerCalibrationSample}
              class="min-h-[44px] px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:bg-stone-300 text-white text-xs sm:text-sm font-bold shadow-sm transition inline-flex items-center gap-2 active:scale-[0.98]"
            >
              {#if isCalibrating}
                <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span>Mengevaluasi 3 Sampel...</span>
              {:else}
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>
                  {calibrationSamples.length > 0
                    ? 'Uji Ulang 3 Sampel (Gratis)'
                    : 'Jalankan Uji 3 Sampel Pertama (0 Kredit)'}
                </span>
              {/if}
            </button>
          </div>
        </div>

        <!-- 3-Card Horizontal Comparison Deck -->
        {#if calibrationSamples.length > 0}
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-extrabold uppercase tracking-wider text-slate-700">
                Kartu Laporan 3 Sampel Kalibrasi
              </h3>
              <span class="text-xs text-slate-500">
                Bandingkan rincian alasan AI dengan ekspektasi penilaian Anda
              </span>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {#each calibrationSamples as sample, sIdx}
                <article class="rounded-2xl border border-stone-200/90 bg-[#FAF8F5] p-5 flex flex-col justify-between space-y-5 shadow-sm">
                  <div class="space-y-4">
                    <!-- Student Identity & Large Score Badge -->
                    <div class="flex items-start justify-between gap-3 border-b border-stone-200 pb-4">
                      <div>
                        <span class="text-[11px] font-mono uppercase tracking-wider font-bold text-violet-700">
                          Sampel #{sIdx + 1}
                        </span>
                        <h4 class="text-base font-extrabold text-[#0F172A] mt-0.5">
                          {sample.evaluation?.student_identity.extracted_name ?? 'Identitas Tidak Tertera'}
                        </h4>
                        <p class="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
                          NIM: {sample.evaluation?.student_identity.extracted_id ?? '-'} • {sample.filename}
                        </p>
                      </div>

                      {#if sample.evaluation}
                        <div class="px-3.5 py-2 rounded-2xl bg-white border border-violet-200 text-right shrink-0 shadow-xs">
                          <span class="block text-2xl font-extrabold font-mono tabular-nums text-violet-700 leading-none">
                            {sample.evaluation.final_weighted_score}
                          </span>
                          <span class="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-1">
                            AI: {sample.evaluation.ai_writing_suspicion}
                          </span>
                        </div>
                      {/if}
                    </div>

                    <!-- Per-Criterion Score Bars & Reasoning -->
                    {#if sample.evaluation}
                      <div class="space-y-3">
                        {#each sample.evaluation.grading_breakdown as b}
                          <div class="bg-white p-3.5 rounded-xl border border-stone-200/80 space-y-2">
                            <div class="flex items-center justify-between text-xs font-bold text-[#0F172A]">
                              <span>{b.criterion_name} ({b.weight_percentage}%)</span>
                              <span class="font-mono tabular-nums text-violet-700">{b.score_given}/100</span>
                            </div>
                            <div class="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden">
                              <div
                                class="h-full bg-violet-600 rounded-full"
                                style="width: {Math.min(100, Math.max(0, b.score_given))}%"
                              ></div>
                            </div>
                            <p class="text-xs text-slate-600 leading-relaxed">
                              {b.short_reasoning}
                            </p>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <div class="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                        {sample.error_message || 'Sampel ini memerlukan tinjauan manual.'}
                      </div>
                    {/if}
                  </div>

                  <!-- Quoted Constructive Feedback Preview -->
                  {#if sample.evaluation}
                    <div class="pt-3 border-t border-stone-200/80">
                      <span class="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                        Kutipan Feedback Mahasiswa
                      </span>
                      <blockquote class="text-xs text-slate-700 italic leading-relaxed bg-white p-3 rounded-xl border border-stone-200/70">
                        "{sample.evaluation.feedback_for_student}"
                      </blockquote>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          </div>
        {:else}
          <!-- Empty State before calibration sample run -->
          <div class="rounded-2xl border-2 border-dashed border-stone-200 bg-[#FAF8F5] p-8 text-center space-y-3">
            <div class="w-12 h-12 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center mx-auto">
              <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" />
              </svg>
            </div>
            <h3 class="text-base font-extrabold text-[#0F172A]">
              Belum Ada Sampel Kalibrasi yang Dijalankan
            </h3>
            <p class="text-sm text-slate-600 max-w-xl mx-auto leading-relaxed">
              Klik tombol <strong>Jalankan Uji 3 Sampel Pertama (0 Kredit)</strong> di kanan atas untuk melihat simulasi penilaian AI terhadap 3 mahasiswa pertama Anda, atau langsung proses seluruh kelas di bawah.
            </p>
          </div>
        {/if}

        <!-- Bottom Decision Dock (Highlighted Card) -->
        <div class="rounded-3xl bg-[#FAF8F5] border-2 border-stone-200/90 p-6 sm:p-7 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <!-- Left Side: Calibration Notes Override -->
          <div class="lg:col-span-7 space-y-3">
            <div class="flex items-center justify-between">
              <label for="calibration-notes" class="text-base font-extrabold text-[#0F172A]">
                Kurang pas penilaiannya? Berikan Instruksi Koreksi Dosen
              </label>
              <span class="text-xs font-semibold text-violet-700">
                Diterapkan Seragam ke Seluruh Kelas
              </span>
            </div>
            <p class="text-xs text-slate-600 leading-relaxed">
              Tambahkan instruksi spesifik jika AI dirasa terlalu pelit atau terlalu longgar pada kriteria tertentu.
            </p>
            <div class="flex flex-col sm:flex-row gap-2.5">
              <textarea
                id="calibration-notes"
                rows="2"
                bind:value={calibrationNotes}
                placeholder="Contoh: Kurangi maksimal 5 poin saja jika format sitasi belum APA Style selama sumbernya valid..."
                class="flex-1 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm text-[#0F172A] focus:border-violet-600 focus:ring-2 focus:ring-violet-500/20 focus:outline-none"
              ></textarea>
              {#if calibrationRunsUsed < MAX_FREE_CALIBRATION_RUNS}
                <button
                  type="button"
                  disabled={isCalibrating || isExecutingBatch}
                  on:click={triggerCalibrationSample}
                  class="min-h-[44px] px-4 py-2.5 rounded-xl border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900 text-xs font-bold transition shrink-0"
                >
                  Uji Ulang Sampel
                </button>
              {/if}
            </div>
          </div>

          <!-- Right Side: Primary Batch Execution CTA -->
          <div class="lg:col-span-5 bg-white p-5 rounded-2xl border border-stone-200/90 space-y-4 shadow-xs">
            <div class="flex items-center justify-between text-xs text-slate-600">
              <span>Antrean Paralel (3x Worker):</span>
              <span class="font-mono tabular-nums font-bold text-[#0F172A]">
                {extractedDocuments.length} Dokumen (~{estimatedBatchSeconds} detik)
              </span>
            </div>
            {#if bypassedDocCount > 0}
              <div class="text-[11px] font-semibold text-amber-800 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-200">
                {bypassedDocCount} dokumen kosong (&lt;20 kata) otomatis di-bypass (Hemat Token).
              </div>
            {/if}
            <button
              type="button"
              disabled={isExecutingBatch || isCalibrating}
              on:click={executeRemainingOrFullBatch}
              class="min-h-[52px] w-full px-6 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 text-white text-sm font-extrabold shadow-sm transition flex items-center justify-center gap-2.5 active:scale-[0.98]"
            >
              {#if isExecutingBatch}
                <svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span>Memproses Seluruh Kelas (~{estimatedBatchSeconds} dtk)...</span>
              {:else}
                <span>Standar Sudah Pas — Proses Seluruh Kelas ({extractedDocuments.length} Kredit)</span>
              {/if}
            </button>
          </div>
        </div>

        <div class="pt-2 flex justify-start">
          <button
            type="button"
            on:click={() => (currentStep = 2)}
            class="min-h-[44px] px-4 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-slate-700 text-xs font-bold transition"
          >
            Kembali ke Baki Sortir Berkas
          </button>
        </div>
      </section>
    {/if}

    <!-- ===================================================================== -->
    <!-- STEP 4: "THE OFFICIAL LEDGER" (REKAP NILAI, DIFF VIEWER & EXPORT)     -->
    <!-- Nuance: Authoritative, spreadsheet-grade clarity. Deep Emerald/Slate. -->
    <!-- ===================================================================== -->
    {#if currentStep === 4}
      <section aria-labelledby="step4-heading" class="bg-white rounded-3xl border border-stone-200/90 border-t-4 border-t-emerald-600 shadow-[0_20px_40px_-15px_rgba(15,23,42,0.05)] p-6 sm:p-8 lg:p-10 space-y-8">
        <!-- Top Telemetry & Settlement Banner -->
        <div class="flex flex-col xl:flex-row xl:items-center justify-between gap-6 pb-6 border-b border-stone-200/80">
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold uppercase tracking-wider">
                Tahap 4 dari 4 • Buku Besar Nilai Resmi (Official Ledger)
              </span>
              {#if lastRefundedCredits > 0}
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-800 border border-indigo-200 font-mono tabular-nums">
                  Auto-Refund +{lastRefundedCredits} Kredit (Dokumen Tinjauan Manual)
                </span>
              {/if}
              {#if rawTextPurged}
                <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                  Teks Mentah Telah Dibersihkan
                </span>
              {/if}
            </div>

            <h2 id="step4-heading" class="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A]">
              Rekap Nilai Akhir, Koreksi Langsung &amp; Ekspor SIAKAD
            </h2>
            <p class="text-[15px] text-slate-600 leading-relaxed">
              Klik angka skor pada tabel untuk penyesuaian instan, tinjau perbandingan teks mahasiswa yang terindikasi menyontek, lalu unduh rekap nilai.
            </p>
          </div>

          <!-- Primary Action Group -->
          <div class="flex flex-wrap items-center gap-3">
            <!-- Optional SIAKAD Roster Sync Toggle -->
            <label class="min-h-[44px] px-3.5 py-2 rounded-xl border border-stone-200 bg-[#FAF8F5] hover:bg-stone-100 text-xs font-bold text-slate-700 cursor-pointer inline-flex items-center gap-2.5 transition">
              <input
                type="checkbox"
                bind:checked={siakadSyncEnabled}
                class="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
              />
              <span>Format SIAKAD / Kampus</span>
            </label>

            <!-- Data Purge Button (Fitur #6) -->
            <button
              type="button"
              disabled={rawTextPurged}
              on:click={handlePurgeRawText}
              class="min-h-[44px] px-4 py-2.5 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-slate-700 text-xs font-bold disabled:opacity-40 transition"
              title="Hapus seluruh teks mentah dokumen dari penyimpanan lokal dan hanya simpan nilai & feedback"
            >
              {rawTextPurged
                ? 'Teks Mentah Dihapus'
                : 'Bersihkan Teks Mentah (Simpan Nilai Saja)'}
            </button>

            <!-- Prominent CSV / Excel Export CTA -->
            <button
              type="button"
              disabled={isExporting || batchResults.length === 0}
              on:click={downloadGradebookCSV}
              class="min-h-[48px] px-6 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-stone-300 text-white text-xs sm:text-sm font-extrabold shadow-sm transition inline-flex items-center gap-2.5 active:scale-[0.98]"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>
                {isExporting
                  ? 'Menyiapkan Berkas...'
                  : 'Download Rekap Nilai (.CSV / Excel)'}
              </span>
            </button>
          </div>
        </div>

        <!-- Ledger Summary KPI Strip -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200/90">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-500 block">
              Selesai Dinilai
            </span>
            <span class="text-2xl font-extrabold font-mono tabular-nums text-[#0F172A] mt-1 block">
              {completedBatchItems.length} / {batchResults.length}
            </span>
          </div>

          <div class="p-4 rounded-2xl bg-emerald-50/60 border border-emerald-200">
            <span class="text-xs font-bold uppercase tracking-wider text-emerald-800 block">
              Rata-Rata Nilai Kelas
            </span>
            <span class="text-2xl font-extrabold font-mono tabular-nums text-emerald-800 mt-1 block">
              {classAverageScore}
            </span>
          </div>

          <div class="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200/90">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-500 block">
              Nilai Tertinggi
            </span>
            <span class="text-2xl font-extrabold font-mono tabular-nums text-[#0F172A] mt-1 block">
              {highestClassScore}
            </span>
          </div>

          <div class="p-4 rounded-2xl {manualReviewCount > 0 ? 'bg-amber-50 border-amber-300' : 'bg-[#FAF8F5] border-stone-200/90'} border">
            <span class="text-xs font-bold uppercase tracking-wider {manualReviewCount > 0 ? 'text-amber-900' : 'text-slate-500'} block">
              Perlu Tinjauan Manual
            </span>
            <span class="text-2xl font-extrabold font-mono tabular-nums {manualReviewCount > 0 ? 'text-amber-800' : 'text-[#0F172A]'} mt-1 block">
              {manualReviewCount}
            </span>
          </div>
        </div>

        <!-- High-Density Interactive Gradebook Table -->
        <div class="overflow-x-auto rounded-2xl border border-stone-200/90 shadow-xs">
          <table class="min-w-full divide-y divide-stone-200 text-sm">
            <thead class="bg-[#0F172A] text-stone-100 text-xs font-bold uppercase tracking-wider sticky top-0">
              <tr>
                <th class="px-4 py-3.5 text-left w-12">No</th>
                <th class="px-4 py-3.5 text-left">Nama Mahasiswa &amp; NIM</th>
                {#if !siakadSyncEnabled}
                  <th class="px-4 py-3.5 text-left">Skor Kriteria (Klik Edit)</th>
                {/if}
                <th class="px-4 py-3.5 text-left">Radar Kemiripan</th>
                <th class="px-4 py-3.5 text-left">Indikasi AI</th>
                <th class="px-4 py-3.5 text-left">Nilai Akhir</th>
                <th class="px-4 py-3.5 text-right">Inspeksi &amp; Diff Viewer</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-200/80 bg-white">
              {#each batchResults as item, idx}
                {@const isFlashing = recentlyUpdatedRowIndex === idx}
                <tr
                  class="transition-colors duration-300 {isFlashing
                    ? 'bg-emerald-50/90'
                    : idx % 2 === 1
                      ? 'bg-[#FAF8F5]/60 hover:bg-stone-100/70'
                      : 'bg-white hover:bg-stone-100/70'}"
                >
                  <td class="px-4 py-4 font-mono tabular-nums text-xs text-slate-500">
                    {idx + 1}
                  </td>

                  <td class="px-4 py-4">
                    <div class="font-bold text-[#0F172A] text-[15px]">
                      {item.evaluation?.student_identity.extracted_name ?? 'Tidak Tertera'}
                    </div>
                    <div class="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
                      NIM: {item.evaluation?.student_identity.extracted_id ?? 'Tidak Tertera'} • {item.filename}
                    </div>
                    {#if item.status === 'MANUAL_REVIEW_REQUIRED'}
                      <span class="inline-block mt-1 px-2.5 py-0.5 rounded-md text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                        MANUAL_REVIEW_REQUIRED (Kredit Di-refund)
                      </span>
                    {:else if item.evaluation?.grading_breakdown?.[0]?.short_reasoning?.includes('Tidak memotong token API')}
                      <span class="inline-block mt-1 px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-stone-100 text-slate-600 border border-stone-200">
                        Auto-Bypass (&lt;20 kata)
                      </span>
                    {/if}
                  </td>

                  {#if !siakadSyncEnabled}
                    <td class="px-4 py-4">
                      {#if item.evaluation}
                        <div class="flex flex-wrap items-center gap-2">
                          {#each item.evaluation.grading_breakdown as crit, cIdx}
                            <div class="inline-flex items-center gap-1.5 bg-[#FAF8F5] border border-stone-200 rounded-xl px-2.5 py-1">
                              <span class="text-[11px] font-semibold text-slate-600 truncate max-w-[110px]" title={crit.criterion_name}>
                                K{cIdx + 1} ({crit.weight_percentage}%):
                              </span>
                              <label for="inline-crit-{idx}-{cIdx}" class="sr-only">
                                Skor {crit.criterion_name} untuk baris {idx + 1}
                              </label>
                              <input
                                id="inline-crit-{idx}-{cIdx}"
                                type="number"
                                min="0"
                                max="100"
                                value={crit.score_given}
                                on:change={(e) =>
                                  handleCriterionScoreEdit(
                                    idx,
                                    cIdx,
                                    e.currentTarget.value
                                  )}
                                class="w-14 rounded-lg border border-stone-300 bg-white px-1.5 py-0.5 text-center font-mono tabular-nums text-xs font-bold text-[#0F172A] focus:border-emerald-600 focus:outline-none"
                              />
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <span class="text-xs text-amber-800 font-medium">
                          Menunggu input nilai manual
                        </span>
                      {/if}
                    </td>
                  {/if}

                  <td class="px-4 py-4">
                    {#if item.integrity_check.similarity_flagged}
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'side_by_side')}
                        class="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300 hover:bg-rose-200 transition font-mono tabular-nums"
                        title="Klik untuk membuka Side-by-Side Similarity Viewer"
                      >
                        <span class="w-2 h-2 rounded-full bg-rose-600"></span>
                        <span>
                          Mirip {Math.round(item.integrity_check.max_similarity_score * 100)}% • Bandingkan
                        </span>
                      </button>
                      {#if item.integrity_check.closest_match_file}
                        <span class="block text-[11px] text-rose-700 mt-1 font-medium">
                          vs {item.integrity_check.closest_match_file}
                        </span>
                      {/if}
                    {:else}
                      <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 font-mono tabular-nums">
                        Aman ({Math.round(item.integrity_check.max_similarity_score * 100)}%)
                      </span>
                    {/if}
                  </td>

                  <td class="px-4 py-4">
                    {#if item.evaluation}
                      <span
                        class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold {item.evaluation
                          .ai_writing_suspicion === 'High'
                          ? 'bg-rose-50 text-rose-800 border border-rose-200'
                          : item.evaluation.ai_writing_suspicion === 'Medium'
                            ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-stone-100 text-slate-700 border border-stone-200'}"
                      >
                        {item.evaluation.ai_writing_suspicion}
                      </span>
                    {:else}
                      <span class="text-xs text-slate-400">-</span>
                    {/if}
                  </td>

                  <td class="px-4 py-4">
                    {#if item.evaluation}
                      <label for="final-score-{idx}" class="sr-only">
                        Nilai Akhir Mahasiswa Baris {idx + 1}
                      </label>
                      <input
                        id="final-score-{idx}"
                        type="number"
                        step="0.5"
                        min="0"
                        max="100"
                        value={item.evaluation.final_weighted_score}
                        on:change={(e) =>
                          handleInlineFinalScoreChange(idx, e.currentTarget.value)}
                        class="min-h-[42px] w-24 rounded-xl border border-stone-300 bg-white px-3 py-1.5 font-mono tabular-nums text-base font-extrabold text-emerald-800 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 focus:outline-none"
                      />
                    {:else}
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'extracted_text')}
                        class="min-h-[40px] px-3 py-1.5 rounded-xl bg-amber-100 hover:bg-amber-200 text-xs text-amber-950 font-bold transition"
                      >
                        Beri Nilai Manual
                      </button>
                    {/if}
                  </td>

                  <td class="px-4 py-4 text-right">
                    <div class="inline-flex items-center justify-end gap-2">
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'extracted_text')}
                        class="min-h-[40px] px-3 py-1.5 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-xs font-bold text-slate-700 transition"
                      >
                        Teks Asli
                      </button>
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'grading')}
                        class="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-xs font-bold text-white transition"
                      >
                        Rincian &amp; Feedback
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="pt-4 border-t border-stone-200/80 flex items-center justify-between">
          <button
            type="button"
            on:click={() => (currentStep = 3)}
            class="min-h-[44px] px-4 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-slate-700 text-xs font-bold transition"
          >
            Kembali ke Lab Kalibrasi
          </button>
          <span class="text-xs text-slate-500 font-mono">
            Setiap perubahan skor langsung tersimpan otomatis di sesi perangkat ini.
          </span>
        </div>
      </section>
    {/if}
  </main>
</div>

<!-- ======================================================================= -->
<!-- MODAL RINCIAN PENILAIAN, TEKS ASLI, & SIDE-BY-SIDE DIFF VIEWER          -->
<!-- ======================================================================= -->
{#if selectedResultForModal}
  {@const currentDocText = getExtractedTextByFilename(
    selectedResultForModal.filename,
    selectedResultForModal.document_id
  )}
  {@const closestMatchFilename =
    selectedResultForModal.integrity_check.closest_match_file}
  {@const comparisonDocText = getExtractedTextByFilename(closestMatchFilename)}

  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
      class="bg-white rounded-3xl max-w-5xl w-full max-h-[90dvh] overflow-y-auto shadow-2xl border border-stone-200 p-6 sm:p-8 space-y-6"
    >
      <div class="flex items-start justify-between gap-4 border-b border-stone-200 pb-4">
        <div>
          <span class="text-xs font-bold uppercase tracking-wider text-indigo-600">
            Lembar Evaluasi &amp; Inspeksi Naskah Mahasiswa
          </span>
          <h3 id="detail-modal-title" class="text-xl font-extrabold text-[#0F172A] mt-0.5">
            {selectedResultForModal.evaluation?.student_identity.extracted_name ??
              selectedResultForModal.filename}
          </h3>
          <p class="text-xs font-mono tabular-nums text-slate-500 mt-0.5">
            NIM: {selectedResultForModal.evaluation?.student_identity.extracted_id ?? 'Tidak Tertera'} • Berkas: {selectedResultForModal.filename}
          </p>
        </div>
        <button
          type="button"
          on:click={closeDetailModal}
          class="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-stone-200 hover:bg-stone-100 text-xs font-bold text-slate-700 transition"
        >
          Tutup
        </button>
      </div>

      <!-- Tab Navigation inside Modal -->
      <div class="flex flex-wrap gap-2 border-b border-stone-200 pb-3">
        <button
          type="button"
          on:click={() => (activeModalTab = 'grading')}
          class="min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
          'grading'
            ? 'bg-[#0F172A] text-white'
            : 'bg-[#FAF8F5] text-slate-700 hover:bg-stone-200/70 border border-stone-200'}"
        >
          Rincian Skor &amp; Feedback
        </button>
        <button
          type="button"
          on:click={() => (activeModalTab = 'extracted_text')}
          class="min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
          'extracted_text'
            ? 'bg-[#0F172A] text-white'
            : 'bg-[#FAF8F5] text-slate-700 hover:bg-stone-200/70 border border-stone-200'}"
        >
          Lihat Teks Dokumen Asli (Extracted Text)
        </button>
        {#if closestMatchFilename}
          <button
            type="button"
            on:click={() => (activeModalTab = 'side_by_side')}
            class="min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
            'side_by_side'
              ? 'bg-rose-600 text-white'
              : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100'}"
          >
            Bandingkan Teks Berdampingan ({Math.round(
              selectedResultForModal.integrity_check.max_similarity_score * 100
            )}% Mirip)
          </button>
        {/if}
      </div>

      <!-- TAB 1: RINCIAN NILAI & FEEDBACK -->
      {#if activeModalTab === 'grading'}
        {#if selectedResultForModal.evaluation}
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-600">
                Rincian Skor Per Kriteria Rubrik (Dapat Diedit)
              </h4>
              <span class="text-base font-extrabold font-mono tabular-nums text-emerald-700">
                Nilai Akhir Terbobot: {selectedResultForModal.evaluation.final_weighted_score}
              </span>
            </div>

            <div class="grid grid-cols-1 gap-3">
              {#each selectedResultForModal.evaluation.grading_breakdown as crit, cIdx}
                <div class="p-4 rounded-2xl bg-[#FAF8F5] border border-stone-200/90 space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-sm font-bold text-[#0F172A]">
                      {crit.criterion_name} ({crit.weight_percentage}%)
                    </span>
                    <div class="flex items-center gap-2">
                      <label for="modal-crit-score-{cIdx}" class="text-xs font-semibold text-slate-600">
                        Skor (0-100):
                      </label>
                      <input
                        id="modal-crit-score-{cIdx}"
                        type="number"
                        min="0"
                        max="100"
                        value={crit.score_given}
                        on:change={(e) =>
                          handleCriterionScoreEdit(
                            selectedResultIndex,
                            cIdx,
                            e.currentTarget.value
                          )}
                        class="min-h-[38px] w-20 rounded-xl border border-stone-300 bg-white px-2.5 py-1 text-center font-mono tabular-nums text-xs font-extrabold text-indigo-700"
                      />
                    </div>
                  </div>
                  <p class="text-[15px] text-slate-700 leading-relaxed">
                    {crit.short_reasoning}
                  </p>
                </div>
              {/each}
            </div>
          </div>

          <div class="space-y-2">
            <label for="modal-feedback" class="block text-xs font-extrabold uppercase tracking-wider text-slate-600">
              Feedback Konstruktif Untuk Mahasiswa
            </label>
            <textarea
              id="modal-feedback"
              rows="3"
              bind:value={selectedResultForModal.evaluation.feedback_for_student}
              on:input={() => (batchResults = [...batchResults])}
              class="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-[15px] leading-relaxed text-[#0F172A] focus:border-indigo-600 focus:outline-none"
            ></textarea>
          </div>
        {:else}
          <div class="p-5 rounded-2xl bg-amber-50 border border-amber-200 space-y-4">
            <div class="text-sm text-amber-950">
              Dokumen ini berstatus <strong>MANUAL_REVIEW_REQUIRED</strong>:
              <p class="mt-1 text-xs">{selectedResultForModal.error_message}</p>
            </div>

            <div class="border-t border-amber-200 pt-4 space-y-4">
              <h4 class="text-xs font-extrabold uppercase tracking-wider text-amber-950">
                Input Penilaian Manual Dosen
              </h4>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label for="manual-name" class="block text-xs font-bold text-slate-700 mb-1">
                    Nama Mahasiswa
                  </label>
                  <input
                    id="manual-name"
                    type="text"
                    bind:value={manualStudentNameInput}
                    placeholder="Nama Mahasiswa"
                    class="min-h-[42px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label for="manual-id" class="block text-xs font-bold text-slate-700 mb-1">
                    NIM / ID
                  </label>
                  <input
                    id="manual-id"
                    type="text"
                    bind:value={manualStudentIdInput}
                    placeholder="NIM Mahasiswa"
                    class="min-h-[42px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label for="manual-score" class="block text-xs font-bold text-slate-700 mb-1">
                    Nilai Akhir (0-100)
                  </label>
                  <input
                    id="manual-score"
                    type="number"
                    min="0"
                    max="100"
                    bind:value={manualScoreInput}
                    class="min-h-[42px] w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs font-mono font-extrabold text-indigo-700"
                  />
                </div>
              </div>
              <div>
                <label for="manual-feedback-input" class="block text-xs font-bold text-slate-700 mb-1">
                  Feedback Mahasiswa
                </label>
                <textarea
                  id="manual-feedback-input"
                  rows="2"
                  bind:value={manualFeedbackInput}
                  class="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs"
                ></textarea>
              </div>
              <button
                type="button"
                on:click={saveManualGradingForCurrentModal}
                class="min-h-[44px] px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition"
              >
                Simpan Nilai Manual
              </button>
            </div>
          </div>
        {/if}
      {/if}

      <!-- TAB 2: LIHAT TEKS DOKUMEN ASLI (EXTRACTED TEXT) -->
      {#if activeModalTab === 'extracted_text'}
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-xs font-extrabold uppercase tracking-wider text-slate-600">
              Isi Naskah Mahasiswa ({selectedResultForModal.filename})
            </span>
            {#if rawTextPurged}
              <span class="text-xs font-bold text-emerald-700">
                Teks mentah telah dihapus demi privasi
              </span>
            {/if}
          </div>

          <div class="p-6 rounded-2xl bg-[#FAF8F5] border border-stone-200 text-[#0F172A] text-[15px] whitespace-pre-wrap max-h-96 overflow-y-auto leading-relaxed">
            {#if rawTextPurged}
              [Teks mentah dokumen telah dibersihkan oleh dosen melalui fitur Data Purge Privasi Akademik.]
            {:else if currentDocText}
              {currentDocText}
            {:else}
              [Tidak ada teks yang dapat ditampilkan dari dokumen ini.]
            {/if}
          </div>

          {#if selectedResultForModal.status === 'MANUAL_REVIEW_REQUIRED'}
            <div class="p-4 rounded-2xl bg-indigo-50 border border-indigo-200 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div class="flex-1 space-y-2">
                <span class="block text-xs font-extrabold text-indigo-950">
                  Beri Nilai Langsung Setelah Membaca Teks:
                </span>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label for="quick-manual-score" class="sr-only">Nilai Manual (0-100)</label>
                    <input
                      id="quick-manual-score"
                      type="number"
                      min="0"
                      max="100"
                      bind:value={manualScoreInput}
                      placeholder="Nilai (0-100)"
                      class="min-h-[42px] w-full rounded-xl border border-indigo-300 bg-white px-3.5 py-2 text-xs font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label for="quick-manual-feedback" class="sr-only">Catatan Feedback</label>
                    <input
                      id="quick-manual-feedback"
                      type="text"
                      bind:value={manualFeedbackInput}
                      placeholder="Catatan feedback..."
                      class="min-h-[42px] w-full rounded-xl border border-indigo-300 bg-white px-3.5 py-2 text-xs"
                    />
                  </div>
                </div>
              </div>
              <button
                type="button"
                on:click={saveManualGradingForCurrentModal}
                class="min-h-[42px] px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shrink-0"
              >
                Simpan Nilai Manual
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- TAB 3: SIDE-BY-SIDE SIMILARITY VIEWER -->
      {#if activeModalTab === 'side_by_side'}
        <div class="space-y-4">
          <div class="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-between">
            <div class="text-xs text-rose-950">
              <strong>Perbandingan Kemiripan Lintas Dokumen:</strong> Tingkat kemiripan TF-IDF unigram+bigram sebesar <strong class="font-mono tabular-nums">{Math.round(selectedResultForModal.integrity_check.max_similarity_score * 100)}%</strong>.
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-2">
              <div class="text-xs font-extrabold text-[#0F172A] bg-[#FAF8F5] px-3.5 py-2.5 rounded-xl border border-stone-200">
                Naskah Mahasiswa Ini: {selectedResultForModal.filename}
              </div>
              <div class="p-5 rounded-2xl bg-[#FAF8F5] border border-stone-200 text-[#0F172A] text-[15px] whitespace-pre-wrap h-80 overflow-y-auto leading-relaxed">
                {rawTextPurged
                  ? '[Teks mentah telah dihapus (Data Purge).]'
                  : currentDocText || '[Kosong]'}
              </div>
            </div>

            <div class="space-y-2">
              <div class="text-xs font-extrabold text-rose-950 bg-rose-50 px-3.5 py-2.5 rounded-xl border border-rose-200">
                Naskah Pembanding Terdekat: {closestMatchFilename ?? '-'}
              </div>
              <div class="p-5 rounded-2xl bg-rose-50/30 border border-rose-200 text-[#0F172A] text-[15px] whitespace-pre-wrap h-80 overflow-y-auto leading-relaxed">
                {rawTextPurged
                  ? '[Teks mentah telah dihapus (Data Purge).]'
                  : comparisonDocText || '[Tidak ditemukan]'}
              </div>
            </div>
          </div>
        </div>
      {/if}

      <div class="pt-4 border-t border-stone-200 flex justify-end">
        <button
          type="button"
          on:click={closeDetailModal}
          class="min-h-[44px] px-6 py-2.5 rounded-xl bg-[#0F172A] text-white text-xs font-bold hover:bg-slate-800 transition"
        >
          Selesai &amp; Tutup
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ======================================================================= -->
<!-- DRAWER RIWAYAT SESI PENILAIAN (ANTI-REFRESH F5)                         -->
<!-- ======================================================================= -->
{#if showSessionDrawer}
  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-end">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-drawer-title"
      class="bg-white h-full max-w-md w-full shadow-2xl border-l border-stone-200 p-6 flex flex-col justify-between"
    >
      <div class="space-y-5 overflow-y-auto pr-1">
        <div class="flex items-center justify-between border-b border-stone-200 pb-4">
          <div>
            <h3 id="session-drawer-title" class="text-lg font-extrabold text-[#0F172A]">
              Riwayat Sesi Penilaian Kelas
            </h3>
            <p class="text-xs text-slate-500 mt-0.5">
              Tersimpan otomatis di browser Anda (Aman dari Refresh F5).
            </p>
          </div>
          <button
            type="button"
            on:click={() => (showSessionDrawer = false)}
            class="min-h-[38px] px-3 rounded-xl border border-stone-200 text-xs font-bold text-slate-600 hover:text-[#0F172A]"
          >
            Tutup
          </button>
        </div>

        <button
          type="button"
          on:click={createNewGradingSession}
          class="min-h-[44px] w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition"
        >
          + Buat Sesi Penilaian Kelas Baru
        </button>

        <div class="space-y-2.5">
          {#each savedSessions as sess}
            <div
              class="p-4 rounded-2xl border transition {sess.id === activeSessionId
                ? 'border-indigo-600 bg-indigo-50/40'
                : 'border-stone-200 bg-[#FAF8F5] hover:border-stone-300'}"
            >
              <div class="flex items-start justify-between gap-2">
                <button
                  type="button"
                  on:click={() => switchGradingSession(sess.id)}
                  class="text-left flex-1"
                >
                  <div class="text-sm font-extrabold text-[#0F172A]">
                    {sess.title}
                  </div>
                  <div class="text-xs font-mono tabular-nums text-slate-500 mt-1">
                    Tahap {sess.currentStep}/4 • {sess.extractedDocuments.length} Dokumen • {sess.batchResults.length} Dinilai
                  </div>
                  {#if sess.rawTextPurged}
                    <span class="inline-block mt-1.5 text-[10px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                      Teks Mentah Dibersihkan
                    </span>
                  {/if}
                </button>
                {#if savedSessions.length > 1}
                  <button
                    type="button"
                    on:click={() => handleRemoveSession(sess.id)}
                    class="min-h-[32px] text-xs font-bold text-rose-600 hover:underline px-2 py-1"
                    title="Hapus sesi ini"
                  >
                    Hapus
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="pt-4 border-t border-stone-200 text-xs text-slate-500 leading-relaxed">
        Seluruh riwayat sesi disimpan secara lokal di perangkat Anda untuk mencegah kehilangan progres kerja maupun saldo kredit.
      </div>
    </div>
  </div>
{/if}

<!-- ======================================================================= -->
<!-- MODAL TOP-UP QRIS (HTTP 402 TRIGGER / MANUAL TOP-UP)                    -->
<!-- ======================================================================= -->
{#if showTopupModal}
  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="topup-modal-title"
      class="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-stone-200 p-6 sm:p-8 space-y-6 text-center"
    >
      <div class="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-700 flex items-center justify-center mx-auto">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
      </div>

      <div>
        <span class="text-[11px] font-bold uppercase tracking-wider text-indigo-600">
          Isi Ulang Dompet Evaluasi
        </span>
        <h3 id="topup-modal-title" class="text-xl font-extrabold text-[#0F172A] mt-1">
          Rp 25.000 untuk +{TOPUP_PACKAGE.credits} Kredit
        </h3>
        <p class="text-xs font-medium text-slate-500 mt-1">
          Setara Rp 166 / tugas mahasiswa • Masa aktif selamanya (tidak hangus)
        </p>
        {#if topupReason}
          <p class="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 mt-3 font-semibold">
            {topupReason}
          </p>
        {/if}
      </div>

      <!-- Simulasi Kode QRIS -->
      <div class="p-5 rounded-2xl bg-[#FAF8F5] border border-stone-200 mx-auto max-w-[230px] space-y-2.5">
        <div class="text-[11px] font-extrabold uppercase tracking-widest text-slate-500">
          QRIS Standar Nasional
        </div>
        <div class="w-40 h-40 mx-auto bg-white border-2 border-[#0F172A] rounded-xl grid grid-cols-5 grid-rows-5 p-2.5 gap-1">
          {#each Array(25) as _, i}
            <div
              class="rounded-xs {i % 2 === 0 || i % 7 === 0
                ? 'bg-[#0F172A]'
                : 'bg-stone-100'}"
            ></div>
          {/each}
        </div>
        <div class="text-base font-extrabold font-mono tabular-nums text-[#0F172A]">
          Rp 25.000
        </div>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="button"
          on:click={() => (showTopupModal = false)}
          class="min-h-[44px] flex-1 py-2.5 rounded-xl border border-stone-300 text-xs font-bold text-slate-700 hover:bg-stone-50 transition"
        >
          Batal
        </button>
        <button
          type="button"
          on:click={confirmQrisTopup}
          class="min-h-[44px] flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition active:scale-[0.98]"
        >
          Simulasikan Bayar (+{TOPUP_PACKAGE.credits} Kredit)
        </button>
      </div>
    </div>
  </div>
{/if}

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
        'Menjelaskan trade-off latency, kompleksitas DevOps, dan skalabilitas.'
    },
    {
      name: 'Studi Kasus & Relevansi',
      weightPercentage: 30,
      description:
        'Memberikan contoh riil skenario kapan harus migrasi ke microservices.'
    },
    {
      name: 'Referensi & Sitasi',
      weightPercentage: 20,
      description:
        'Minimal 3 referensi akademik atau standar industri yang valid.'
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

  // --- Step 1: Setup Tugas & Rubrik ---
  let sessionTitle = 'UAS Rekayasa Perangkat Lunak - Kelas TI-4A';
  let assignmentContext =
    'Mata Kuliah: Rekayasa Perangkat Lunak\nTugas: Buat esai analisis perbandingan arsitektur Monolitik vs Microservices beserta studi kasus penerapannya. Wajib sertakan minimal 3 referensi akademik/industri.';
  let selectedTone: GradingTone = 'Balanced';
  let rubricCriteria: RubricCriterion[] = structuredClone(DEFAULT_CRITERIA);

  // --- Step 2: Bulk Upload & Similarity Matrix ---
  let isDragging = false;
  let isParsing = false;
  let extractedDocuments: ExtractedDocument[] = [];
  let similarityResults: SimilarityRecord[] = [];
  let similarityThreshold = 0.8;

  // --- Step 3: Kalibrasi 3 Sampel & Eksekusi ---
  let calibrationRunsUsed = 0;
  let calibrationNotes = '';
  let isCalibrating = false;
  let isExecutingBatch = false;
  let calibrationSamples: CalibrationSampleItem[] = [];
  let remainingDocsAfterSample: ExtractedDocument[] = [];
  let lastRefundedCredits = 0;

  // --- Step 4: Eksekusi Batch, Review, Extracted Text Viewer & Export ---
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
    statusNotice = 'Sesi penilaian baru telah dibuat.';
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
      '🧹 Seluruh teks mentah dokumen mahasiswa telah dihapus secara permanen dari sesi ini. Nilai akhir, rincian skor rubrik, dan feedback tetap tersimpan aman.';
  }

  $: totalWeight = rubricCriteria.reduce(
    (sum, item) => sum + (Number(item.weightPercentage) || 0),
    0
  );
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
        weightPercentage: Math.max(0, 100 - totalWeight),
        description: ''
      }
    ];
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

  $: bypassedDocCount = extractedDocuments.filter(
    (doc) => doc.wordCount < 20
  ).length;
  $: activeLlmDocCount = Math.max(
    0,
    extractedDocuments.length - bypassedDocCount
  );
  $: estimatedBatchSeconds =
    activeLlmDocCount === 0
      ? 1
      : Math.max(2, Math.ceil(activeLlmDocCount / 5) * 3);

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
      statusNotice = `Berhasil memuat ${data.summary.totalDocuments} dokumen sampel (${data.summary.flaggedSimilarityCount} terdeteksi indikasi plagiasi lintas mahasiswa).`;
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
            assignmentContext,
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
      statusNotice = `Kalibrasi ${calibrationSamples.length} sampel selesai. Kuota kalibrasi gratis terpakai: ${calibrationRunsUsed}/${MAX_FREE_CALIBRATION_RUNS}.`;
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
            assignmentContext,
            rubricCriteria,
            tone: selectedTone,
            calibrationNotes
          },
          creditBalance,
          concurrency: 5,
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
        statusNotice = `Penilaian batch selesai! ${data.batchSummary.completedCount} dokumen berhasil dinilai, dan +${lastRefundedCredits} Kredit otomatis di-refund karena ${lastRefundedCredits} dokumen membutuhkan tinjauan manual.`;
      } else {
        statusNotice = `Penilaian batch selesai! ${data.batchSummary.completedCount} dokumen berhasil dinilai (${data.creditSummary.deducted} kredit terpakai).`;
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
    selectedResultForModal = updatedItem;
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
    statusNotice = `Top-up QRIS berhasil! +${TOPUP_PACKAGE.credits} Kredit telah ditambahkan ke saldo Anda.`;
  }
</script>

<div class="min-h-screen flex flex-col bg-slate-50 text-slate-900">
  <!-- Top Navigation & Credit Wallet Header -->
  <header class="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
          R
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-bold tracking-tight text-slate-900">Rubrika</h1>
            <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
              v1.0
            </span>
          </div>
          <p class="text-xs text-slate-500 hidden md:block">
            High-Throughput Academic Assessment & Plagiarism Control
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2 sm:gap-3">
        <!-- Fitur #3: Tombol Riwayat Sesi Penilaian -->
        <button
          type="button"
          on:click={() => (showSessionDrawer = true)}
          class="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 transition flex items-center gap-1.5"
        >
          <span>🗂️ Riwayat Sesi ({savedSessions.length})</span>
        </button>

        <button
          type="button"
          on:click={() => (showApiKeyInput = !showApiKeyInput)}
          class="text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 transition hidden sm:inline-flex"
        >
          {customApiKey ? '🔑 API Key Aktif' : '⚙️ API Key'}
        </button>

        <!-- Indikator Saldo Dompet Kredit -->
        <div class="flex items-center gap-2 bg-slate-100 border border-slate-200 rounded-xl px-3.5 py-1.5">
          <div class="text-right">
            <span class="block text-[10px] uppercase tracking-wider font-semibold text-slate-500">
              Saldo Kredit
            </span>
            <span class="text-sm font-bold text-slate-900">
              {creditBalance} <span class="font-normal text-xs text-slate-600">Kredit</span>
            </span>
          </div>
          <button
            type="button"
            on:click={() => {
              topupReason = '';
              showTopupModal = true;
            }}
            class="ml-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition"
          >
            + Top-Up QRIS
          </button>
        </div>
      </div>
    </div>

    <!-- Fitur #6: Banner Jaminan Privasi Akademik -->
    <div class="bg-slate-900/95 text-slate-200 px-4 py-1.5 text-[11px] border-b border-slate-800">
      <div class="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <span>
          🔒 <strong>Privasi Akademik Terjamin:</strong> Teks dokumen diproses secara terisolasi, tidak digunakan untuk melatih AI publik, dan dapat dihapus kapan saja.
        </span>
        <span class="text-emerald-400 font-medium">
          ✓ Auto-Save Sesi Aktif (Tahan Refresh F5)
        </span>
      </div>
    </div>

    {#if showApiKeyInput}
      <div class="bg-slate-900 text-white px-4 py-3 border-b border-slate-800">
        <div class="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <p class="text-xs text-slate-300">
            Masukkan <strong>Google Gemini API Key</strong> jika belum dikonfigurasi di file <code>.env</code> server:
          </p>
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="password"
              bind:value={customApiKey}
              placeholder="AIzaSy..."
              class="w-full sm:w-80 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white focus:outline-none focus:border-indigo-400"
            />
            <button
              type="button"
              on:click={() => (showApiKeyInput = false)}
              class="px-3 py-1.5 rounded-lg bg-indigo-600 text-xs font-semibold hover:bg-indigo-500"
            >
              Simpan
            </button>
          </div>
        </div>
      </div>
    {/if}
  </header>

  <!-- Main Workspace -->
  <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- Stepper Navigation -->
    <nav aria-label="Progress" class="mb-8">
      <ol class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        {#each [
          { step: 1, title: '1. Setup Tugas & Rubrik', desc: 'Konteks soal, bobot & tone' },
          { step: 2, title: '2. Bulk Upload', desc: 'PDF/DOCX/ZIP & Cek Plagiasi Lokal' },
          { step: 3, title: '3. Kalibrasi 3 Sampel', desc: 'Dry-run & Revisi Instruksi Dosen' },
          { step: 4, title: '4. Review & Export', desc: 'Edit Nilai, Baca Teks & Unduh CSV' }
        ] as item}
          <li>
            <button
              type="button"
              on:click={() => {
                if (item.step === 1) currentStep = 1;
                else if (item.step === 2 && isStep1Valid) currentStep = 2;
                else if (item.step === 3 && extractedDocuments.length > 0) currentStep = 3;
                else if (item.step === 4 && batchResults.length > 0) currentStep = 4;
              }}
              class="w-full text-left p-4 rounded-xl border transition {currentStep === item.step
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : currentStep > item.step
                  ? 'bg-white text-slate-900 border-indigo-200 hover:border-indigo-400'
                  : 'bg-white/60 text-slate-400 border-slate-200 cursor-not-allowed'}"
            >
              <div class="text-xs font-bold uppercase tracking-wider">
                {item.title}
              </div>
              <div
                class="text-xs mt-1 {currentStep === item.step
                  ? 'text-indigo-100'
                  : 'text-slate-500'}"
              >
                {item.desc}
              </div>
            </button>
          </li>
        {/each}
      </ol>
    </nav>

    <!-- Notifications -->
    {#if errorMessage}
      <div class="mb-6 rounded-xl bg-red-50 border border-red-200 p-4 flex items-start justify-between gap-3">
        <div class="text-sm text-red-800">
          <strong class="font-semibold">Perhatian:</strong> {errorMessage}
        </div>
        <button
          type="button"
          on:click={() => (errorMessage = '')}
          class="text-xs text-red-600 hover:underline font-medium"
        >
          Tutup
        </button>
      </div>
    {/if}

    {#if statusNotice}
      <div class="mb-6 rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-start justify-between gap-3">
        <div class="text-sm text-emerald-800">
          {statusNotice}
        </div>
        <button
          type="button"
          on:click={() => (statusNotice = '')}
          class="text-xs text-emerald-700 hover:underline font-medium"
        >
          Tutup
        </button>
      </div>
    {/if}

    <!-- STEP 1: SETUP TUGAS & RUBRIK -->
    {#if currentStep === 1}
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-8">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 class="text-xl font-bold text-slate-900">Langkah 1: Konfigurasi Tugas & Rubrik Terbobot</h2>
            <p class="text-sm text-slate-500 mt-1">
              Tentukan konteks soal, kriteria penilaian dengan total bobot 100%, serta gaya penilaian dosen.
            </p>
          </div>
          <button
            type="button"
            on:click={createNewGradingSession}
            class="px-3.5 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            + Buat Sesi Baru
          </button>
        </div>

        <div class="grid grid-cols-1 gap-6">
          <div>
            <label for="session-title" class="block text-sm font-semibold text-slate-700 mb-1.5">
              Judul Sesi Penilaian
            </label>
            <input
              id="session-title"
              type="text"
              bind:value={sessionTitle}
              placeholder="Contoh: UAS Sistem Informasi - Kelas A"
              class="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-indigo-600 focus:outline-none"
            />
          </div>

          <div>
            <label for="assignment-context" class="block text-sm font-semibold text-slate-700 mb-1.5">
              Konteks Tugas / Soal
            </label>
            <textarea
              id="assignment-context"
              rows="4"
              bind:value={assignmentContext}
              placeholder="Masukkan deskripsi soal, instruksi tugas, dan ekspektasi jawaban mahasiswa..."
              class="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-indigo-600 focus:outline-none"
            ></textarea>
          </div>
        </div>

        <!-- Rubrik Penilaian Dinamis -->
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold text-slate-800 uppercase tracking-wider">
                Daftar Kriteria Rubrik
              </h3>
              <p class="text-xs text-slate-500">
                Total bobot seluruh kriteria wajib tepat 100%.
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span
                class="text-xs font-bold px-3 py-1 rounded-full border {totalWeight === 100
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-300'}"
              >
                Total Bobot: {totalWeight}% {totalWeight === 100 ? '✓ Valid' : '(Harus 100%)'}
              </span>
              <button
                type="button"
                on:click={addCriterion}
                class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition"
              >
                + Tambah Kriteria
              </button>
            </div>
          </div>

          <div class="space-y-3">
            {#each rubricCriteria as criterion, idx}
              <div class="grid grid-cols-1 sm:grid-cols-12 gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200 items-start">
                <div class="sm:col-span-4">
                  <label
                    for="crit-name-{idx}"
                    class="block text-xs font-medium text-slate-600 mb-1"
                  >
                    Nama Kriteria #{idx + 1}
                  </label>
                  <input
                    id="crit-name-{idx}"
                    type="text"
                    bind:value={criterion.name}
                    placeholder="Contoh: Ketepatan Analisis"
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none"
                  />
                </div>
                <div class="sm:col-span-2">
                  <label
                    for="crit-weight-{idx}"
                    class="block text-xs font-medium text-slate-600 mb-1"
                  >
                    Bobot (%)
                  </label>
                  <input
                    id="crit-weight-{idx}"
                    type="number"
                    min="1"
                    max="100"
                    bind:value={criterion.weightPercentage}
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold focus:border-indigo-600 focus:outline-none"
                  />
                </div>
                <div class="sm:col-span-5">
                  <label
                    for="crit-desc-{idx}"
                    class="block text-xs font-medium text-slate-600 mb-1"
                  >
                    Deskripsi Indikator Penilaian
                  </label>
                  <input
                    id="crit-desc-{idx}"
                    type="text"
                    bind:value={criterion.description}
                    placeholder="Indikator pencapaian skor penuh..."
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-600 focus:outline-none"
                  />
                </div>
                <div class="sm:col-span-1 flex sm:justify-end pt-5">
                  <button
                    type="button"
                    disabled={rubricCriteria.length <= 1}
                    on:click={() => removeCriterion(idx)}
                    class="px-2.5 py-2 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-30"
                    title="Hapus kriteria"
                  >
                    Hapus
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </div>

        <!-- Tone Penilaian Dosen -->
        <div class="space-y-3">
          <h3 class="text-sm font-bold text-slate-800 uppercase tracking-wider">
            Gaya / Tone Penilaian Dosen
          </h3>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {#each [
              {
                id: 'Lenient',
                label: 'Santai / Murah Hati (Lenient)',
                desc: 'Apresiatif & toleran terhadap kesalahan minor. Rentang nilai umum 80–95 selama menjawab esensi soal.'
              },
              {
                id: 'Balanced',
                label: 'Standar Objektif (Balanced)',
                desc: 'Berimbang sesuai rubrik. Rentang umum 65–85, nilai 90+ untuk jawaban yang melampaui ekspektasi.'
              },
              {
                id: 'Rigorous',
                label: 'Kritis / Ketat (Rigorous)',
                desc: 'Standar tinggi setara publikasi/industri. Cermati celah logika, data tanpa sumber, dan penjelasan dangkal.'
              }
            ] as toneOption}
              <button
                type="button"
                on:click={() => (selectedTone = toneOption.id as GradingTone)}
                class="text-left p-4 rounded-xl border-2 transition {selectedTone === toneOption.id
                  ? 'border-indigo-600 bg-indigo-50/60'
                  : 'border-slate-200 hover:border-slate-300 bg-white'}"
              >
                <div class="font-bold text-sm text-slate-900">
                  {toneOption.label}
                </div>
                <p class="text-xs text-slate-600 mt-1 leading-relaxed">
                  {toneOption.desc}
                </p>
              </button>
            {/each}
          </div>
        </div>

        <div class="pt-4 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            disabled={!isStep1Valid}
            on:click={() => (currentStep = 2)}
            class="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white text-sm font-semibold shadow-sm transition"
          >
            Lanjut ke Langkah 2: Bulk Upload →
          </button>
        </div>
      </div>
    {/if}

    <!-- STEP 2: BULK UPLOAD & LOCAL SIMILARITY -->
    {#if currentStep === 2}
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 class="text-xl font-bold text-slate-900">
              Langkah 2: Bulk Upload & Deteksi Kemiripan Lokal (0 Token Cost)
            </h2>
            <p class="text-sm text-slate-500 mt-1">
              Unggah banyak file <code>.pdf</code>, <code>.docx</code>, <code>.txt</code> sekaligus atau 1 bundel arsip <code>.zip</code>.
            </p>
          </div>
          <button
            type="button"
            disabled={isParsing}
            on:click={loadDemoDocuments}
            class="px-4 py-2 rounded-xl border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition"
          >
            ⚡ Muat 4 Dokumen Sampel Demo
          </button>
        </div>

        <!-- Drag and Drop Zone -->
        <label
          on:dragover|preventDefault={() => (isDragging = true)}
          on:dragleave={() => (isDragging = false)}
          on:drop|preventDefault={(e) => {
            isDragging = false;
            if (e.dataTransfer?.files) {
              handleFileUpload(e.dataTransfer.files);
            }
          }}
          class="flex flex-col items-center justify-center border-2 border-dashed rounded-2xl p-10 cursor-pointer transition {isDragging
            ? 'border-indigo-600 bg-indigo-50'
            : 'border-slate-300 hover:border-indigo-400 bg-slate-50/70'}"
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
          <div class="w-12 h-12 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xl mb-3">
            ↑
          </div>
          <p class="text-sm font-semibold text-slate-800">
            {isParsing
              ? 'Sedang mengekstrak teks & menghitung matriks TF-IDF Cosine Similarity...'
              : 'Klik untuk memilih file atau tarik (Drag & Drop) ke area ini'}
          </p>
          <p class="text-xs text-slate-500 mt-1">
            Mendukung multi-file .PDF, .DOCX, .TXT, atau arsip kelas .ZIP (maks 100 file, 5 MB/file)
          </p>
        </label>

        {#if extractedDocuments.length > 0}
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-bold text-slate-800">
                Hasil Ekstraksi & Pengecekan Kemiripan Lokal ({extractedDocuments.length} Dokumen)
              </h3>
              <span class="text-xs text-slate-500">
                Threshold Kemiripan: {Math.round(similarityThreshold * 100)}%
              </span>
            </div>

            <div class="overflow-x-auto rounded-xl border border-slate-200">
              <table class="min-w-full divide-y divide-slate-200 text-sm">
                <thead class="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                  <tr>
                    <th class="px-4 py-3 text-left">No</th>
                    <th class="px-4 py-3 text-left">Nama File</th>
                    <th class="px-4 py-3 text-left">Tipe</th>
                    <th class="px-4 py-3 text-left">Jumlah Kata</th>
                    <th class="px-4 py-3 text-left">Skor Kemiripan Lokal</th>
                    <th class="px-4 py-3 text-left">Mirip Dengan</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 bg-white">
                  {#each extractedDocuments as doc, idx}
                    {@const sim = getSimilarityForDoc(doc)}
                    <tr>
                      <td class="px-4 py-3 text-slate-500">{idx + 1}</td>
                      <td class="px-4 py-3 font-medium text-slate-900">
                        {doc.originalFilename}
                        {#if doc.parseError}
                          <span class="block text-xs text-red-600 mt-0.5">
                            ⚠️ {doc.parseError}
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-3 uppercase text-xs font-semibold text-slate-500">
                        {doc.fileType}
                      </td>
                      <td class="px-4 py-3 text-slate-700">
                        {doc.wordCount} kata
                        {#if doc.wordCount < 20}
                          <span class="block text-[11px] font-semibold text-amber-700 mt-0.5">
                            ⚡ Auto-Bypass API (&lt; 20 kata • 0 Token)
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-3">
                        {#if sim.similarity_flagged}
                          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-800 border border-red-200">
                            🚨 {Math.round(sim.max_similarity_score * 100)}% (Terindikasi Plagiasi)
                          </span>
                        {:else}
                          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {Math.round(sim.max_similarity_score * 100)}% (Aman)
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-3 text-xs text-slate-600">
                        {sim.closest_match_file ?? '-'}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}

        <div class="pt-4 border-t border-slate-200 flex items-center justify-between">
          <button
            type="button"
            on:click={() => (currentStep = 1)}
            class="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
          >
            ← Kembali ke Setup Rubrik
          </button>
          <button
            type="button"
            disabled={extractedDocuments.length === 0}
            on:click={() => (currentStep = 3)}
            class="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white text-sm font-semibold shadow-sm transition"
          >
            Lanjut ke Langkah 3: Kalibrasi 3 Sampel →
          </button>
        </div>
      </div>
    {/if}

    <!-- STEP 3: KALIBRASI 3 SAMPEL & EKSEKUSI -->
    {#if currentStep === 3}
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 class="text-xl font-bold text-slate-900">
              Langkah 3: Kalibrasi 3 Sampel Pertama & Revisi Instruksi Dosen
            </h2>
            <p class="text-sm text-slate-500 mt-1">
              Uji penilaian pada maksimal 3 sampel pertama secara gratis sebelum memproses seluruh kelas.
            </p>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200">
              Jatah Kalibrasi Gratis: {MAX_FREE_CALIBRATION_RUNS - calibrationRunsUsed} / {MAX_FREE_CALIBRATION_RUNS} tersisa
            </span>
            <button
              type="button"
              disabled={isCalibrating || isExecutingBatch || calibrationRunsUsed >= MAX_FREE_CALIBRATION_RUNS}
              on:click={triggerCalibrationSample}
              class="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold transition"
            >
              {isCalibrating
                ? 'Menilai 3 Sampel...'
                : calibrationSamples.length > 0
                  ? '🔄 Uji Ulang 3 Sampel'
                  : '▶️ Jalankan Uji 3 Sampel (Gratis)'}
            </button>
          </div>
        </div>

        <!-- Ringkasan Estimasi Waktu Proses & Auto-Bypass -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <div>
            <span class="text-slate-500 block">Total Antrean Batch</span>
            <strong class="text-sm text-slate-900">{extractedDocuments.length} Dokumen (5x Paralel)</strong>
          </div>
          <div>
            <span class="text-slate-500 block">Estimasi Waktu Proses</span>
            <strong class="text-sm text-indigo-700">~{estimatedBatchSeconds} detik</strong>
          </div>
          <div>
            <span class="text-slate-500 block">Pre-Filter &lt; 20 Kata (Auto-Bypass)</span>
            <strong class="text-sm text-amber-700">
              {bypassedDocCount} Dokumen (Hemat Token API)
            </strong>
          </div>
        </div>

        <!-- Catatan Kalibrasi / Revisi Dosen -->
        <div class="p-5 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
          <label for="calibration-notes" class="block text-sm font-bold text-amber-950">
            Revisi Instruksi / Catatan Kalibrasi Dosen (Opsional)
          </label>
          <p class="text-xs text-amber-800">
            Jika hasil 3 sampel di bawah dirasa terlalu pelit atau terlalu longgar, tambahkan instruksi koreksi spesifik di sini. Instruksi ini akan langsung diterapkan secara seragam ke seluruh dokumen.
          </p>
          <textarea
            id="calibration-notes"
            rows="3"
            bind:value={calibrationNotes}
            placeholder="Contoh: Jika mahasiswa sudah mencantumkan minimal 2 referensi buku/tokoh kredibel (meski kurang dari 3), beri nilai minimal 65 pada kriteria referensi."
            class="w-full rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-sm focus:border-indigo-600 focus:outline-none"
          ></textarea>
        </div>

        <!-- Hasil 3 Sampel Kalibrasi -->
        {#if calibrationSamples.length > 0}
          <div class="space-y-4">
            <h3 class="text-sm font-bold text-slate-800 uppercase tracking-wider">
              Hasil Evaluasi 3 Sampel Kalibrasi
            </h3>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {#each calibrationSamples as sample}
                <div class="rounded-xl border border-slate-200 bg-slate-50/60 p-4 flex flex-col justify-between space-y-4">
                  <div class="space-y-3">
                    <div class="flex items-start justify-between gap-2 border-b border-slate-200 pb-3">
                      <div>
                        <div class="text-sm font-bold text-slate-900">
                          {sample.evaluation?.student_identity.extracted_name ?? 'Gagal Ekstrak'}
                        </div>
                        <div class="text-xs text-slate-500">
                          NIM: {sample.evaluation?.student_identity.extracted_id ?? '-'} • {sample.filename}
                        </div>
                      </div>
                      {#if sample.evaluation}
                        <div class="text-right">
                          <span class="text-lg font-extrabold text-indigo-700">
                            {sample.evaluation.final_weighted_score}
                          </span>
                          <span class="block text-[10px] font-semibold uppercase text-slate-500">
                            AI: {sample.evaluation.ai_writing_suspicion}
                          </span>
                        </div>
                      {/if}
                    </div>

                    {#if sample.evaluation}
                      <div class="space-y-2">
                        {#each sample.evaluation.grading_breakdown as b}
                          <div class="bg-white p-2.5 rounded-lg border border-slate-200 text-xs">
                            <div class="flex justify-between font-semibold text-slate-800">
                              <span>{b.criterion_name} ({b.weight_percentage}%)</span>
                              <span class="text-indigo-600">{b.score_given}/100</span>
                            </div>
                            <p class="text-slate-600 mt-1">{b.short_reasoning}</p>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <p class="text-xs text-red-600">
                        {sample.error_message || 'Membutuhkan tinjauan manual.'}
                      </p>
                    {/if}
                  </div>

                  {#if sample.evaluation}
                    <div class="pt-2 border-t border-slate-200 text-xs text-slate-700">
                      <strong class="font-semibold">Feedback Mahasiswa:</strong>
                      <p class="mt-0.5 italic">"{sample.evaluation.feedback_for_student}"</p>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="pt-4 border-t border-slate-200 flex items-center justify-between">
          <button
            type="button"
            on:click={() => (currentStep = 2)}
            class="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
          >
            ← Kembali ke Upload
          </button>

          <button
            type="button"
            disabled={isExecutingBatch || isCalibrating}
            on:click={executeRemainingOrFullBatch}
            class="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-sm font-semibold shadow-sm transition"
          >
            {isExecutingBatch
              ? `Memproses ${extractedDocuments.length} Dokumen (~${estimatedBatchSeconds}s)...`
              : `🚀 Proses Semua Dokumen (${extractedDocuments.length} Kredit)`}
          </button>
        </div>
      </div>
    {/if}

    <!-- STEP 4: REVIEW, SIDE-BY-SIDE VIEWER, DATA PURGE & EXPORT -->
    {#if currentStep === 4}
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2.5 flex-wrap">
              <h2 class="text-xl font-bold text-slate-900">
                Langkah 4: Review Nilai, Baca Teks Asli & Export Gradebook
              </h2>
              {#if lastRefundedCredits > 0}
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  💸 Auto-Refund +{lastRefundedCredits} Kredit (Dokumen Gagal API)
                </span>
              {/if}
              {#if rawTextPurged}
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  🔒 Teks Mentah Telah Dibersihkan
                </span>
              {/if}
            </div>
            <p class="text-sm text-slate-500 mt-1">
              Klik nilai akhir untuk edit langsung, buka <strong>Teks Asli / Bandingkan Kemiripan</strong>, atau unduh rekap nilai.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2.5">
            <!-- Fitur #6: Tombol Bersihkan Teks Mentah Dokumen (Data Purge) -->
            <button
              type="button"
              disabled={rawTextPurged}
              on:click={handlePurgeRawText}
              class="px-3.5 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40 transition"
              title="Hapus seluruh teks mentah dokumen dari penyimpanan lokal dan hanya simpan nilai & feedback"
            >
              {rawTextPurged
                ? '✓ Teks Mentah Dihapus'
                : '🧹 Bersihkan Teks Mentah Dokumen (Hanya Simpan Nilai & Feedback)'}
            </button>

            <button
              type="button"
              on:click={() => (currentStep = 3)}
              class="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50"
            >
              ← Kalibrasi
            </button>
            <button
              type="button"
              disabled={isExporting || batchResults.length === 0}
              on:click={downloadGradebookCSV}
              class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white text-xs font-semibold shadow-sm transition"
            >
              {isExporting ? 'Menyiapkan File...' : '📥 Export ke Excel / CSV'}
            </button>
          </div>
        </div>

        <div class="overflow-x-auto rounded-xl border border-slate-200">
          <table class="min-w-full divide-y divide-slate-200 text-sm">
            <thead class="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th class="px-4 py-3 text-left">No</th>
                <th class="px-4 py-3 text-left">Mahasiswa & NIM</th>
                <th class="px-4 py-3 text-left">Nama File</th>
                <th class="px-4 py-3 text-left">Cek Kemiripan</th>
                <th class="px-4 py-3 text-left">Indikasi AI</th>
                <th class="px-4 py-3 text-left">Nilai Akhir (Inline Edit)</th>
                <th class="px-4 py-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200 bg-white">
              {#each batchResults as item, idx}
                <tr class="hover:bg-slate-50/80">
                  <td class="px-4 py-3 text-slate-500">{idx + 1}</td>
                  <td class="px-4 py-3">
                    <div class="font-semibold text-slate-900">
                      {item.evaluation?.student_identity.extracted_name ?? 'Tidak Tertera'}
                    </div>
                    <div class="text-xs text-slate-500">
                      NIM: {item.evaluation?.student_identity.extracted_id ?? 'Tidak Tertera'}
                    </div>
                  </td>
                  <td class="px-4 py-3 text-xs text-slate-700">
                    {item.filename}
                    {#if item.status === 'MANUAL_REVIEW_REQUIRED'}
                      <span class="block text-[11px] font-semibold text-amber-700 mt-0.5">
                        ⚠️ MANUAL_REVIEW_REQUIRED (Kredit Di-refund)
                      </span>
                    {:else if item.evaluation?.grading_breakdown?.[0]?.short_reasoning?.includes('Tidak memotong token API')}
                      <span class="block text-[11px] font-semibold text-slate-500 mt-0.5">
                        ⚡ Auto-Bypass (&lt; 20 kata)
                      </span>
                    {/if}
                  </td>
                  <td class="px-4 py-3">
                    {#if item.integrity_check.similarity_flagged}
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'side_by_side')}
                        class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-800 border border-red-300 hover:bg-red-200 transition"
                        title="Klik untuk membandingkan teks berdampingan"
                      >
                        🚨 Mirip {Math.round(item.integrity_check.max_similarity_score * 100)}% • Bandingkan
                      </button>
                      {#if item.integrity_check.closest_match_file}
                        <span class="block text-[11px] text-red-700 mt-0.5">
                          vs {item.integrity_check.closest_match_file}
                        </span>
                      {/if}
                    {:else}
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Aman ({Math.round(item.integrity_check.max_similarity_score * 100)}%)
                      </span>
                    {/if}
                  </td>
                  <td class="px-4 py-3">
                    {#if item.evaluation}
                      <span
                        class="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold {item.evaluation
                          .ai_writing_suspicion === 'High'
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : item.evaluation.ai_writing_suspicion === 'Medium'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : 'bg-slate-100 text-slate-700'}"
                      >
                        {item.evaluation.ai_writing_suspicion}
                      </span>
                    {:else}
                      <span class="text-xs text-slate-400">-</span>
                    {/if}
                  </td>
                  <td class="px-4 py-3">
                    {#if item.evaluation}
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        max="100"
                        value={item.evaluation.final_weighted_score}
                        on:change={(e) =>
                          handleInlineFinalScoreChange(idx, e.currentTarget.value)}
                        class="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-indigo-700 focus:border-indigo-600 focus:outline-none"
                      />
                    {:else}
                      <button
                        type="button"
                        on:click={() => openDetailModal(item, idx, 'extracted_text')}
                        class="text-xs text-amber-700 hover:underline font-semibold"
                      >
                        ✍️ Beri Nilai Manual
                      </button>
                    {/if}
                  </td>
                  <td class="px-4 py-3 text-right space-x-1.5">
                    <button
                      type="button"
                      on:click={() => openDetailModal(item, idx, 'extracted_text')}
                      class="px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700"
                    >
                      📄 Teks Asli
                    </button>
                    <button
                      type="button"
                      on:click={() => openDetailModal(item, idx, 'grading')}
                      class="px-3 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-xs font-semibold text-indigo-700"
                    >
                      Detail & Feedback
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </main>
</div>

<!-- FITUR #2: MODAL DETAIL REASONING, LIHAT TEKS ASLI & SIDE-BY-SIDE SIMILARITY VIEWER -->
{#if selectedResultForModal}
  {@const currentDocText = getExtractedTextByFilename(
    selectedResultForModal.filename,
    selectedResultForModal.document_id
  )}
  {@const closestMatchFilename =
    selectedResultForModal.integrity_check.closest_match_file}
  {@const comparisonDocText = getExtractedTextByFilename(closestMatchFilename)}

  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-xl border border-slate-200 p-6 space-y-5">
      <div class="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h3 class="text-lg font-bold text-slate-900">
            {selectedResultForModal.evaluation?.student_identity.extracted_name ??
              selectedResultForModal.filename}
          </h3>
          <p class="text-xs text-slate-500">
            NIM: {selectedResultForModal.evaluation?.student_identity.extracted_id ?? 'Tidak Tertera'} • File: {selectedResultForModal.filename}
          </p>
        </div>
        <button
          type="button"
          on:click={closeDetailModal}
          class="text-sm font-semibold text-slate-500 hover:text-slate-800"
        >
          ✕ Tutup
        </button>
      </div>

      <!-- Tab Navigation di dalam Modal -->
      <div class="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        <button
          type="button"
          on:click={() => (activeModalTab = 'grading')}
          class="px-3.5 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
          'grading'
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}"
        >
          📊 Rincian Nilai & Feedback
        </button>
        <button
          type="button"
          on:click={() => (activeModalTab = 'extracted_text')}
          class="px-3.5 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
          'extracted_text'
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}"
        >
          📄 Lihat Teks Dokumen Asli (Extracted Text)
        </button>
        {#if closestMatchFilename}
          <button
            type="button"
            on:click={() => (activeModalTab = 'side_by_side')}
            class="px-3.5 py-2 rounded-xl text-xs font-bold transition {activeModalTab ===
            'side_by_side'
              ? 'bg-red-600 text-white'
              : 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'}"
          >
            🔍 Bandingkan Teks Berdampingan ({Math.round(
              selectedResultForModal.integrity_check.max_similarity_score * 100
            )}% Mirip)
          </button>
        {/if}
      </div>

      <!-- TAB 1: RINCIAN NILAI & FEEDBACK -->
      {#if activeModalTab === 'grading'}
        {#if selectedResultForModal.evaluation}
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-bold uppercase tracking-wider text-slate-600">
                Rincian Skor Per Kriteria (Dapat Diedit)
              </h4>
              <span class="text-sm font-extrabold text-indigo-700">
                Nilai Akhir Terbobot: {selectedResultForModal.evaluation.final_weighted_score}
              </span>
            </div>

            {#each selectedResultForModal.evaluation.grading_breakdown as crit, cIdx}
              <div class="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-bold text-slate-800">
                    {crit.criterion_name} ({crit.weight_percentage}%)
                  </span>
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs text-slate-500">Skor:</span>
                    <input
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
                      class="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-indigo-700"
                    />
                  </div>
                </div>
                <p class="text-xs text-slate-600 leading-relaxed">
                  {crit.short_reasoning}
                </p>
              </div>
            {/each}
          </div>

          <div class="space-y-1.5">
            <label for="modal-feedback" class="block text-xs font-bold uppercase tracking-wider text-slate-600">
              Feedback Konstruktif Untuk Mahasiswa
            </label>
            <textarea
              id="modal-feedback"
              rows="3"
              bind:value={selectedResultForModal.evaluation.feedback_for_student}
              on:input={() => (batchResults = [...batchResults])}
              class="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm text-slate-800 focus:border-indigo-600 focus:outline-none"
            ></textarea>
          </div>
        {:else}
          <div class="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-4">
            <div class="text-sm text-amber-900">
              Dokumen ini berstatus <strong>MANUAL_REVIEW_REQUIRED</strong>:
              <p class="mt-1 text-xs">{selectedResultForModal.error_message}</p>
            </div>

            <div class="border-t border-amber-200 pt-4 space-y-3">
              <h4 class="text-xs font-bold uppercase tracking-wider text-amber-950">
                ✍️ Input Penilaian Manual Dosen
              </h4>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label for="manual-name" class="block text-xs font-medium text-slate-700 mb-1">
                    Nama Mahasiswa
                  </label>
                  <input
                    id="manual-name"
                    type="text"
                    bind:value={manualStudentNameInput}
                    placeholder="Nama Mahasiswa"
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label for="manual-id" class="block text-xs font-medium text-slate-700 mb-1">
                    NIM / ID
                  </label>
                  <input
                    id="manual-id"
                    type="text"
                    bind:value={manualStudentIdInput}
                    placeholder="NIM Mahasiswa"
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label for="manual-score" class="block text-xs font-medium text-slate-700 mb-1">
                    Nilai Akhir (0-100)
                  </label>
                  <input
                    id="manual-score"
                    type="number"
                    min="0"
                    max="100"
                    bind:value={manualScoreInput}
                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-indigo-700"
                  />
                </div>
              </div>
              <div>
                <label for="manual-feedback-input" class="block text-xs font-medium text-slate-700 mb-1">
                  Feedback Mahasiswa
                </label>
                <textarea
                  id="manual-feedback-input"
                  rows="2"
                  bind:value={manualFeedbackInput}
                  class="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
                ></textarea>
              </div>
              <button
                type="button"
                on:click={saveManualGradingForCurrentModal}
                class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold"
              >
                ✓ Simpan Nilai Manual
              </button>
            </div>
          </div>
        {/if}
      {/if}

      <!-- TAB 2: LIHAT TEKS DOKUMEN ASLI (EXTRACTED TEXT) -->
      {#if activeModalTab === 'extracted_text'}
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold uppercase tracking-wider text-slate-600">
              📄 Isi Teks Dokumen ({selectedResultForModal.filename})
            </span>
            {#if rawTextPurged}
              <span class="text-xs font-semibold text-emerald-700">
                🔒 Teks mentah telah dihapus demi privasi
              </span>
            {/if}
          </div>

          <div class="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs whitespace-pre-wrap max-h-80 overflow-y-auto leading-relaxed">
            {#if rawTextPurged}
              [Teks mentah dokumen telah dibersihkan oleh dosen melalui fitur Data Purge Privasi Akademik.]
            {:else if currentDocText}
              {currentDocText}
            {:else}
              [Tidak ada teks yang dapat ditampilkan dari dokumen ini.]
            {/if}
          </div>

          {#if selectedResultForModal.status === 'MANUAL_REVIEW_REQUIRED'}
            <div class="p-4 rounded-xl bg-indigo-50 border border-indigo-200 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div class="flex-1 space-y-2">
                <span class="block text-xs font-bold text-indigo-950">
                  ✍️ Beri Nilai Langsung Setelah Membaca Teks:
                </span>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    bind:value={manualScoreInput}
                    placeholder="Nilai (0-100)"
                    class="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-bold"
                  />
                  <input
                    type="text"
                    bind:value={manualFeedbackInput}
                    placeholder="Catatan feedback..."
                    class="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs"
                  />
                </div>
              </div>
              <button
                type="button"
                on:click={saveManualGradingForCurrentModal}
                class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shrink-0"
              >
                ✓ Simpan Nilai Manual
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- TAB 3: SIDE-BY-SIDE SIMILARITY VIEWER -->
      {#if activeModalTab === 'side_by_side'}
        <div class="space-y-3">
          <div class="p-3 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between">
            <div class="text-xs text-red-900">
              <strong>🔍 Perbandingan Kemiripan Lintas Dokumen:</strong> Tingkat kemiripan TF-IDF unigram+bigram sebesar <strong>{Math.round(selectedResultForModal.integrity_check.max_similarity_score * 100)}%</strong>.
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <div class="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-lg border border-slate-200">
                📄 Dokumen Mahasiswa Ini: {selectedResultForModal.filename}
              </div>
              <div class="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs whitespace-pre-wrap h-72 overflow-y-auto leading-relaxed">
                {rawTextPurged
                  ? '[Teks mentah telah dihapus (Data Purge).]'
                  : currentDocText || '[Kosong]'}
              </div>
            </div>

            <div class="space-y-1.5">
              <div class="text-xs font-bold text-red-900 bg-red-50 px-3 py-2 rounded-lg border border-red-200">
                📄 Dokumen Pembanding Terdekat: {closestMatchFilename ?? '-'}
              </div>
              <div class="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs whitespace-pre-wrap h-72 overflow-y-auto leading-relaxed">
                {rawTextPurged
                  ? '[Teks mentah telah dihapus (Data Purge).]'
                  : comparisonDocText || '[Tidak ditemukan]'}
              </div>
            </div>
          </div>
        </div>
      {/if}

      <div class="pt-3 border-t border-slate-200 flex justify-end">
        <button
          type="button"
          on:click={closeDetailModal}
          class="px-5 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
        >
          Selesai
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- FITUR #3: MODAL / DRAWER RIWAYAT SESI PENILAIAN (ANTI-REFRESH F5) -->
{#if showSessionDrawer}
  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-end">
    <div class="bg-white h-full max-w-md w-full shadow-2xl border-l border-slate-200 p-6 flex flex-col justify-between">
      <div class="space-y-4 overflow-y-auto pr-1">
        <div class="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <h3 class="text-lg font-bold text-slate-900">🗂️ Riwayat Sesi Penilaian</h3>
            <p class="text-xs text-slate-500">
              Otomatis tersimpan di perangkat Anda (Tahan Refresh F5 / Putus Koneksi).
            </p>
          </div>
          <button
            type="button"
            on:click={() => (showSessionDrawer = false)}
            class="text-sm font-semibold text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <button
          type="button"
          on:click={createNewGradingSession}
          class="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition"
        >
          + Buat Sesi Penilaian Baru
        </button>

        <div class="space-y-2.5">
          {#each savedSessions as sess}
            <div
              class="p-3.5 rounded-xl border transition {sess.id === activeSessionId
                ? 'border-indigo-600 bg-indigo-50/50'
                : 'border-slate-200 bg-white hover:border-slate-300'}"
            >
              <div class="flex items-start justify-between gap-2">
                <button
                  type="button"
                  on:click={() => switchGradingSession(sess.id)}
                  class="text-left flex-1"
                >
                  <div class="text-sm font-bold text-slate-900">
                    {sess.title}
                  </div>
                  <div class="text-[11px] text-slate-500 mt-0.5">
                    Langkah {sess.currentStep}/4 • {sess.extractedDocuments.length} Dokumen • {sess.batchResults.length} Dinilai
                  </div>
                  {#if sess.rawTextPurged}
                    <span class="inline-block mt-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                      🔒 Teks Mentah Dibersihkan
                    </span>
                  {/if}
                </button>
                {#if savedSessions.length > 1}
                  <button
                    type="button"
                    on:click={() => handleRemoveSession(sess.id)}
                    class="text-xs text-red-600 hover:underline px-1.5 py-0.5"
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

      <div class="pt-4 border-t border-slate-200 text-[11px] text-slate-500">
        🔒 Seluruh riwayat sesi disimpan secara lokal di browser Anda untuk mencegah kehilangan progres kerja maupun kredit.
      </div>
    </div>
  </div>
{/if}

<!-- MODAL TOP-UP QRIS -->
{#if showTopupModal}
  <div class="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-200 p-6 space-y-5 text-center">
      <div class="w-12 h-12 rounded-2xl bg-indigo-100 text-indigo-700 font-bold text-xl flex items-center justify-center mx-auto">
        💳
      </div>

      <div>
        <h3 class="text-lg font-bold text-slate-900">{TOPUP_PACKAGE.label}</h3>
        {#if topupReason}
          <p class="text-xs text-red-600 mt-1 font-medium">{topupReason}</p>
        {:else}
          <p class="text-xs text-slate-500 mt-1">
            1 Kredit = 1 Dokumen Tugas Mahasiswa. Kuota tidak hangus.
          </p>
        {/if}
      </div>

      <!-- Simulasi Kode QRIS -->
      <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200 mx-auto max-w-[220px] space-y-2">
        <div class="text-[11px] font-bold uppercase tracking-widest text-slate-500">
          QRIS Nasional
        </div>
        <div class="w-40 h-40 mx-auto bg-white border-2 border-slate-900 rounded-xl grid grid-cols-5 grid-rows-5 p-2 gap-1">
          {#each Array(25) as _, i}
            <div
              class="rounded-xs {i % 2 === 0 || i % 7 === 0
                ? 'bg-slate-900'
                : 'bg-slate-100'}"
            ></div>
          {/each}
        </div>
        <div class="text-sm font-extrabold text-slate-900">Rp 25.000</div>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="button"
          on:click={() => (showTopupModal = false)}
          class="flex-1 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          Batal
        </button>
        <button
          type="button"
          on:click={confirmQrisTopup}
          class="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm"
        >
          ✓ Simulasikan Bayar (+{TOPUP_PACKAGE.credits} Kredit)
        </button>
      </div>
    </div>
  </div>
{/if}

# Rubrika

**High-Throughput AI Assessment & Quality Control Engine**

Rubrika is a deterministic batch-grading pipeline engineered for higher education, technical bootcamps, and vocational training institutions (LPK). It replaces manual, sequential assignment grading with an asynchronous document processing architecture.

By combining local vector-based similarity detection with structured Large Language Model (LLM) evaluation, Rubrika processes bulk document submissions against weighted academic rubrics in minutes while maintaining strict token efficiency and grading consistency.

---

## Architectural Overview

Rubrika decouples text extraction and plagiarism detection from LLM inference to minimize operational costs and latency.

```text
[Ingestion Layer]       Bulk PDF / DOCX / TXT / ZIP Archive Upload
        │
        ▼
[Extraction Engine]     Local raw text parsing & whitespace normalization
        │
        ▼
[Similarity Matrix]     Pairwise TF-IDF (1-gram & 2-gram) & Cosine Similarity (Zero API Cost)
        │
        ▼
[Calibration Gate]      3-Sample dry run (Free) ──► Instructor validation & rubric/note revision
        │
        ▼
[Credit Wallet Guard]   Atomic quota verification (1 Credit = 1 Document) & instant QRIS Top-Up
        │
        ▼
[Inference Queue]       Promise-based concurrent worker pool ──► LLM Structured JSON Evaluation
        │
        ▼
[Export & Persistence]  Deterministic score verification ──► Interactive UI & .CSV / Excel Gradebook
```

---

## End-to-End 4-Step Instructor Workflow

1. **Setup Tugas & Rubrik (Step 1):**
   Configure the assignment context, dynamically add/remove weighted rubric criteria (validated in real-time to total 100%), and select the grading tone (`Lenient`, `Balanced`, or `Rigorous`).
2. **Bulk Upload & Local Similarity Check (Step 2):**
   Drag-and-drop multiple `.pdf`, `.docx`, `.txt` files or a single `.zip` bundle (e.g., exported from Google Classroom or Moodle). Instantly computes pairwise TF-IDF Cosine Similarity at zero API token cost.
3. **3-Sample Calibration & Batch Execution (Step 3):**
   Run a free dry-run calibration on the first 3 documents (up to 2 free calibration runs per session). Review initial AI grading behavior, inject custom instructor calibration notes (`calibrationNotes`), and execute the remaining batch through the concurrent worker pool.
4. **Interactive Review, Inline Editing & Export (Step 4):**
   Inspect results in an interactive table featuring similarity alerts (`≥ 80%`), AI writing suspicion badges (`Low` / `Medium` / `High`), inline score editing with automatic weighted recalculation, detailed per-criterion reasoning modals, and one-click export to Excel-ready `.csv` (UTF-8 with BOM & formula-injection protection).

---

## Core Capabilities

| Module | Technical Implementation | Operational Benefit |
| :--- | :--- | :--- |
| **Batch Ingestion** | Multi-format `.zip`, `.pdf`, `.docx`, and `.txt` parser (`src/lib/parser/`). | Unpacks archives recursively, strips OS artifacts (`__MACOSX`), and normalizes text without failing the batch on corrupt files. |
| **Local Similarity Engine** | In-memory unigram + bigram TF-IDF vectorization and pairwise Cosine Similarity ($S_C$) (`src/lib/similarity/`). | Flags peer-to-peer copy-pasting across a class batch at zero token cost before any LLM call is made. |
| **Sample Calibration** | Evaluates an initial $N=3$ subset before locking batch execution (`runCalibrationSample`). | Allows instructors to fine-tune grading strictness and rubric instructions before consuming document credits. |
| **Deterministic Grading** | Enforces strict JSON Schema (`responseSchema`) & Zod validation (`GradingOutputSchema`) + backend score recalculation (`verifyAndRecalculateScore`). | Guarantees 100% parseable outputs and eliminates LLM floating-point arithmetic hallucinations. |
| **Credit Wallet System** | Built-in quota guard (`src/lib/credits/`) with 30 free initial credits, free calibration gate, and HTTP 402 QRIS top-up trigger. | Frictionless pay-per-document monetization without complex subscription barriers. |
| **Gradebook Compiler** | Automated mapping from evaluated JSON records to UTF-8 BOM `.csv` / Excel buffers (`src/lib/exporter/`). | Generates administrative-ready spreadsheets compatible with Microsoft Excel, university portals, and LMS platforms. |

---

## Mathematical & Scoring Specification

1. **Cross-Submission Similarity:**
   Prior to grading, each extracted document $D_i$ is tokenized (with Indonesian and English stopword removal) into unigram and bigram TF-IDF vectors $\mathbf{v}_i$. Pairwise similarity across a batch of $m$ documents is computed as:
   $$S_C(D_i, D_j) = \frac{\mathbf{v}_i \cdot \mathbf{v}_j}{\|\mathbf{v}_i\| \|\mathbf{v}_j\|}$$
   Submissions exceeding the configurable threshold ($\tau \ge 0.80$) are automatically flagged (`similarity_flagged: true`) along with `closest_match_file`.

2. **Deterministic Weighted Rubric Calculation:**
   For a rubric with $k$ criteria, where each criterion $c$ has a percentage weight $w_c$ ($\sum_{c=1}^{k} w_c = 100$) and an LLM-assigned integer score $s_c \in [0, 100]$, the final grade $G$ is deterministically verified and overridden on the backend:
   $$G = \text{round}\left(\sum_{c=1}^{k} s_c \cdot \frac{w_c}{100},\ 2\right)$$

---

## Deterministic Output Schema

Every evaluated document is strictly validated against `GradingOutputSchema` (`src/lib/grader/schema.ts`) and wrapped into a `BatchDocumentResult`:

```json
{
  "document_id": "doc_01",
  "filename": "UAS_RPL_1122045_Revisi.pdf",
  "status": "COMPLETED",
  "processed_at": "2026-10-16T07:00:00.000Z",
  "integrity_check": {
    "similarity_flagged": false,
    "max_similarity_score": 0.18,
    "closest_match_file": "UAS_RPL_Andi.pdf"
  },
  "evaluation": {
    "student_identity": {
      "extracted_name": "Rizky Pratama",
      "extracted_id": "112204510088",
      "filename": "UAS_RPL_1122045_Revisi.pdf"
    },
    "grading_breakdown": [
      {
        "criterion_name": "Kedalaman Analisis Teknis",
        "weight_percentage": 50,
        "score_given": 80,
        "short_reasoning": "Penjelasan mengenai trade-off latency, kompleksitas DevOps, dan skalabilitas disajikan secara padat dan tepat."
      },
      {
        "criterion_name": "Studi Kasus & Relevansi",
        "weight_percentage": 30,
        "score_given": 85,
        "short_reasoning": "Skenario migrasi pada aplikasi tiket konser dan indikator kesiapan tim disajikan secara konkret dan relevan."
      },
      {
        "criterion_name": "Referensi & Sitasi",
        "weight_percentage": 20,
        "score_given": 65,
        "short_reasoning": "Sesuai catatan kalibrasi dosen, diberikan nilai penyesuaian karena mencantumkan rujukan buku kredibel."
      }
    ],
    "final_weighted_score": 78.5,
    "feedback_for_student": "Analisis konsep arsitektur dan studi kasus migrasi yang Anda susun sudah sangat baik dan kontekstual. Untuk tugas berikutnya, pastikan daftar pustaka tertulis lengkap sesuai batas minimal.",
    "ai_writing_suspicion": "Low"
  }
}
```

---

## API Endpoints

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/api/session/parse` | `POST` | Accepts `multipart/form-data` uploads (`.pdf`, `.docx`, `.txt`, `.zip`), extracts normalized text, and computes the local TF-IDF similarity matrix. |
| `/api/session/calibrate` | `POST` | Validates free calibration quota (`MAX_FREE_CALIBRATION_RUNS = 2`) and evaluates the first $N=3$ sample documents in parallel. |
| `/api/session/execute` | `POST` | Verifies credit balance (`HTTP 402` with QRIS top-up offer if insufficient) and executes the remaining batch via the concurrent worker pool (`default concurrency = 5`). |
| `/api/session/export` | `POST` | Compiles evaluated batch records and rubric criteria into a downloadable UTF-8 BOM `.csv` spreadsheet. |

---

## System Requirements & Tech Stack

* **Runtime Environment:** Node.js ($\ge 20.\text{x}$)
* **Fullstack Framework:** SvelteKit 2 + Svelte 5 + TypeScript + Tailwind CSS
* **Schema & Validation:** Zod (`GradingOutputSchema` + Structured JSON Schema)
* **Database & ORM:** SQLite (Dev) / PostgreSQL (Prod) via Prisma ORM (`prisma/schema.prisma`)
* **LLM Provider:** Google Gemini API (`gemini-2.5-flash` / `gemini-2.0-flash` with automatic fallback & exponential backoff retry)

---

## Installation & Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/logostelabauen/rubrika.git
   cd rubrika
   ```

2. **Environment Configuration**
   Copy the template environment file and configure your credentials:
   ```bash
   cp .env.example .env
   ```
   Variables inside `.env`:
   ```env
   NODE_ENV=development
   PORT=3000
   DATABASE_URL="file:./dev.db"
   LLM_API_KEY="your_gemini_api_key_here"
   GEMINI_MODEL="gemini-2.5-flash"
   SIMILARITY_THRESHOLD=0.80
   ```

3. **Install Dependencies, Typecheck, & Run Unit Tests**
   ```bash
   npm install
   npm run check
   npm run test
   ```

4. **Initialize Database (Optional for Local Persistence)**
   ```bash
   npm run db:push
   ```

5. **Start the Development Server**
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` in your browser. You can also configure or override the Gemini API key directly from the **⚙ Konfigurasi API Key** modal in the top navigation bar.

---

## Security Hardening & Quality Assurance

Rubrika implements an 8-stage QA & Security Hardening pipeline verified by **22 automated Vitest unit tests** (`src/lib/__tests__/`):

* **Indirect Prompt Injection Defense:** Wraps student text inside `<student_submission>...</student_submission>` XML tags, escapes closing tag breakout attempts (`sanitizeStudentSubmissionText`), and enforces strict untrusted-data system instructions.
* **Empty Document Pre-Filter (Zero Token Cost):** Documents with $< 20$ words (e.g., blank files or unindexed image scans) automatically bypass Gemini API calls and receive a deterministic `0` score at zero token cost.
* **Token Exhaustion Guard:** Hard-truncates extracted document text at `30,000` characters (`truncateDocumentText`) prior to LLM inference.
* **ZIP Bomb & DoS Protection:** Enforces strict archive limits (`MAX_ZIP_ENTRIES = 100` files per `.zip` and `MAX_EXTRACTED_FILE_BYTES = 5 MB` per file via `maxOutputLength`).
* **Atomic Credit Settlement & Auto-Refund:** Automatically refunds credits (`calculateBatchCreditSettlement`) for any document ending in `MANUAL_REVIEW_REQUIRED` due to upstream API failures, paired with client-side in-flight locks to prevent double-spend spam clicks.
* **Local Identity Regex Fallback:** Extracts Student Name and NIM/ID (`extractIdentityFallback`) from headers or filenames (`11.22.045.88`, `2021/SI/045`, `UAS_RPL_112204510088_Rizky.pdf`) whenever the LLM returns `"Tidak Tertera"`.
* **CSV Formula Injection Guard:** Sanitizes cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` to prevent DDE/Spreadsheet execution attacks when opened in Excel.

---

## Project Structure

```text
rubrika/
├── src/
│   ├── lib/
│   │   ├── __tests__/       # Vitest QA & Security Hardening test suites (22 tests)
│   │   │   ├── evaluator.test.ts
│   │   │   ├── parser-exporter.test.ts
│   │   │   ├── post-beta.test.ts
│   │   │   ├── security-hardening.test.ts
│   │   │   └── similarity.test.ts
│   │   ├── credits/         # Credit wallet guard, auto-refund settlement, & QRIS top-up
│   │   ├── exporter/        # UTF-8 BOM CSV / Excel gradebook compiler with DDE guard
│   │   ├── grader/          # System prompts, Zod schemas, Gemini evaluator, & batch worker pool
│   │   │   ├── batch.ts
│   │   │   ├── evaluator.ts
│   │   │   ├── index.ts
│   │   │   ├── prompt.ts
│   │   │   └── schema.ts
│   │   ├── parser/          # Local PDF, DOCX, TXT, and ZIP extraction engine (with ZIP bomb guard)
│   │   └── similarity/      # Unigram/Bigram TF-IDF vectorizer & Cosine Similarity engine
│   ├── routes/
│   │   ├── api/session/
│   │   │   ├── calibrate/+server.ts
│   │   │   ├── execute/+server.ts
│   │   │   ├── export/+server.ts
│   │   │   └── parse/+server.ts
│   │   ├── +layout.svelte
│   │   └── +page.svelte     # Interactive 4-Step Instructor Wizard UI
│   ├── app.css
│   └── app.html
├── prisma/
│   └── schema.prisma        # User, CreditTransaction, GradingSession, & Submission models
├── .env.example
├── package.json
├── svelte.config.js
├── tailwind.config.js
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## License

Copyright (c) 2026 Lucas Weber. All rights reserved.

This software and its source code are proprietary. Unauthorized copying, modification, distribution, or commercial deployment of this software, via any medium, is strictly prohibited without prior written permission from the author.

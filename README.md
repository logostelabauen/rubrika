# Rubrika

**High-Throughput AI Assessment & Quality Control Engine**

Rubrika is a deterministic batch-grading pipeline engineered for higher education, technical bootcamps, and vocational training institutions (LPK). It replaces manual, sequential assignment grading with an asynchronous document processing architecture.

By combining local vector-based similarity detection with structured Large Language Model (LLM) evaluation, Rubrika processes bulk document submissions against weighted academic rubrics in minutes while maintaining strict token efficiency and grading consistency.

---

## Architectural Overview

Rubrika decouples text extraction and plagiarism detection from LLM inference to minimize operational costs and latency.

```text
[Ingestion Layer]       Bulk PDF / DOCX / ZIP Archive Upload
        │
        ▼
[Extraction Engine]     Local raw text parsing & metadata normalization
        │
        ▼
[Similarity Matrix]     Pairwise TF-IDF & Cosine Similarity computation (Zero API Cost)
        │
        ▼
[Calibration Gate]      3-Sample dry run ──► Instructor validation & rubric adjustment
        │
        ▼
[Inference Queue]       Asynchronous worker pool ──► LLM Structured JSON Evaluation
        │
        ▼
[Export & Persistence]  PostgreSQL/SQLite storage ──► Interactive UI & .XLSX Gradebook
```

---

## Core Capabilities

| Module | Technical Implementation | Operational Benefit |
| :--- | :--- | :--- |
| **Batch Ingestion** | Stream-based `.zip`, `.pdf`, and `.docx` parser with asynchronous task queuing. | Processes 50–200+ assignments concurrently without browser timeouts or API rate-limit failures. |
| **Local Similarity Engine** | In-memory $n$-gram vectorization and pairwise Cosine Similarity ($S_C$) calculation prior to LLM calls. | Flags peer-to-peer copy-pasting across a class batch at zero token cost. |
| **Sample Calibration** | Evaluates an initial $N=3$ subset before locking batch execution. | Allows instructors to fine-tune grading strictness and rubric weights before consuming compute credits. |
| **Deterministic Grading** | Enforces strict JSON Schema validation on LLM responses. | Guarantees 100% parseable outputs (Extracted Name/NIM, criterion scores, reasoning, and student feedback). |
| **Gradebook Compiler** | Automated mapping from relational JSON records to `.xlsx` and `.csv` buffers. | Generates administrative-ready spreadsheets compatible with university portals and LMS platforms. |

---

## Mathematical & Scoring Specification

1. **Cross-Submission Similarity:**
   Prior to grading, each extracted document $D_i$ is converted into a TF-IDF vector $\mathbf{v}_i$. Pairwise similarity across a batch of $m$ documents is computed as:
   $$S_C(D_i, D_j) = \frac{\mathbf{v}_i \cdot \mathbf{v}_j}{\|\mathbf{v}_i\| \|\mathbf{v}_j\|}$$
   Submissions exceeding the configurable threshold ($\tau \ge 0.80$) are flagged for manual review.

2. **Weighted Rubric Calculation:**
   For a rubric with $k$ criteria, where each criterion $c$ has an assigned weight $w_c$ (such that $\sum_{c=1}^{k} w_c = 1.0$) and an LLM-assigned score $s_c \in [0, 100]$, the final grade $G$ is deterministically verified on the backend:
   $$G = \sum_{c=1}^{k} (w_c \cdot s_c)$$

---

## Deterministic Output Schema

Every evaluated document is strictly validated against the following payload contract before persistence:

```json
{
  "metadata": {
    "filename": "UAS_SistemInformasi_Budi.pdf",
    "extracted_student_name": "Budi Santoso",
    "extracted_student_id": "1122025100045",
    "processed_at": "2026-10-15T16:50:00Z"
  },
  "integrity_check": {
    "similarity_flagged": false,
    "max_similarity_score": 0.18,
    "closest_match_file": "UAS_SistemInformasi_Andi.pdf"
  },
  "evaluation": {
    "criteria_breakdown": [
      {
        "criterion_id": "crit_01",
        "name": "Ketepatan Analisis Studi Kasus",
        "weight": 0.50,
        "score": 86,
        "justification": "Demonstrates strong understanding of system bottlenecks, though mitigation steps lack cost estimation."
      },
      {
        "criterion_id": "crit_02",
        "name": "Struktur & Referensi Akademik",
        "weight": 0.50,
        "score": 80,
        "justification": "Coherent structure and proper citation formatting, but relies heavily on secondary sources."
      }
    ],
    "final_weighted_score": 83.0,
    "constructive_feedback": "Analisis studi kasus sudah sangat tajam. Untuk pengembangan selanjutnya, lengkapi rekomendasi solusi dengan estimasi dampak operasional dan gunakan referensi jurnal primer."
  }
}
```

---

## System Requirements & Stack

* **Runtime Environment:** Node.js ($\ge 20.\text{x}$) or Python ($\ge 3.11$)
* **Web Framework:** SvelteKit / React with Tailwind CSS
* **Database:** PostgreSQL or SQLite (via Prisma / Drizzle / SQLAlchemy)
* **LLM Provider:** Google Gemini 1.5 Flash / OpenAI API (Structured Outputs enabled)
* **Document Processing:** Local PDF/DOCX text extraction libraries

---

## Installation & Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/username/rubrika.git
   cd rubrika
   ```

2. **Environment Configuration**
   Copy the template environment file and configure your credentials:
   ```bash
   cp .env.example .env
   ```
   Required variables inside `.env`:
   ```env
   NODE_ENV=development
   PORT=3000
   DATABASE_URL="file:./dev.db"
   LLM_API_KEY="your_api_key_here"
   SIMILARITY_THRESHOLD=0.80
   ```

3. **Install Dependencies & Initialize Database**
   ```bash
   npm install
   npx prisma migrate dev
   ```

4. **Start the Development Server**
   ```bash
   npm run dev
   ```

---

## Project Structure

```text
rubrika/
├── src/
│   ├── lib/
│   │   ├── parser/          # PDF, DOCX, and ZIP extraction utilities
│   │   ├── similarity/      # TF-IDF vectorizer & Cosine Similarity engine
│   │   ├── grader/          # LLM prompt templates & JSON schema validators
│   │   └── exporter/        # XLSX and CSV buffer generators
│   ├── routes/              # Application UI & API endpoints
│   └── app.html
├── prisma/
│   └── schema.prisma        # Database schema definitions
├── .env.example
├── package.json
└── README.md
```

---

## License

Copyright (c) 2026 Lucas Weber. All rights reserved.

This software and its source code are proprietary. Unauthorized copying, modification, distribution, or commercial deployment of this software, via any medium, is strictly prohibited without prior written permission from the author.

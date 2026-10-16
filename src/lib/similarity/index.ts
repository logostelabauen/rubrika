import type { SimilarityRecord } from '../grader/batch';

export interface SimilarityInputDocument {
  id?: string;
  filename: string;
  text: string;
}

export interface ComputeSimilarityOptions {
  threshold?: number;
  includeBigrams?: boolean;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

/**
 * Daftar stopwords umum Bahasa Indonesia dan Bahasa Inggris
 * untuk memfokuskan vektor TF-IDF pada kata kunci bermakna.
 */
const STOPWORDS = new Set<string>([
  // Bahasa Indonesia
  'yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'dengan', 'untuk', 'pada',
  'adalah', 'sebagai', 'dalam', 'tidak', 'akan', 'juga', 'atau', 'ada', 'mereka',
  'sudah', 'saya', 'kita', 'kami', 'anda', 'dia', 'ia', 'dapat', 'bisa', 'oleh',
  'karena', 'seperti', 'lebih', 'sangat', 'hanya', 'namun', 'tetapi', 'tapi',
  'saat', 'ketika', 'jika', 'apabila', 'bila', 'maka', 'sehingga', 'agar',
  'supaya', 'bahwa', 'tersebut', 'antara', 'secara', 'menjadi', 'memiliki',
  'merupakan', 'terhadap', 'melalui', 'setelah', 'sebelum', 'selama', 'sampai',
  'hingga', 'masih', 'telah', 'belum', 'para', 'setiap', 'semua',
  'suatu', 'sebuah', 'banyak', 'beberapa', 'lain', 'sama', 'hal', 'bagian',
  // Bahasa Inggris
  'the', 'and', 'to', 'of', 'in', 'is', 'it', 'for', 'that', 'with', 'on', 'as',
  'are', 'this', 'by', 'be', 'at', 'or', 'from', 'an', 'which', 'but', 'not',
  'can', 'will', 'have', 'has', 'had', 'was', 'were', 'been', 'their', 'they',
  'we', 'you', 'he', 'she', 'his', 'her', 'its', 'our', 'your', 'more', 'very',
  'only', 'also', 'when', 'if', 'then', 'so', 'than', 'into', 'about', 'between',
  'through', 'after', 'before', 'during', 'each', 'all', 'some', 'other', 'such'
]);

/**
 * Normalisasi teks: lowercase, hapus karakter non-alfanumerik/tanda baca,
 * pecah menjadi token kata, dan saring stopwords serta token terlalu pendek.
 */
export function normalizeAndTokenize(text: string): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Mengekstrak kombinasi unigram (1-gram) dan bigram (2-gram) dari array token
 * agar kemiripan kosakata sekaligus struktur frasa/kalimat terdeteksi akurat.
 */
export function extractNGrams(
  tokens: string[],
  includeBigrams: boolean = true
): string[] {
  if (tokens.length === 0) {
    return [];
  }

  const ngrams: string[] = [...tokens];

  if (includeBigrams && tokens.length >= 2) {
    for (let i = 0; i < tokens.length - 1; i++) {
      ngrams.push(`${tokens[i]}_${tokens[i + 1]}`);
    }
  }

  return ngrams;
}

type SparseVector = Map<string, number>;

/**
 * Membangun vektor TF-IDF (Sublinear TF scaling + Smooth IDF) untuk seluruh dokumen dalam batch.
 */
function buildTfIdfVectors(
  tokenizedDocs: string[][]
): { vectors: SparseVector[]; norms: number[] } {
  const docCount = tokenizedDocs.length;
  const documentFrequency = new Map<string, number>();
  const termFrequencies: Map<string, number>[] = [];

  for (const terms of tokenizedDocs) {
    const tfMap = new Map<string, number>();
    for (const term of terms) {
      tfMap.set(term, (tfMap.get(term) ?? 0) + 1);
    }
    termFrequencies.push(tfMap);

    for (const uniqueTerm of tfMap.keys()) {
      documentFrequency.set(
        uniqueTerm,
        (documentFrequency.get(uniqueTerm) ?? 0) + 1
      );
    }
  }

  const vectors: SparseVector[] = [];
  const norms: number[] = [];

  for (let i = 0; i < docCount; i++) {
    const tfMap = termFrequencies[i];
    const totalTerms = tokenizedDocs[i].length;
    const tfidfVector: SparseVector = new Map();
    let sumSquares = 0;

    if (totalTerms > 0) {
      for (const [term, count] of tfMap.entries()) {
        const df = documentFrequency.get(term) ?? 1;
        const tf = count / totalTerms;
        // Smooth IDF: ln(1 + N / df) + 1 agar term yang muncul di semua dokumen tetap memiliki bobot dasar
        const idf = Math.log(1 + docCount / df) + 1;
        const weight = tf * idf;

        tfidfVector.set(term, weight);
        sumSquares += weight * weight;
      }
    }

    vectors.push(tfidfVector);
    norms.push(Math.sqrt(sumSquares));
  }

  return { vectors, norms };
}

/**
 * Menghitung Cosine Similarity S_C(D_i, D_j) antara dua sparse vector TF-IDF.
 */
export function computeCosineSimilarity(
  vecA: SparseVector,
  normA: number,
  vecB: SparseVector,
  normB: number
): number {
  if (normA === 0 || normB === 0 || vecA.size === 0 || vecB.size === 0) {
    return 0;
  }

  // Iterasi pada vektor yang memiliki jumlah entry lebih sedikit untuk efisiensi
  const [smaller, larger] =
    vecA.size <= vecB.size ? [vecA, vecB] : [vecB, vecA];

  let dotProduct = 0;
  for (const [term, weightA] of smaller.entries()) {
    const weightB = larger.get(term);
    if (weightB !== undefined) {
      dotProduct += weightA * weightB;
    }
  }

  const similarity = dotProduct / (normA * normB);
  return Math.min(1, Math.max(0, similarity));
}

/**
 * Menghitung matriks kemiripan lintas dokumen dalam satu batch menggunakan TF-IDF (unigram + bigram)
 * dan Cosine Similarity murni di memori lokal (Zero API Cost).
 *
 * Output kompatibel langsung dengan `SimilarityRecord` pada `src/lib/grader/batch.ts`.
 */
export function computeBatchSimilarity(
  documents: SimilarityInputDocument[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  options: Omit<ComputeSimilarityOptions, 'threshold'> = {}
): SimilarityRecord[] {
  const docCount = documents.length;
  if (docCount === 0) {
    return [];
  }

  const includeBigrams = options.includeBigrams ?? true;

  const ngramsPerDoc = documents.map((doc) => {
    const tokens = normalizeAndTokenize(doc.text);
    return extractNGrams(tokens, includeBigrams);
  });

  const { vectors, norms } = buildTfIdfVectors(ngramsPerDoc);

  // Pairwise similarity matrix computation (simetris: S_C(i, j) == S_C(j, i))
  const maxScores = new Array<number>(docCount).fill(0);
  const closestMatchIndices = new Array<number>(docCount).fill(-1);

  for (let i = 0; i < docCount; i++) {
    for (let j = i + 1; j < docCount; j++) {
      const score = computeCosineSimilarity(
        vectors[i],
        norms[i],
        vectors[j],
        norms[j]
      );

      if (score > maxScores[i]) {
        maxScores[i] = score;
        closestMatchIndices[i] = j;
      }

      if (score > maxScores[j]) {
        maxScores[j] = score;
        closestMatchIndices[j] = i;
      }
    }
  }

  return documents.map((doc, idx): SimilarityRecord => {
    const rawMaxScore = maxScores[idx];
    const roundedScore =
      Math.round((rawMaxScore + Number.EPSILON) * 100) / 100;
    const matchIndex = closestMatchIndices[idx];
    const closestMatchFile =
      matchIndex !== -1 && roundedScore > 0
        ? documents[matchIndex].filename
        : null;

    return {
      ...(doc.id !== undefined ? { documentId: doc.id } : {}),
      filename: doc.filename,
      similarity_flagged: roundedScore >= threshold,
      max_similarity_score: roundedScore,
      closest_match_file: closestMatchFile
    };
  });
}

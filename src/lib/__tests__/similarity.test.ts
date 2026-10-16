import { describe, expect, it } from 'vitest';
import { computeBatchSimilarity } from '../similarity';

describe('Local Similarity Engine Unit Tests (TF-IDF + Cosine Similarity)', () => {
  it('Kasus Identik: 2 dokumen dengan teks sama persis menghasilkan max_similarity_score = 1 dan similarity_flagged = true', () => {
    const exactText =
      'Arsitektur microservices memecah aplikasi monolitik menjadi layanan independen yang berkomunikasi melalui protokol jaringan seperti REST API atau message broker.';

    const results = computeBatchSimilarity(
      [
        { id: 'doc-1', filename: 'Tugas_Andi.pdf', text: exactText },
        { id: 'doc-2', filename: 'Tugas_Budi.pdf', text: exactText }
      ],
      0.8
    );

    expect(results).toHaveLength(2);
    expect(results[0].max_similarity_score).toBe(1);
    expect(results[0].similarity_flagged).toBe(true);
    expect(results[0].closest_match_file).toBe('Tugas_Budi.pdf');

    expect(results[1].max_similarity_score).toBe(1);
    expect(results[1].similarity_flagged).toBe(true);
    expect(results[1].closest_match_file).toBe('Tugas_Andi.pdf');
  });

  it('Kasus Ganti Kata Sambung (Stopwords): 2 paragraf yang intinya sama namun diubah stopwords tetap terdeteksi mirip >= 0.80', () => {
    const paragraphA =
      'Pada arsitektur monolitik yang menyatukan seluruh komponen aplikasi di dalam satu basis kode dan proses yang sama, pengujian sistem menjadi sederhana namun deployment lambat ketika aplikasi membesar.';
    const paragraphB =
      'Dalam arsitektur monolitik tersebut seluruh komponen aplikasi menyatukan satu basis kode serta proses sama, sehingga pengujian sistem adalah sederhana tetapi deployment lambat saat aplikasi membesar.';

    const results = computeBatchSimilarity(
      [
        { id: 'doc-a', filename: 'Mahasiswa_A.docx', text: paragraphA },
        { id: 'doc-b', filename: 'Mahasiswa_B.docx', text: paragraphB }
      ],
      0.8
    );

    expect(results[0].max_similarity_score).toBeGreaterThanOrEqual(0.8);
    expect(results[0].similarity_flagged).toBe(true);
    expect(results[0].closest_match_file).toBe('Mahasiswa_B.docx');
  });

  it('Kasus Dokumen Kosong / 1 Kata: tidak terjadi division by zero (NaN) dan mengembalikan skor 0 dengan aman', () => {
    const results = computeBatchSimilarity(
      [
        { id: 'empty-1', filename: 'Kosong.pdf', text: '' },
        { id: 'whitespace-2', filename: 'Spasi.pdf', text: '   \n\t  ' },
        { id: 'one-word-3', filename: 'SatuKata.txt', text: 'Microservices' }
      ],
      0.8
    );

    expect(results).toHaveLength(3);
    for (const item of results) {
      expect(Number.isNaN(item.max_similarity_score)).toBe(false);
      expect(item.max_similarity_score).toBe(0);
      expect(item.similarity_flagged).toBe(false);
      expect(item.closest_match_file).toBeNull();
    }
  });
});

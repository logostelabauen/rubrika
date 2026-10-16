import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { generateGradebookCSV } from '../exporter';
import { parseUploadedFiles } from '../parser';
import type { BatchDocumentResult, RubricCriterion } from '../grader';

/**
 * Helper pembuat buffer arsip ZIP valid di memori untuk pengujian unit
 * tanpa memerlukan binary zip eksternal.
 */
function createTestZipBuffer(
  entries: { path: string; content: string; compress?: boolean }[]
): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const uncompressedBuf = Buffer.from(entry.content, 'utf8');
    const useDeflate = entry.compress ?? true;
    const dataBuf = useDeflate
      ? deflateRawSync(uncompressedBuf)
      : uncompressedBuf;
    const compressionMethod = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(0, 14); // crc32 (0 for test)
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(uncompressedBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length

    const localChunk = Buffer.concat([localHeader, nameBuf, dataBuf]);
    localHeaders.push(localChunk);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(dataBuf.length, 20); // compressed size
    centralHeader.writeUInt32LE(uncompressedBuf.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28); // filename length
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralHeaders.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localChunk.length;
  }

  const centralDirBuffer = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirBuffer.length, 12); // size of central dir
  eocd.writeUInt32LE(offset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, eocd]);
}

describe('Parser & CSV Exporter Unit Tests', () => {
  describe('CSV Formula Injection Guard pada generateGradebookCSV()', () => {
    it("menambahkan prefix tanda kutip tunggal (') pada sel yang diawali =, +, -, atau @", () => {
      const criteria: RubricCriterion[] = [
        {
          name: 'Analisis',
          weightPercentage: 100,
          description: 'Ketepatan analisis'
        }
      ];

      const maliciousResults: BatchDocumentResult[] = [
        {
          filename: 'Tugas_Hacker.pdf',
          status: 'COMPLETED',
          processed_at: '2026-10-16T00:00:00.000Z',
          integrity_check: {
            similarity_flagged: false,
            max_similarity_score: 0.1,
            closest_match_file: null
          },
          evaluation: {
            student_identity: {
              extracted_name: "=cmd|' /C calc'!A0",
              extracted_id: '+SUM(1+1)',
              filename: 'Tugas_Hacker.pdf'
            },
            grading_breakdown: [
              {
                criterion_name: 'Analisis',
                weight_percentage: 100,
                score_given: 75,
                short_reasoning: '-2+3 alasan berbahaya'
              }
            ],
            final_weighted_score: 75,
            feedback_for_student: '@SUM(1+1) evaluasi selesai',
            ai_writing_suspicion: 'Low'
          }
        }
      ];

      const csv = generateGradebookCSV(maliciousResults, criteria);

      // Pastikan setiap formula berbahaya telah diberi prefix tanda kutip tunggal (')
      expect(csv).toContain("\"'=cmd|' /C calc'!A0\"");
      expect(csv).toContain("\"'+SUM(1+1)\"");
      expect(csv).toContain("\"'-2+3 alasan berbahaya\"");
      expect(csv).toContain("\"'@SUM(1+1) evaluasi selesai\"");
    });
  });

  describe('parseUploadedFiles() & Pembongkaran Arsip ZIP', () => {
    it('mengekstrak file di dalam arsip .zip, menormalisasi whitespace, dan mengabaikan __MACOSX / .DS_Store', async () => {
      const zipBuffer = createTestZipBuffer([
        {
          path: '__MACOSX/._Tugas_Budi.txt',
          content: 'file sistem macos yang harus diabaikan'
        },
        {
          path: '.DS_Store',
          content: 'file sistem ds_store yang harus diabaikan'
        },
        {
          path: 'Kelas_A/Tugas_Budi.txt',
          content:
            'Nama: Budi Santoso\r\n\r\n\r\nNIM:   1122025100045\t\t\nAnalisis   monolitik dan microservices.'
        },
        {
          path: 'Kelas_A/Tugas_Siti.txt',
          content: 'Nama: Siti Nurbaya\nNIM: 1122025100099\nPembahasan lengkap.'
        }
      ]);

      const extracted = await parseUploadedFiles([
        { filename: 'Bundel_Tugas_Kelas_A.zip', buffer: zipBuffer }
      ]);

      expect(extracted).toHaveLength(2);
      expect(extracted.map((d) => d.originalFilename)).toEqual([
        'Tugas_Budi.txt',
        'Tugas_Siti.txt'
      ]);

      // Pastikan whitespace berlebih telah dinormalisasi
      expect(extracted[0].extractedDocumentText).toBe(
        'Nama: Budi Santoso\n\nNIM: 1122025100045\nAnalisis monolitik dan microservices.'
      );
      expect(extracted[0].wordCount).toBe(9);
      expect(extracted[0].parseError).toBeUndefined();
    });

    it('mengisolasi file corrupt tanpa menghentikan proses ekstraksi dokumen lain di dalam batch', async () => {
      const results = await parseUploadedFiles([
        {
          filename: 'File_Rusak.pdf',
          buffer: Buffer.from('bukan-header-pdf-valid', 'utf8')
        },
        {
          filename: 'File_Valid.txt',
          buffer: Buffer.from('Ini adalah teks tugas mahasiswa yang valid.', 'utf8')
        }
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].originalFilename).toBe('File_Rusak.pdf');
      expect(results[0].extractedDocumentText).toBe('');
      expect(results[0].parseError).toBeDefined();

      expect(results[1].originalFilename).toBe('File_Valid.txt');
      expect(results[1].wordCount).toBe(7);
      expect(results[1].parseError).toBeUndefined();
    });
  });
});

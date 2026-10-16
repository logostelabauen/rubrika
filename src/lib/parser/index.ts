import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

export type SupportedDocumentType = 'pdf' | 'docx' | 'txt';

export interface UploadedFileInput {
  filename: string;
  buffer: Buffer | Uint8Array;
}

export interface ExtractedDocument {
  id: string;
  originalFilename: string;
  extractedDocumentText: string;
  wordCount: number;
  fileType: SupportedDocumentType;
  parseError?: string;
}

const MAX_ZIP_RECURSION_DEPTH = 3;
export const MAX_ZIP_ENTRIES = 100;
export const MAX_EXTRACTED_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file

/**
 * Membersihkan whitespace berlebih (spasi ganda, tab, dan baris kosong beruntun)
 * agar konsumsi token LLM efisien tanpa merusak struktur paragraf.
 */
export function normalizeDocumentWhitespace(rawText: string): string {
  if (!rawText) {
    return '';
  }

  return rawText
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Menghitung jumlah kata dari teks yang telah dinormalisasi.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Memeriksa apakah path di dalam arsip ZIP merupakan file sistem/hidden
 * seperti `__MACOSX`, `.DS_Store`, atau file diawali titik (`.`).
 */
export function isIgnoredSystemPath(filepath: string): boolean {
  const normalized = filepath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0) {
    return true;
  }

  for (const segment of segments) {
    if (
      segment === '__MACOSX' ||
      segment === '.DS_Store' ||
      segment === 'Thumbs.db' ||
      segment.startsWith('.') ||
      segment.startsWith('~$')
    ) {
      return true;
    }
  }

  return false;
}

function getFileExtension(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const lastDot = base.lastIndexOf('.');
  if (lastDot <= 0) {
    return '';
  }
  return base.slice(lastDot + 1).toLowerCase();
}

function getCleanFilename(filepath: string): string {
  const normalized = filepath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filepath;
}

function toBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

/**
 * Membaca entri file dari arsip ZIP menggunakan parser Central Directory bawaan Node.js (`node:zlib`),
 * sehingga dapat membongkar `.zip` maupun `.docx` tanpa bergantung pada paket native eksternal.
 */
function readZipEntriesNative(
  zipBuffer: Buffer,
  enforceFileCountLimit: boolean = true
): { path: string; data: Buffer }[] {
  // Cari End of Central Directory (EOCD) signature: 0x06054b50
  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, zipBuffer.length - 65557);

  for (let i = zipBuffer.length - 22; i >= minEocdOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Format arsip ZIP tidak valid atau corrupt (EOCD tidak ditemukan).');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const entries: { path: string; data: Buffer }[] = [];
  let offset = centralDirOffset;
  let validFileCount = 0;

  for (let i = 0; i < totalEntries && offset + 46 <= zipBuffer.length; i++) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) {
      break;
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

    const entryPath = zipBuffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8');

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;

    // Lewati direktori
    if (entryPath.endsWith('/')) {
      continue;
    }

    if (enforceFileCountLimit && !isIgnoredSystemPath(entryPath)) {
      validFileCount += 1;
      if (validFileCount > MAX_ZIP_ENTRIES) {
        throw new Error(
          `Arsip ZIP melebihi batas keamanan maksimal ${MAX_ZIP_ENTRIES} file dalam 1 arsip (ZIP Bomb / DoS Guard).`
        );
      }
    }

    if (
      uncompressedSize > MAX_EXTRACTED_FILE_BYTES ||
      compressedSize > MAX_EXTRACTED_FILE_BYTES
    ) {
      throw new Error(
        `Ukuran ekstraksi file "${entryPath}" melebihi batas keamanan maksimal 5 MB.`
      );
    }

    if (localHeaderOffset + 30 > zipBuffer.length) {
      throw new Error(`Header lokal ZIP rusak pada entri: ${entryPath}`);
    }

    const localSignature = zipBuffer.readUInt32LE(localHeaderOffset);
    if (localSignature !== 0x04034b50) {
      throw new Error(`Signature header lokal ZIP tidak valid pada entri: ${entryPath}`);
    }

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = zipBuffer.subarray(
      dataStart,
      dataStart + compressedSize
    );

    let uncompressedData: Buffer;
    if (compressionMethod === 0) {
      uncompressedData = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      try {
        uncompressedData = inflateRawSync(compressedData, {
          maxOutputLength: MAX_EXTRACTED_FILE_BYTES
        });
      } catch (zlibErr) {
        const msg =
          zlibErr instanceof Error ? zlibErr.message : String(zlibErr);
        throw new Error(
          `Gagal dekompresi entri "${entryPath}" (kemungkinan melebihi batas 5 MB): ${msg}`
        );
      }
    } else {
      throw new Error(
        `Metode kompresi ZIP (${compressionMethod}) tidak didukung pada entri: ${entryPath}`
      );
    }

    if (uncompressedData.length > MAX_EXTRACTED_FILE_BYTES) {
      throw new Error(
        `Ukuran ekstraksi file "${entryPath}" melebihi batas keamanan maksimal 5 MB.`
      );
    }

    entries.push({ path: entryPath, data: uncompressedData });
  }

  return entries;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

/**
 * Ekstraksi teks dari file .docx (menggunakan `mammoth` jika terinstal,
 * atau fallback langsung mengekstrak `word/document.xml` dari paket OpenXML).
 */
async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const mammothModuleName = 'mammoth';
    const mammoth = await import(/* @vite-ignore */ mammothModuleName);
    const extractFn = mammoth.extractRawText ?? mammoth.default?.extractRawText;
    if (typeof extractFn === 'function') {
      const result = await extractFn({ buffer });
      if (typeof result?.value === 'string') {
        return result.value;
      }
    }
  } catch {
    // Gunakan fallback native parser jika mammoth belum terinstal
  }

  const entries = readZipEntriesNative(buffer, false);
  const docXmlEntry = entries.find(
    (entry) => entry.path.replace(/\\/g, '/') === 'word/document.xml'
  );

  if (!docXmlEntry) {
    throw new Error(
      'File DOCX tidak valid atau corrupt (word/document.xml tidak ditemukan).'
    );
  }

  const xmlContent = docXmlEntry.data.toString('utf8');
  const withBreaks = xmlContent
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '');

  return decodeXmlEntities(withBreaks);
}

/**
 * Ekstraksi teks dari file .pdf (menggunakan `pdf-parse` jika terinstal,
 * atau fallback mengekstrak operator teks PDF).
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const header = buffer.subarray(0, 5).toString('ascii');
  if (header !== '%PDF-') {
    throw new Error('File bukan dokumen PDF yang valid (header %PDF- tidak ditemukan).');
  }

  try {
    const pdfParseModuleName = 'pdf-parse';
    const pdfParseMod = await import(/* @vite-ignore */ pdfParseModuleName);
    const pdfParse = pdfParseMod.default ?? pdfParseMod;
    if (typeof pdfParse === 'function') {
      const parsed = await pdfParse(buffer);
      if (typeof parsed?.text === 'string') {
        return parsed.text;
      }
    }
  } catch {
    // Lanjutkan ke fallback ekstraktor PDF jika pdf-parse belum terinstal
  }

  // Fallback ekstraksi literal string dari stream PDF
  const rawContent = buffer.toString('latin1');
  const extractedChunks: string[] = [];

  const textBlocks = rawContent.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of textBlocks) {
    const stringLiterals = block.match(/\((?:\\.|[^\\()])*\)/g) ?? [];
    for (const literal of stringLiterals) {
      const inner = literal
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, ' ')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\');
      if (inner.trim().length > 0) {
        extractedChunks.push(inner);
      }
    }
  }

  return extractedChunks.join(' ');
}

/**
 * Memproses satu file dokumen (.pdf, .docx, atau .txt) dan mengembalikan `ExtractedDocument`.
 * Kegagalan ekstraksi diisolasi ke dalam properti `parseError` tanpa menghentikan batch.
 */
async function parseSingleDocument(
  filename: string,
  buffer: Buffer,
  fileType: SupportedDocumentType
): Promise<ExtractedDocument> {
  const id = randomUUID();
  const cleanName = getCleanFilename(filename);

  try {
    if (buffer.length === 0) {
      throw new Error('File kosong (0 byte).');
    }

    if (buffer.length > MAX_EXTRACTED_FILE_BYTES) {
      throw new Error(
        `Ukuran file "${cleanName}" melebihi batas keamanan maksimal 5 MB.`
      );
    }

    let rawText = '';
    if (fileType === 'txt') {
      rawText = buffer.toString('utf8');
    } else if (fileType === 'docx') {
      rawText = await extractDocxText(buffer);
    } else if (fileType === 'pdf') {
      rawText = await extractPdfText(buffer);
    }

    const normalizedText = normalizeDocumentWhitespace(rawText);
    const wordCount = countWords(normalizedText);

    if (wordCount === 0) {
      return {
        id,
        originalFilename: cleanName,
        extractedDocumentText: '',
        wordCount: 0,
        fileType,
        parseError:
          'Tidak ada teks yang dapat diekstrak dari dokumen (kemungkinan hasil scan gambar atau file kosong).'
      };
    }

    return {
      id,
      originalFilename: cleanName,
      extractedDocumentText: normalizedText,
      wordCount,
      fileType
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      originalFilename: cleanName,
      extractedDocumentText: '',
      wordCount: 0,
      fileType,
      parseError: message
    };
  }
}

/**
 * Membongkar file dan arsip .zip secara rekursif, lalu mengekstrak seluruh dokumen
 * yang didukung (.pdf, .docx, .txt).
 */
async function processFileEntry(
  file: UploadedFileInput,
  depth: number = 0
): Promise<ExtractedDocument[]> {
  if (isIgnoredSystemPath(file.filename)) {
    return [];
  }

  const ext = getFileExtension(file.filename);
  const buffer = toBuffer(file.buffer);

  if (ext === 'zip') {
    if (depth >= MAX_ZIP_RECURSION_DEPTH) {
      return [
        {
          id: randomUUID(),
          originalFilename: getCleanFilename(file.filename),
          extractedDocumentText: '',
          wordCount: 0,
          fileType: 'txt',
          parseError: 'Melewati batas kedalaman rekursi arsip ZIP.'
        }
      ];
    }

    try {
      const entries = readZipEntriesNative(buffer);
      const nestedResults: ExtractedDocument[] = [];

      for (const entry of entries) {
        if (isIgnoredSystemPath(entry.path)) {
          continue;
        }
        const extractedFromEntry = await processFileEntry(
          { filename: entry.path, buffer: entry.data },
          depth + 1
        );
        nestedResults.push(...extractedFromEntry);
      }

      return nestedResults;
    } catch (zipErr) {
      const message = zipErr instanceof Error ? zipErr.message : String(zipErr);
      return [
        {
          id: randomUUID(),
          originalFilename: getCleanFilename(file.filename),
          extractedDocumentText: '',
          wordCount: 0,
          fileType: 'txt',
          parseError: `Gagal membongkar arsip ZIP: ${message}`
        }
      ];
    }
  }

  if (ext === 'pdf' || ext === 'docx' || ext === 'txt') {
    const parsed = await parseSingleDocument(file.filename, buffer, ext);
    return [parsed];
  }

  // Abaikan file dengan ekstensi yang tidak didukung di dalam ZIP, atau tandai error jika diunggah langsung
  if (depth === 0) {
    return [
      {
        id: randomUUID(),
        originalFilename: getCleanFilename(file.filename),
        extractedDocumentText: '',
        wordCount: 0,
        fileType: 'txt',
        parseError: `Format file ".${ext || 'unknown'}" tidak didukung (gunakan .pdf, .docx, .txt, atau .zip).`
      }
    ];
  }

  return [];
}

/**
 * Mengekstrak teks dari sekumpulan file unggahan (.pdf, .docx, .txt, atau arsip .zip).
 * Mengabaikan file sistem (`__MACOSX`, hidden files) dan mengisolasi file corrupt
 * tanpa menghentikan pemrosesan batch.
 */
export async function parseUploadedFiles(
  files: UploadedFileInput[]
): Promise<ExtractedDocument[]> {
  const extractedDocuments: ExtractedDocument[] = [];

  for (const file of files) {
    const results = await processFileEntry(file, 0);
    extractedDocuments.push(...results);
  }

  return extractedDocuments;
}

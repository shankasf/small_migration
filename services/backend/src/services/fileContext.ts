import multer from 'multer';
import * as XLSX from 'xlsx';

/** Upload parser for session files (10 MB each, up to 10 per request). */
export const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers send raw UTF-8 filenames; multer's latin1 default turns "design‑doc.md"
  // (U+2011) into mojibake that no longer matches the name the user and AI see.
  defParamCharset: 'utf8',
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** Error carrying an HTTP status the global error handler forwards to the user. */
function userError(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

export interface ExtractedText {
  content: string;
  warnings: string[];
}

/**
 * Decode uploaded text without silently garbling it: honour UTF-8/UTF-16 byte
 * order marks, and fall back to Windows-1252 (with a warning) instead of
 * replacing every non-UTF-8 byte with U+FFFD.
 */
export function decodeText(buffer: Buffer): ExtractedText {
  const warnings: string[] = [];
  let content: string;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    content = new TextDecoder('utf-8').decode(buffer.subarray(3));
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    content = new TextDecoder('utf-16le').decode(buffer.subarray(2));
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    content = new TextDecoder('utf-16be').decode(buffer.subarray(2));
  } else {
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      content = new TextDecoder('windows-1252').decode(buffer);
      warnings.push('File is not valid UTF-8; it was read as Windows-1252. Check special characters.');
    }
  }
  if (content.includes('\u0000')) {
    throw userError('File appears to be binary, not text. Save it as UTF-8 text and upload again.');
  }
  return { content, warnings };
}

/** Extract the text the AI will see. Throws a 400 instead of storing unreadable or empty content. */
export function extractUploadText(buffer: Buffer, filename: string): ExtractedText {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'xlsx' || ext === 'xls') {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' });
    } catch {
      throw userError(`${filename}: the spreadsheet could not be read. Re-save it as .xlsx or .csv and upload again.`);
    }
    const warnings: string[] = [];
    let content = '';
    for (const sheetName of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      if (!csv.replace(/[,\s]/g, '')) warnings.push(`Sheet "${sheetName}" is empty.`);
      content += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
    }
    if (!workbook.SheetNames.length || warnings.length === workbook.SheetNames.length) {
      throw userError(`${filename}: the spreadsheet contains no readable cells.`);
    }
    return { content, warnings };
  }

  const decoded = decodeText(buffer);
  if (!decoded.content.trim()) throw userError(`${filename}: the file is empty or contains no readable text.`);
  if (ext === 'json') {
    try {
      return { ...decoded, content: JSON.stringify(JSON.parse(decoded.content), null, 2) };
    } catch {
      return { ...decoded, warnings: [...decoded.warnings, 'File is not valid JSON; it was kept as plain text.'] };
    }
  }
  return decoded;
}

export interface SessionFileLike { id: string; filename: string; content: string }
export interface AssetLike {
  id: string; filename: string; version: number; content: string; uploadedFileId?: string | null;
}

/** Stable label for an explicitly referenced, immutable file version. */
export function assetLabel(asset: AssetLike): string {
  return `${asset.filename} [v${asset.version}; ${asset.id}]`;
}

/**
 * Files the AI receives this turn. Every current session upload is always
 * included; it is skipped only when an attached library asset is the identical
 * snapshot of that same upload (same source row, same content). A pinned older
 * version, another chat's file or a generated output that merely shares the
 * filename never hides the current upload. This turn's explicit selections come
 * first so a downstream size budget never cuts them before older context.
 */
export function buildContextFiles(
  sessionFiles: SessionFileLike[], selected: AssetLike[], carried: AssetLike[],
): Record<string, string> {
  const assets = [...selected, ...carried];
  const files: Record<string, string> = {};
  for (const asset of selected) files[assetLabel(asset)] = asset.content;
  for (const file of sessionFiles) {
    const duplicate = assets.some(a => a.uploadedFileId === file.id && a.content === file.content);
    if (!duplicate) files[file.filename] = file.content;
  }
  for (const asset of carried) files[assetLabel(asset)] = asset.content;
  return files;
}

/**
 * Carried assets after this turn's selections: an asset is dropped when the
 * user picked the same file (same source chat, kind and name) this turn, or
 * when a later carried reference (e.g. from a failed turn) picks it again.
 */
export function supersedeCarried<T extends { id: string; sessionId: string; kind: string; filename: string }>(
  selected: T[], previous: T[],
): T[] {
  const sameFile = (x: T, y: T) =>
    x.id === y.id || (x.sessionId === y.sessionId && x.kind === y.kind && x.filename === y.filename);
  return previous.filter((a, i) => !selected.some(s => sameFile(s, a)) &&
    !previous.slice(i + 1).some(later => sameFile(later, a)));
}

/** Asset ids to carry into this turn, de-duplicated, preserving first-seen order. */
export function carriedAssetIds(refGroups: Array<Array<{ assetId: string | null }>>): string[] {
  const ids: string[] = [];
  for (const refs of refGroups) for (const ref of refs) {
    if (ref.assetId && !ids.includes(ref.assetId)) ids.push(ref.assetId);
  }
  return ids;
}

/**
 * Carried assets the current user may still read, in carried-id order. Access is
 * decided by the same rule as opening the source chat (pass canAccessSession), so an
 * admin continuing another user's chat keeps its carried files, while a file from a
 * chat the user cannot open is never exposed.
 */
export function accessibleCarried<T extends { id: string; session: { ownerUserId: string | null } | null }>(
  ids: string[], found: T[], canAccess: (session: { ownerUserId: string | null }) => boolean,
): T[] {
  return ids.map(id => found.find(a => a.id === id))
    .filter((a): a is T => Boolean(a && a.session && canAccess(a.session)));
}

/** Translate multer limit errors into a message the user can act on. */
export function uploadLimitError(error: unknown): Error {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    LIMIT_FILE_SIZE: 'A file is larger than the 10 MB upload limit.',
    LIMIT_FILE_COUNT: 'Upload at most 10 files at a time.',
    // multer raises this for the 11th file of .array('files', 10), and for a wrong field name.
    LIMIT_UNEXPECTED_FILE: 'Upload at most 10 files at a time.',
  };
  if (code && messages[code]) return userError(messages[code]);
  if ((error as Error)?.name === 'MulterError') return userError('The upload could not be read. Please try again.');
  return error as Error;
}

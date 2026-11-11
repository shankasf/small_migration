// DB-free tests for what the AI receives as file context and how uploads are
// extracted. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as XLSX from 'xlsx';
import {
  assetLabel, buildContextFiles, carriedAssetIds, decodeText, extractUploadText, supersedeCarried, upload, uploadLimitError,
} from '../src/services/fileContext.js';

const SESSION_FILE = { id: 'upload-row-1', filename: 'design‑doc.md', content: '# Design v2\nCurrent text' };
const asset = (over: Partial<{ id: string; filename: string; version: number; content: string; uploadedFileId: string | null }>) => ({
  id: '00000000-0000-4000-8000-000000000001', filename: 'design‑doc.md', version: 1,
  content: '# Design v1', uploadedFileId: null, ...over,
});

test('session upload stays in context when another chat file shares its name', () => {
  const other = asset({ uploadedFileId: 'some-other-upload', content: '# Other chat design' });
  const files = buildContextFiles([SESSION_FILE], [], [other]);
  assert.equal(files['design‑doc.md'], SESSION_FILE.content);
  assert.equal(files[assetLabel(other)], other.content);
});

test('a pinned older version does not hide a newer re-upload of the same file', () => {
  const v1 = asset({ uploadedFileId: SESSION_FILE.id, content: '# Design v1' });
  const files = buildContextFiles([SESSION_FILE], [], [v1]);
  assert.deepEqual(Object.keys(files).sort(), ['design‑doc.md', assetLabel(v1)].sort());
});

test('an identical snapshot of the current upload is sent once, under its version label', () => {
  const same = asset({ uploadedFileId: SESSION_FILE.id, version: 2, content: SESSION_FILE.content });
  const files = buildContextFiles([SESSION_FILE], [same], []);
  assert.deepEqual(Object.keys(files), [assetLabel(same)]);
});

test('this turn\'s selections come first, then uploads, then carried references', () => {
  const selected = asset({ id: '00000000-0000-4000-8000-00000000000a', filename: 'mapping.xlsx' });
  const carried = asset({ id: '00000000-0000-4000-8000-00000000000b', filename: 'old.sql' });
  const files = buildContextFiles([SESSION_FILE], [selected], [carried]);
  assert.deepEqual(Object.keys(files), [assetLabel(selected), 'design‑doc.md', assetLabel(carried)]);
});

test('references carry from the last reply and from user turns whose reply failed', () => {
  assert.deepEqual(carriedAssetIds([
    [{ assetId: 'a' }, { assetId: null }],
    [{ assetId: 'b' }, { assetId: 'a' }],
  ]), ['a', 'b']);
});

test('a newer pick of the same file supersedes the carried older version', () => {
  const ref = (id: string, version: number) => ({ id, version, sessionId: 's1', kind: 'upload', filename: 'design.md' });
  const v1 = ref('v1', 1), v2 = ref('v2', 2), other = { ...ref('o', 1), filename: 'other.sql' };
  // v1 on the last reply, v2 on a later failed user turn: only v2 is carried.
  assert.deepEqual(supersedeCarried([], [v1, other, v2]).map(a => a.id), ['o', 'v2']);
  // Selecting v1 again this turn drops the carried v2.
  assert.deepEqual(supersedeCarried([v1], [v2, other]).map(a => a.id), ['o']);
});

test('UTF-8 text with U+2011 and a BOM decodes exactly', () => {
  const text = 'Non‑breaking hyphen ‑ and café';
  assert.deepEqual(decodeText(Buffer.from(text, 'utf8')), { content: text, warnings: [] });
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])).content, text);
});

test('UTF-16 files with a BOM are decoded instead of becoming NUL-filled text', () => {
  const text = '# Synthetic design ‑ doc';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeText(le).content, text);
  const be = Buffer.from(le); be.swap16();
  assert.equal(decodeText(be).content, text);
});

test('non-UTF-8 text falls back to Windows-1252 with a warning', () => {
  const result = decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in cp1252
  assert.equal(result.content, 'café');
  assert.equal(result.warnings.length, 1);
});

test('binary or empty text uploads are rejected with a 400 the user can read', () => {
  assert.throws(() => extractUploadText(Buffer.from([0x61, 0x00, 0x62, 0x00]), 'x.txt'), (e: any) => e.statusCode === 400);
  assert.throws(() => extractUploadText(Buffer.from('  \n\t '), 'notes.md'), (e: any) => e.statusCode === 400 && /empty/.test(e.message));
});

test('markdown uploads are kept whole, regardless of size', () => {
  const doc = '# Synthetic design\n' + 'Line with U+2011 ‑ hyphen.\n'.repeat(20000);
  assert.equal(extractUploadText(Buffer.from(doc), 'design.md').content, doc);
});

test('xlsx: every sheet extracted, empty sheets reported, unreadable workbooks rejected', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['source', 'target'], ['CUST_ID', 'customer_id']]), 'Mapping');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Blank');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const result = extractUploadText(buffer, 'map.xlsx');
  assert.match(result.content, /--- Sheet: Mapping ---\nsource,target\nCUST_ID,customer_id/);
  assert.match(result.content, /--- Sheet: Blank ---/);
  assert.deepEqual(result.warnings, ['Sheet "Blank" is empty.']);

  const empty = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(empty, XLSX.utils.aoa_to_sheet([]), 'Only');
  assert.throws(() => extractUploadText(XLSX.write(empty, { type: 'buffer', bookType: 'xlsx' }), 'e.xlsx'),
    (e: any) => e.statusCode === 400);
  // A truncated zip container must not be stored as binary text.
  assert.throws(() => extractUploadText(buffer.subarray(0, 40), 'broken.xlsx'), (e: any) => e.statusCode === 400);
});

test('JSON is pretty-printed; invalid JSON is kept with a warning', () => {
  assert.equal(extractUploadText(Buffer.from('{"a":"‑"}'), 'c.json').content, '{\n  "a": "‑"\n}');
  assert.equal(extractUploadText(Buffer.from('{bad'), 'c.json').warnings.length, 1);
});

test('multer limit errors become 400s with a clear message', () => {
  const tooBig = uploadLimitError(Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' }));
  assert.equal((tooBig as any).statusCode, 400);
  assert.match(tooBig.message, /10 MB/);
  const other = new Error('boom');
  assert.equal(uploadLimitError(other), other);
});

test('upload middleware keeps non-ASCII (U+2011) filenames intact', async () => {
  const server = createServer((req, res) => {
    upload.array('files', 10)(req as any, res as any, (err: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(err ? { error: String(err) } : { names: ((req as any).files || []).map((f: any) => f.originalname) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const form = new FormData();
    form.append('files', new Blob(['# Synthetic design doc']), 'design‑doc é.md');
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: form });
    assert.deepEqual(await response.json(), { names: ['design‑doc é.md'] });
    const many = new FormData();
    for (let i = 0; i < 11; i++) many.append('files', new Blob(['x']), `f${i}.md`);
    const tooMany = await (await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: many })).json();
    assert.match(tooMany.error, /LIMIT_UNEXPECTED_FILE|Unexpected/);
  } finally {
    server.close();
  }
});

test('the 11th file maps to the file-count message', () => {
  const err = uploadLimitError(Object.assign(new Error('Unexpected file field'), { name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' }));
  assert.equal((err as any).statusCode, 400);
  assert.match(err.message, /at most 10 files/);
});

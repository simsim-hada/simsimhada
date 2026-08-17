// PICKFIT — 백업 / 복원
//
// 이 앱은 사진을 이 기기의 IndexedDB에만 둔다. iOS Safari는 한동안 방문이 없으면
// 사이트 저장 데이터를 지우므로, 백업 파일이 유일한 확실한 방어책이다.
// 사진을 base64로 JSON에 담으면 33% 불어나 무거워서 안 쓰게 되니, 무압축(store)
// ZIP으로 묶는다. 이미 압축된 PNG·JPEG라 deflate 이득도 없다. 라이브러리는 쓰지 않는다.
//
// 백업 파일 구조
//   meta.json            { app, version, createdAt, itemCount, wearCount, hasSource }
//   items.json           아이템 메타데이터 배열 (Blob 대신 cutoutFile/sourceFile 참조)
//   wears.json           착용 기록 배열
//   cutouts/<id>.png     누끼 이미지
//   sources/<id>.jpg     축소 원본 (includeSource일 때만)

import {
  getItems,
  addItem,
  getWears,
  addWear,
  getSetting,
  setSetting,
  clearAll,
  estimate,
  countByCategory,
} from './db.js';

/* ───────────────────────── 상수 ───────────────────────── */

const APP_ID = 'pickfit';
const BACKUP_VERSION = 1;
const FILE_PREFIX = 'pickfit-backup-';
const ZIP_MIME = 'application/zip';

const NAME_META = 'meta.json';
const NAME_ITEMS = 'items.json';
const NAME_WEARS = 'wears.json';
const DIR_CUTOUT = 'cutouts/';
const DIR_SOURCE = 'sources/';

// ZIP 시그니처와 레코드 크기
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;

const ZIP_VERSION = 20; // 2.0 — store/deflate 기본
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const EOCD_SCAN = EOCD_SIZE + U16_MAX; // 주석 최대 길이까지 뒤에서 훑는다
const ZIP64_LIMIT = U32_MAX; // 이 이상은 ZIP64가 필요하다 (지원하지 않는다)
const ZIP64_WARN = 0xc0000000; // 3GB — 넘으면 미리 경고

// 확장자 ↔ MIME. 파일명은 ASCII로만 쓴다(한글 파일명은 인코딩 플래그 문제가 있다)
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// 리마인더 기준
const K_LAST_AT = 'backup:lastAt';
const K_LAST_COUNT = 'backup:lastCount';
const REMIND_ADDED = 10; // 마지막 백업 이후 이 수를 넘게 등록하면 권유
const REMIND_DAYS = 30; // 이 일수를 넘으면 권유
const REMIND_FIRST = 5; // 백업 이력이 없을 때 이 수부터 권유
const DAY_MS = 86400000;

const YIELD_EVERY = 4; // 이 개수마다 이벤트 루프를 놓아준다 (화면 멈춤 방지)

/* ───────────────────────── 작은 도구들 ───────────────────────── */

const yieldTick = () => new Promise((r) => setTimeout(r, 0));

function u16(view, at) {
  return view.getUint16(at, true);
}
function u32(view, at) {
  return view.getUint32(at, true);
}
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function encodeText(s) {
  return new TextEncoder().encode(s);
}
function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}
function jsonBytes(value) {
  return encodeText(JSON.stringify(value));
}

// 파일명은 ASCII만. 범위를 벗어난 문자는 '_'로 바꾼다.
function asciiBytes(name) {
  const out = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    out[i] = c >= 0x20 && c <= 0x7e ? c : 0x5f;
  }
  return out;
}

function extOfMime(type, fallback) {
  return EXT_BY_MIME[String(type || '').toLowerCase()] || fallback;
}
function mimeOfName(name) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME_BY_EXT[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

// JSON에 담을 수 없는 값(Blob·버퍼 등)을 걸러낸 얕은 복사
function plainFields(rec) {
  const out = {};
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (v === undefined || typeof v === 'function') continue;
    if (typeof Blob !== 'undefined' && v instanceof Blob) continue;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) continue;
    out[key] = v;
  }
  return out;
}

// id를 파일명으로 쓸 수 있게 다듬고 중복을 피한다
function safeKey(id, index, used) {
  let base = id === undefined || id === null || id === '' ? `item-${index}` : String(id);
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || `item-${index}`;
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}-${n}`;
    n += 1;
  }
  used.add(key);
  return key;
}

function dateStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// DOS 형식 시각 (ZIP 헤더용)
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* ───────────────────────── CRC-32 ───────────────────────── */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/**
 * CRC-32 (IEEE 802.3). 이어서 계산하려면 앞의 결과를 prev로 넘긴다.
 * 검증 기준: crc32(new TextEncoder().encode('123456789')) === 0xCBF43926
 */
export function crc32(bytes, prev = 0) {
  const t = crcTable();
  let c = ~prev >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = (t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ~c >>> 0;
}

/* ───────────────────────── ZIP 쓰기 (store 전용) ───────────────────────── */

function localHeader(nameBytes, crc, size, dt) {
  const b = new Uint8Array(LOCAL_SIZE + nameBytes.length);
  const v = viewOf(b);
  v.setUint32(0, SIG_LOCAL, true);
  v.setUint16(4, ZIP_VERSION, true); // version needed
  v.setUint16(6, 0, true); // flags — ASCII 파일명이라 UTF-8 비트 불필요
  v.setUint16(8, METHOD_STORE, true);
  v.setUint16(10, dt.time, true);
  v.setUint16(12, dt.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true); // compressed
  v.setUint32(22, size, true); // uncompressed
  v.setUint16(26, nameBytes.length, true);
  v.setUint16(28, 0, true); // extra
  b.set(nameBytes, LOCAL_SIZE);
  return b;
}

function centralHeader(nameBytes, crc, size, dt, offset) {
  const b = new Uint8Array(CENTRAL_SIZE + nameBytes.length);
  const v = viewOf(b);
  v.setUint32(0, SIG_CENTRAL, true);
  v.setUint16(4, ZIP_VERSION, true); // version made by (MS-DOS)
  v.setUint16(6, ZIP_VERSION, true); // version needed
  v.setUint16(8, 0, true); // flags
  v.setUint16(10, METHOD_STORE, true);
  v.setUint16(12, dt.time, true);
  v.setUint16(14, dt.date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint16(30, 0, true); // extra
  v.setUint16(32, 0, true); // comment
  v.setUint16(34, 0, true); // disk number start
  v.setUint16(36, 0, true); // internal attrs
  v.setUint32(38, 0, true); // external attrs
  v.setUint32(42, offset, true); // local header 위치
  b.set(nameBytes, CENTRAL_SIZE);
  return b;
}

function eocdRecord(count, cdSize, cdOffset) {
  const b = new Uint8Array(EOCD_SIZE);
  const v = viewOf(b);
  v.setUint32(0, SIG_EOCD, true);
  v.setUint16(4, 0, true); // this disk
  v.setUint16(6, 0, true); // disk with central directory
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, 0, true); // comment length
  return b;
}

// 무압축 ZIP 작성기. 데이터는 Blob 조각을 그대로 참조해 메모리 복사를 피한다.
function createZipWriter(when = new Date()) {
  const dt = dosTime(when);
  const parts = []; // 최종 Blob의 조각들
  const central = [];
  const warnings = [];
  let offset = 0;
  let count = 0;

  function push(nameBytes, payloadPart, bytesForCrc, size) {
    if (count >= U16_MAX) throw new Error('[backup] 백업 항목이 너무 많습니다 (65535개 초과).');
    if (offset + LOCAL_SIZE + nameBytes.length + size > ZIP64_LIMIT) {
      throw new Error('[backup] 백업이 4GB를 넘어 만들 수 없습니다. "원본 포함"을 끄고 다시 시도해주세요.');
    }
    const crc = crc32(bytesForCrc);
    parts.push(localHeader(nameBytes, crc, size, dt));
    if (size > 0) parts.push(payloadPart);
    central.push({ nameBytes, crc, size, offset });
    offset += LOCAL_SIZE + nameBytes.length + size;
    count += 1;
    if (offset > ZIP64_WARN && !warnings.length) {
      warnings.push('백업 파일이 3GB를 넘었어요. 기기에서 열기 어려울 수 있으니 "원본 포함"을 끄는 게 좋아요.');
    }
  }

  return {
    warnings,
    /** Uint8Array를 항목으로 추가 */
    addBytes(name, bytes) {
      push(asciiBytes(name), bytes, bytes, bytes.length);
    },
    /** Blob을 항목으로 추가 — CRC 계산에만 바이트를 읽고, 저장은 Blob 참조로 둔다 */
    async addBlob(name, blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      push(asciiBytes(name), blob, bytes, bytes.length);
    },
    finish() {
      const cdOffset = offset;
      let cdSize = 0;
      for (const e of central) {
        const h = centralHeader(e.nameBytes, e.crc, e.size, dt, e.offset);
        parts.push(h);
        cdSize += h.length;
      }
      if (cdOffset + cdSize + EOCD_SIZE > ZIP64_LIMIT) {
        throw new Error('[backup] 백업이 4GB를 넘어 만들 수 없습니다. "원본 포함"을 끄고 다시 시도해주세요.');
      }
      parts.push(eocdRecord(count, cdSize, cdOffset));
      return new Blob(parts, { type: ZIP_MIME });
    },
  };
}

/* ───────────────────────── ZIP 읽기 (store 전용) ───────────────────────── */
// End of central directory를 뒤에서 찾아 central directory를 파싱하는 정석 방식.
// local header만 순차로 읽으면 깨진 파일에서 엉뚱하게 동작한다.

function entryName(bytes, flags) {
  if (flags & FLAG_UTF8) return decodeText(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

async function sliceBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function openZip(file, warnings) {
  if (!file || typeof file.slice !== 'function' || typeof file.arrayBuffer !== 'function') {
    throw new Error('[backup] 백업 파일(File/Blob)이 필요합니다.');
  }
  const size = file.size;
  if (size < EOCD_SIZE) throw new Error('[backup] 파일이 너무 작아 ZIP이 아닙니다.');

  // 1) EOCD 찾기
  const tailLen = Math.min(size, EOCD_SCAN);
  const tail = await sliceBytes(file, size - tailLen, size);
  const tv = viewOf(tail);
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i -= 1) {
    if (u32(tv, i) !== SIG_EOCD) continue;
    if (i + EOCD_SIZE + u16(tv, i + 20) === tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('[backup] ZIP 구조를 찾을 수 없습니다. 파일이 손상되었거나 백업 파일이 아닙니다.');

  const total = u16(tv, at + 10);
  const cdSize = u32(tv, at + 12);
  const cdOffset = u32(tv, at + 16);
  if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new Error('[backup] ZIP64 형식은 지원하지 않습니다.');
  }
  if (cdOffset + cdSize > size) {
    throw new Error('[backup] ZIP 목록 위치가 파일 범위를 벗어났습니다. 파일이 손상되었습니다.');
  }

  // 2) central directory 파싱
  const tailStart = size - tailLen;
  const cd =
    cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : await sliceBytes(file, cdOffset, cdOffset + cdSize);
  const cv = viewOf(cd);

  const entries = [];
  let p = 0;
  for (let n = 0; n < total; n += 1) {
    if (p + CENTRAL_SIZE > cd.length || u32(cv, p) !== SIG_CENTRAL) {
      warnings.push('ZIP 목록이 중간에 끊겨 있어 읽은 곳까지만 복원해요.');
      break;
    }
    const flags = u16(cv, p + 8);
    const nameLen = u16(cv, p + 28);
    const extraLen = u16(cv, p + 30);
    const cmtLen = u16(cv, p + 32);
    entries.push({
      name: entryName(cd.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLen), flags),
      flags,
      method: u16(cv, p + 10),
      crc: u32(cv, p + 16),
      csize: u32(cv, p + 20),
      usize: u32(cv, p + 24),
      offset: u32(cv, p + 42),
    });
    p += CENTRAL_SIZE + nameLen + extraLen + cmtLen;
  }
  if (!entries.length) throw new Error('[backup] ZIP 안에 항목이 없습니다.');
  return { file, size, entries };
}

// 이름 → 엔트리. 디렉터리 항목은 버리고, 중복 이름은 뒤에 온 것을 쓴다.
function indexEntries(zip, warnings) {
  const map = new Map();
  for (const e of zip.entries) {
    if (!e.name || e.name.endsWith('/')) continue;
    if (map.has(e.name)) warnings.push(`백업 안에 '${e.name}'이 여러 개 있어 마지막 것만 씁니다.`);
    map.set(e.name, e);
  }
  return map;
}

// 항목의 실제 데이터 구간을 구한다. 읽을 수 없으면 이유를 담아 돌려준다.
async function dataRange(zip, entry) {
  if (entry.flags & FLAG_ENCRYPTED) return { error: '암호가 걸려 있어' };
  if (entry.method === METHOD_DEFLATE) return { error: 'deflate로 압축돼 있어' };
  if (entry.method !== METHOD_STORE) return { error: `지원하지 않는 압축 방식(${entry.method})이라` };
  if (entry.offset + LOCAL_SIZE > zip.size) return { error: '위치가 파일 범위를 벗어나' };

  const lh = await sliceBytes(zip.file, entry.offset, entry.offset + LOCAL_SIZE);
  const lv = viewOf(lh);
  if (u32(lv, 0) !== SIG_LOCAL) return { error: '헤더가 깨져 있어' };
  const start = entry.offset + LOCAL_SIZE + u16(lv, 26) + u16(lv, 28);
  const end = start + entry.csize;
  if (end > zip.size) return { error: '데이터가 잘려 있어' };
  return { start, end };
}

// 항목을 읽고 CRC까지 확인한다. 성공하면 { bytes }, 실패하면 { error }
async function readEntry(zip, entry) {
  const range = await dataRange(zip, entry);
  if (range.error) return range;
  const bytes = await sliceBytes(zip.file, range.start, range.end);
  if (crc32(bytes) !== entry.crc) return { error: '내용이 손상돼(CRC 불일치)' };
  return { bytes, start: range.start, end: range.end };
}

// 이미지는 바이트를 들고 있지 않고 원본 파일을 참조하는 Blob으로 돌려준다(메모리 절약).
// CRC 확인을 위해 한 번 읽지만, 읽은 바이트는 바로 버린다.
async function readEntryBlob(zip, entry, type) {
  const got = await readEntry(zip, entry);
  if (got.error) return got;
  return { blob: zip.file.slice(got.start, got.end, type), bytes: got.bytes.length };
}

async function readEntryJson(zip, entry, label) {
  const got = await readEntry(zip, entry);
  if (got.error) return { error: `${label}을 읽지 못했어요 (${got.error})` };
  try {
    return { value: JSON.parse(decodeText(got.bytes)) };
  } catch {
    return { error: `${label}의 형식이 잘못됐어요` };
  }
}

/* ───────────────────────── 내보내기 ───────────────────────── */

/**
 * 옷장 전체를 무압축 ZIP으로 묶는다.
 * @param {{ includeSource?: boolean, onProgress?: (done:number,total:number)=>void }} opts
 *   includeSource: 축소 원본(sourceBlob)까지 포함. 기본은 누끼만 (가볍고 복원에 충분)
 * @returns {Promise<{ blob: Blob, filename: string, bytes: number, itemCount: number, warnings: string[] }>}
 */
export async function exportBackup(opts = {}) {
  const includeSource = opts.includeSource === true;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const items = await getItems();
  const wears = await getWears();
  const now = new Date();
  const writer = createZipWriter(now);
  const warnings = [];

  // 1) 파일 이름을 먼저 정해 items.json에 참조를 넣는다 (이미지 쓰기는 그다음)
  const used = new Set();
  const pending = []; // { name, blob }
  const metaItems = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const rec = plainFields(item);
    const key = safeKey(item.id, i, used);

    if (item.cutoutBlob instanceof Blob && item.cutoutBlob.size > 0) {
      const name = `${DIR_CUTOUT}${key}${extOfMime(item.cutoutBlob.type, '.png')}`;
      rec.cutoutFile = name;
      pending.push({ name, blob: item.cutoutBlob });
    } else {
      warnings.push(`${key}번 옷은 누끼 이미지가 없어 사진 없이 정보만 담았어요.`);
    }

    if (includeSource && item.sourceBlob instanceof Blob && item.sourceBlob.size > 0) {
      const name = `${DIR_SOURCE}${key}${extOfMime(item.sourceBlob.type, '.jpg')}`;
      rec.sourceFile = name;
      pending.push({ name, blob: item.sourceBlob });
    }
    metaItems.push(rec);
  }

  const total = pending.length + 1; // +1: json 쓰기 + 마무리
  let done = 0;
  const report = () => {
    if (onProgress) onProgress(Math.min(done, total), total);
  };
  report();

  // 2) 메타데이터 먼저 (사람이 열어봤을 때 위에 보인다)
  writer.addBytes(
    NAME_META,
    jsonBytes({
      app: APP_ID,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      itemCount: metaItems.length,
      wearCount: wears.length,
      hasSource: metaItems.some((r) => r.sourceFile),
    }),
  );
  writer.addBytes(NAME_ITEMS, jsonBytes(metaItems));
  writer.addBytes(NAME_WEARS, jsonBytes(wears.map(plainFields)));

  // 3) 이미지 — 한 장씩 읽어 담으며 진행률을 알린다
  for (let i = 0; i < pending.length; i += 1) {
    await writer.addBlob(pending[i].name, pending[i].blob);
    done += 1;
    report();
    if ((i + 1) % YIELD_EVERY === 0) await yieldTick();
  }

  const blob = writer.finish();
  warnings.push(...writer.warnings);
  done = total;
  report();

  // 리마인더 기준점 갱신
  await setSetting(K_LAST_AT, Date.now());
  await setSetting(K_LAST_COUNT, items.length);

  return {
    blob,
    filename: `${FILE_PREFIX}${dateStamp(now)}.zip`,
    bytes: blob.size,
    itemCount: metaItems.length,
    warnings,
  };
}

/* ───────────────────────── 훑어보기 ───────────────────────── */

/**
 * 복원 전에 내용만 확인한다 ("옷 42벌, 착용기록 130건" 을 보여주고 확인받기 위해).
 * @returns {Promise<{ itemCount:number, wearCount:number, createdAt:string|null,
 *                     hasSource:boolean, appVersion:number|null, warnings:string[] }>}
 */
export async function inspectBackup(file) {
  const warnings = [];
  const zip = await openZip(file, warnings);
  const index = indexEntries(zip, warnings);

  let meta = null;
  if (index.has(NAME_META)) {
    const got = await readEntryJson(zip, index.get(NAME_META), 'meta.json');
    if (got.error) warnings.push(got.error);
    else if (got.value && typeof got.value === 'object') meta = got.value;
  }
  if (meta && meta.app && meta.app !== APP_ID) {
    throw new Error(`[backup] PICKFIT 백업 파일이 아닙니다 (app: ${meta.app}).`);
  }
  if (!meta) warnings.push('meta.json이 없어 파일 목록으로 내용을 짐작했어요.');

  let itemCount = Number.isFinite(meta?.itemCount) ? meta.itemCount : null;
  let wearCount = Number.isFinite(meta?.wearCount) ? meta.wearCount : null;

  if (itemCount === null && index.has(NAME_ITEMS)) {
    const got = await readEntryJson(zip, index.get(NAME_ITEMS), 'items.json');
    if (Array.isArray(got.value)) itemCount = got.value.length;
  }
  if (wearCount === null && index.has(NAME_WEARS)) {
    const got = await readEntryJson(zip, index.get(NAME_WEARS), 'wears.json');
    if (Array.isArray(got.value)) wearCount = got.value.length;
  }
  if (itemCount === null) {
    itemCount = [...index.keys()].filter((n) => n.startsWith(DIR_CUTOUT)).length;
  }

  const hasSource =
    typeof meta?.hasSource === 'boolean'
      ? meta.hasSource
      : [...index.keys()].some((n) => n.startsWith(DIR_SOURCE));

  return {
    itemCount,
    wearCount: wearCount === null ? 0 : wearCount,
    createdAt: meta?.createdAt ?? null,
    hasSource,
    appVersion: Number.isFinite(meta?.version) ? meta.version : null,
    warnings,
  };
}

/* ───────────────────────── 복원 ───────────────────────── */

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 백업 ZIP을 IndexedDB에 되넣는다.
 * @param {Blob} file
 * @param {{ mode?: 'merge'|'replace', onProgress?: (done:number,total:number)=>void }} opts
 * @returns {Promise<{ items:number, wears:number, skipped:number, warnings:string[] }>}
 */
export async function importBackup(file, opts = {}) {
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const warnings = [];
  let skipped = 0;

  const zip = await openZip(file, warnings);
  const index = indexEntries(zip, warnings);

  // ── 검증 단계 ── clearAll()은 이 단계를 모두 통과한 뒤에만 부른다.
  // 깨진 파일 때문에 기존 옷장을 날리는 것이 최악의 결과다.
  if (index.has(NAME_META)) {
    const got = await readEntryJson(zip, index.get(NAME_META), 'meta.json');
    if (got.error) warnings.push(got.error);
    else if (got.value?.app && got.value.app !== APP_ID) {
      throw new Error(`[backup] PICKFIT 백업 파일이 아닙니다 (app: ${got.value.app}).`);
    }
  } else {
    warnings.push('meta.json이 없는 백업이에요. items.json만으로 복원합니다.');
  }

  if (!index.has(NAME_ITEMS)) throw new Error('[backup] items.json이 없어 복원할 수 없습니다.');
  const itemsJson = await readEntryJson(zip, index.get(NAME_ITEMS), 'items.json');
  if (itemsJson.error) throw new Error(`[backup] ${itemsJson.error}`);
  if (!Array.isArray(itemsJson.value)) throw new Error('[backup] items.json이 배열이 아닙니다.');
  const rawItems = itemsJson.value;

  let rawWears = [];
  if (index.has(NAME_WEARS)) {
    const got = await readEntryJson(zip, index.get(NAME_WEARS), 'wears.json');
    if (got.error) warnings.push(`${got.error} 착용 기록 없이 옷만 복원해요.`);
    else if (Array.isArray(got.value)) rawWears = got.value;
    else warnings.push('wears.json이 배열이 아니라 착용 기록은 건너뛰었어요.');
  }

  const total = rawItems.length * 2 + rawWears.length; // 읽기 + 쓰기 + 착용 기록
  let done = 0;
  const report = () => {
    if (onProgress) onProgress(Math.min(done, total), total);
  };
  report();

  // 이미지까지 실제로 읽어(CRC 확인 포함) 넣을 레코드를 미리 만든다
  const drafts = []; // { origId, record }
  for (let i = 0; i < rawItems.length; i += 1) {
    const raw = rawItems[i];
    const at = `${i + 1}번째 옷`;
    done += 1;
    if (i % YIELD_EVERY === 0) await yieldTick();
    report();

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1;
      warnings.push(`${at}은 형식이 잘못돼 건너뛰었어요.`);
      continue;
    }
    if (!isNonEmptyString(raw.category)) {
      skipped += 1;
      warnings.push(`${at}은 종류 정보가 없어 건너뛰었어요.`);
      continue;
    }
    if (!isNonEmptyString(raw.cutoutFile) || !index.has(raw.cutoutFile)) {
      skipped += 1;
      warnings.push(`${at}은 누끼 이미지가 백업에 없어 건너뛰었어요.`);
      continue;
    }

    const cut = await readEntryBlob(zip, index.get(raw.cutoutFile), mimeOfName(raw.cutoutFile));
    if (cut.error) {
      skipped += 1;
      warnings.push(`${at}의 누끼 이미지는 ${cut.error} 건너뛰었어요.`);
      continue;
    }

    const record = plainFields(raw);
    const origId = record.id;
    delete record.id; // 새 id를 발급받는다 (autoIncrement)
    delete record.cutoutFile;
    delete record.sourceFile;
    record.cutoutBlob = cut.blob;
    record.createdAt = Number(raw.createdAt) || Date.now();

    if (isNonEmptyString(raw.sourceFile)) {
      if (index.has(raw.sourceFile)) {
        const src = await readEntryBlob(zip, index.get(raw.sourceFile), mimeOfName(raw.sourceFile));
        if (src.error) warnings.push(`${at}의 축소 원본은 ${src.error} 빼고 복원해요.`);
        else record.sourceBlob = src.blob;
      } else {
        warnings.push(`${at}의 축소 원본이 백업에 없어 빼고 복원해요.`);
      }
    }

    drafts.push({ origId, record });
  }

  // 착용 기록도 미리 검사해둔다
  const wearDrafts = [];
  for (let i = 0; i < rawWears.length; i += 1) {
    const raw = rawWears[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.itemIds) || !raw.itemIds.length) {
      skipped += 1;
      warnings.push(`${i + 1}번째 착용 기록은 형식이 잘못돼 건너뛰었어요.`);
      continue;
    }
    wearDrafts.push(raw);
  }

  if (mode === 'replace' && !drafts.length && !wearDrafts.length) {
    throw new Error('[backup] 백업에서 복원할 내용을 찾지 못해 기존 데이터를 지우지 않았습니다.');
  }

  // ── 쓰기 단계 ──
  if (mode === 'replace') await clearAll();

  const idMap = new Map(); // 예전 id(문자열화) → 새 id
  let itemsAdded = 0;
  for (let i = 0; i < drafts.length; i += 1) {
    const { origId, record } = drafts[i];
    const newId = await addItem(record);
    if (origId !== undefined && origId !== null) idMap.set(String(origId), newId);
    itemsAdded += 1;
    done += 1;
    report();
    if ((i + 1) % YIELD_EVERY === 0) await yieldTick();
  }

  // 착용 기록의 itemIds를 새 id로 다시 매핑한다.
  // 이걸 빼먹으면 착용 이력이 엉뚱한 옷에 붙는다.
  let wearsAdded = 0;
  for (let i = 0; i < wearDrafts.length; i += 1) {
    const raw = wearDrafts[i];
    const mapped = [];
    let lost = 0;
    for (const old of raw.itemIds) {
      const found = idMap.get(String(old));
      if (found === undefined) lost += 1;
      else if (!mapped.includes(found)) mapped.push(found);
    }
    done += 1;
    report();
    if ((i + 1) % YIELD_EVERY === 0) await yieldTick();

    if (!mapped.length) {
      skipped += 1;
      warnings.push(`${i + 1}번째 착용 기록은 해당 옷이 복원되지 않아 건너뛰었어요.`);
      continue;
    }
    if (lost) warnings.push(`${i + 1}번째 착용 기록에서 복원되지 않은 옷 ${lost}벌은 빼고 넣었어요.`);

    const wear = plainFields(raw);
    delete wear.id;
    wear.itemIds = mapped;
    await addWear(wear);
    wearsAdded += 1;
  }

  done = total;
  report();

  // 방금 복원한 상태를 백업 기준점으로 삼는다 (복원 직후 리마인더가 뜨지 않게)
  if (mode === 'replace') {
    await setSetting(K_LAST_AT, Date.now());
    await setSetting(K_LAST_COUNT, itemsAdded);
  }

  return { items: itemsAdded, wears: wearsAdded, skipped, warnings };
}

/* ───────────────────────── 영구 저장 권한 ───────────────────────── */

function storageApi() {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null;
}

/**
 * navigator.storage.persist() 요청. 승인되면 브라우저 자동 회수 대상에서 빠진다.
 * @returns {Promise<{ granted: boolean, supported: boolean }>}
 */
export async function requestPersist() {
  const s = storageApi();
  if (!s || typeof s.persist !== 'function') return { granted: false, supported: false };
  try {
    if (typeof s.persisted === 'function' && (await s.persisted())) return { granted: true, supported: true };
    return { granted: (await s.persist()) === true, supported: true };
  } catch {
    return { granted: false, supported: true };
  }
}

/**
 * 현재 영구 저장 상태 (설정 화면 표시용). usage는 미지원 브라우저에서 null.
 * @returns {Promise<{ persisted: boolean, supported: boolean, usage: object|null }>}
 */
export async function persistState() {
  const s = storageApi();
  const supported = !!s && typeof s.persisted === 'function';
  let persisted = false;
  if (supported) {
    try {
      persisted = (await s.persisted()) === true;
    } catch {
      persisted = false;
    }
  }
  let usage = null;
  try {
    usage = await estimate();
  } catch {
    usage = null;
  }
  return { persisted, supported, usage };
}

/* ───────────────────────── 백업 리마인더 ───────────────────────── */

async function itemCount() {
  const byCat = await countByCategory(); // Blob을 읽지 않는 가벼운 집계
  return Object.values(byCat).reduce((a, b) => a + b, 0);
}

/**
 * 백업 권유가 필요한지 판단한다.
 * @returns {Promise<null|{ reason:'count'|'age', message:string }>}
 */
export async function backupReminder() {
  const count = await itemCount();
  const lastAt = Number(await getSetting(K_LAST_AT, 0)) || 0;
  const lastCount = Number(await getSetting(K_LAST_COUNT, 0)) || 0;

  if (!lastAt) {
    if (count < REMIND_FIRST) return null;
    return {
      reason: 'count',
      message: `옷 ${count}벌을 등록했는데 아직 백업하지 않았어요. 백업 파일을 저장해두세요`,
    };
  }

  const added = Math.max(0, count - lastCount);
  if (added > REMIND_ADDED) {
    return { reason: 'count', message: `등록한 옷 ${added}벌이 백업되지 않았어요` };
  }

  const days = Math.floor((Date.now() - lastAt) / DAY_MS);
  if (days > REMIND_DAYS) {
    return { reason: 'age', message: `마지막 백업이 ${days}일 전이에요. 새로 백업해주세요` };
  }
  return null;
}

// PICKFIT — IndexedDB 저장소
// 서버 없이 이 기기에만 저장한다. Blob은 변환 없이 그대로 넣는다.

const DB_NAME = 'pickfit';
const DB_VERSION = 1;

export const CATEGORIES = ['outer', 'top', 'bottom', 'dress', 'shoes', 'bag', 'acc'];

let dbPromise = null; // 커넥션 캐시 (모듈 수명 동안 1회만 open)

/* ───────────────────────── 공통 헬퍼 ───────────────────────── */

// IDBRequest → Promise. 모든 접근은 이 함수를 거친다.
function p(request, label = 'IndexedDB 요청') {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const e = request.error;
      reject(new Error(`[db] ${label} 실패: ${e ? `${e.name} ${e.message}` : '알 수 없는 오류'}`));
    };
  });
}

// 커서 순회. cb가 false를 반환하면 즉시 중단한다.
function each(request, cb, label = '커서 순회') {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cur = request.result;
      if (!cur) return resolve();
      let go;
      try {
        go = cb(cur);
      } catch (err) {
        return reject(err);
      }
      if (go === false) return resolve(); // 조기 종료
      cur.continue();
    };
    request.onerror = () => {
      const e = request.error;
      reject(new Error(`[db] ${label} 실패: ${e ? `${e.name} ${e.message}` : '알 수 없는 오류'}`));
    };
  });
}

// 트랜잭션 1개를 열고 fn을 돌린 뒤, 커밋이 끝나면 fn의 반환값으로 resolve.
// fn 안에서는 p()/each()를 연속으로 await 해도 된다(마이크로태스크라 트랜잭션이 살아 있음).
async function run(stores, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(stores) ? stores : [stores];
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, mode);
    } catch (err) {
      reject(new Error(`[db] 트랜잭션 열기 실패 (${names.join(',')}/${mode}): ${err.message}`));
      return;
    }
    let result;
    let failed = false;
    tx.oncomplete = () => {
      if (!failed) resolve(result);
    };
    tx.onerror = () => {
      failed = true;
      const e = tx.error;
      reject(new Error(`[db] 트랜잭션 오류 (${names.join(',')}): ${e ? `${e.name} ${e.message}` : '알 수 없는 오류'}`));
    };
    tx.onabort = () => {
      if (failed) return;
      failed = true;
      const e = tx.error;
      reject(new Error(`[db] 트랜잭션 중단 (${names.join(',')}): ${e ? `${e.name} ${e.message}` : '알 수 없는 이유'}`));
    };
    const abort = (err) => {
      failed = true;
      try {
        tx.abort();
      } catch {
        /* 이미 끝난 트랜잭션이면 무시 */
      }
      reject(err);
    };

    // fn은 같은 태스크 안에서 동기 호출해야 첫 요청이 트랜잭션 활성 구간에 들어간다
    let pending;
    try {
      pending = fn(tx);
    } catch (err) {
      abort(err);
      return;
    }
    Promise.resolve(pending).then((value) => {
      result = value;
    }, abort);
  });
}

/* ───────────────────────── open ───────────────────────── */

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('[db] 이 브라우저는 IndexedDB를 지원하지 않습니다.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        s.createIndex('category', 'category', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('wears')) {
        const s = db.createObjectStore('wears', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('retakes')) {
        db.createObjectStore('retakes', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 업그레이드를 시도하면 이쪽 커넥션을 놓아준다.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      const e = req.error;
      reject(new Error(`[db] '${DB_NAME}' 열기 실패: ${e ? `${e.name} ${e.message}` : '알 수 없는 오류'}`));
    };

    req.onblocked = () => {
      // 다른 탭이 예전 버전을 붙잡고 있는 경우
      reject(new Error(`[db] '${DB_NAME}' 열기가 다른 탭에 막혔습니다. 이 사이트의 다른 탭을 닫아주세요.`));
    };
  });

  return dbPromise;
}

/** DB 커넥션 확보 (다른 함수들이 내부적으로 호출하므로 직접 부를 필요는 없다) */
export async function open() {
  return openDB();
}

/* ───────────────────────── items ───────────────────────── */

function assertBlob(v, what) {
  if (!(v instanceof Blob)) throw new Error(`[db] ${what}에는 Blob이 필요합니다 (받은 값: ${typeof v}).`);
}

/** 옷 1벌 저장 → 저장된 id */
export async function addItem(item) {
  if (!item || typeof item !== 'object') throw new Error('[db] addItem: item 객체가 필요합니다.');
  assertBlob(item.cutoutBlob, 'addItem의 cutoutBlob');

  const rec = { ...item, createdAt: Number(item.createdAt) || Date.now() };
  if (rec.id === undefined || rec.id === null) delete rec.id; // autoIncrement에 맡긴다

  return run('items', 'readwrite', (tx) => p(tx.objectStore('items').add(rec), 'addItem'));
}

/** 전체 옷 목록 — createdAt 내림차순(최신 먼저) */
export async function getItems() {
  const list = await run('items', 'readonly', (tx) =>
    p(tx.objectStore('items').index('createdAt').getAll(), 'getItems'),
  );
  // 같은 createdAt이면 나중에 넣은 것(id 큰 쪽)이 먼저
  return list.sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));
}

/** 옷 1벌 조회 (없으면 undefined) */
export async function getItem(id) {
  return run('items', 'readonly', (tx) => p(tx.objectStore('items').get(id), `getItem(${id})`));
}

/** 옷 전체 덮어쓰기 (item.id 필수) */
export async function updateItem(item) {
  if (!item || item.id === undefined || item.id === null) {
    throw new Error('[db] updateItem: id가 있는 item이 필요합니다.');
  }
  return run('items', 'readwrite', (tx) => p(tx.objectStore('items').put(item), `updateItem(${item.id})`));
}

/** 옷 삭제 */
export async function deleteItem(id) {
  return run('items', 'readwrite', (tx) => p(tx.objectStore('items').delete(id), `deleteItem(${id})`));
}

/** 카테고리별 개수 → { outer: 2, top: 4, ... } (0인 카테고리도 포함) */
export async function countByCategory() {
  return run('items', 'readonly', async (tx) => {
    const idx = tx.objectStore('items').index('category');
    const out = {};
    for (const cat of CATEGORIES) {
      out[cat] = await p(idx.count(IDBKeyRange.only(cat)), `countByCategory(${cat})`);
    }
    return out;
  });
}

/* ───────────────────────── wears ───────────────────────── */

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'YYYY-MM-DD' → ms (로컬 자정). 형식이 아니면 null
function dateToMs(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** 착용 기록 저장 → id */
export async function addWear(wear) {
  if (!wear || typeof wear !== 'object') throw new Error('[db] addWear: wear 객체가 필요합니다.');
  const rec = {
    ...wear,
    itemIds: Array.isArray(wear.itemIds) ? wear.itemIds : [],
    date: wear.date || today(),
  };
  if (rec.id === undefined || rec.id === null) delete rec.id;
  return run('wears', 'readwrite', (tx) => p(tx.objectStore('wears').add(rec), 'addWear'));
}

/** 착용 기록 목록 — 최신 날짜 먼저 */
export async function getWears() {
  const list = await run('wears', 'readonly', (tx) =>
    p(tx.objectStore('wears').index('date').getAll(), 'getWears'),
  );
  return list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));
}

/** 그 옷을 마지막으로 입은 시각(ms). 기록이 없으면 null */
export async function lastWornAt(itemId) {
  return run('wears', 'readonly', async (tx) => {
    const cursorReq = tx.objectStore('wears').index('date').openCursor(null, 'prev');
    let found = null;
    await each(
      cursorReq,
      (cur) => {
        const w = cur.value;
        if (Array.isArray(w.itemIds) && w.itemIds.includes(itemId)) {
          found = dateToMs(w.date);
          return false; // 가장 최근 것 하나면 충분
        }
        return true;
      },
      `lastWornAt(${itemId})`,
    );
    return found;
  });
}

/* ───────────────────────── retakes ───────────────────────── */

/** 다시 찍어야 할 사진 기록 → id */
export async function addRetake(r) {
  if (!r || typeof r !== 'object') throw new Error('[db] addRetake: retake 객체가 필요합니다.');
  const rec = { ...r, createdAt: Number(r.createdAt) || Date.now() };
  if (rec.id === undefined || rec.id === null) delete rec.id;
  return run('retakes', 'readwrite', (tx) => p(tx.objectStore('retakes').add(rec), 'addRetake'));
}

/** 다시 찍을 사진 목록 — 최신 먼저 */
export async function getRetakes() {
  const list = await run('retakes', 'readonly', (tx) => p(tx.objectStore('retakes').getAll(), 'getRetakes'));
  return list.sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));
}

export async function deleteRetake(id) {
  return run('retakes', 'readwrite', (tx) => p(tx.objectStore('retakes').delete(id), `deleteRetake(${id})`));
}

export async function clearRetakes() {
  return run('retakes', 'readwrite', (tx) => p(tx.objectStore('retakes').clear(), 'clearRetakes'));
}

/* ───────────────────────── settings ───────────────────────── */

/** 설정 읽기. 없으면 fallback */
export async function getSetting(key, fallback = null) {
  const rec = await run('settings', 'readonly', (tx) =>
    p(tx.objectStore('settings').get(key), `getSetting(${key})`),
  );
  return rec === undefined ? fallback : rec.value;
}

/** 설정 쓰기 */
export async function setSetting(key, value) {
  await run('settings', 'readwrite', (tx) =>
    p(tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }), `setSetting(${key})`),
  );
  return value;
}

/* ───────────────────────── 용량 / 초기화 ───────────────────────── */

// 42.3 MB 처럼 사람이 읽는 문자열
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 저장 용량 추정. 미지원 브라우저면 null */
export async function estimate() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
  const est = await navigator.storage.estimate();
  const usage = Number(est.usage) || 0;
  const quota = Number(est.quota) || 0;
  return { usage, quota, usageText: fmtBytes(usage), quotaText: fmtBytes(quota) };
}

/** items/wears/retakes 비우기 (settings는 남긴다) */
export async function clearAll() {
  return run(['items', 'wears', 'retakes'], 'readwrite', async (tx) => {
    await p(tx.objectStore('items').clear(), 'clearAll(items)');
    await p(tx.objectStore('wears').clear(), 'clearAll(wears)');
    await p(tx.objectStore('retakes').clear(), 'clearAll(retakes)');
    return true;
  });
}

/* ───────────────────────── seed (개발용) ───────────────────────── */

// 색 밝기 조절. k<0 어둡게, k>0 밝게
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const f = (v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `#${ch.map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}

// 둥근 사각형 (ctx.roundRect 없는 환경 대비 직접 구현)
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
  ctx.fill();
}

// 상의: 몸통 + 양 소매 + 목
function drawTop(ctx, w, h, main, dark) {
  ctx.fillStyle = dark;
  rr(ctx, w * 0.02, h * 0.17, w * 0.23, h * 0.36, w * 0.07); // 왼소매
  rr(ctx, w * 0.75, h * 0.17, w * 0.23, h * 0.36, w * 0.07); // 오른소매
  ctx.fillStyle = main;
  rr(ctx, w * 0.21, h * 0.14, w * 0.58, h * 0.78, w * 0.06); // 몸통
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.16, w * 0.13, h * 0.045, 0, 0, Math.PI * 2); // 목선
  ctx.fill();
}

// 하의: 허리 + 두 갈래 다리
function drawBottom(ctx, w, h, main, dark) {
  ctx.fillStyle = main;
  rr(ctx, w * 0.11, h * 0.12, w * 0.35, h * 0.86, w * 0.05); // 왼다리
  rr(ctx, w * 0.54, h * 0.12, w * 0.35, h * 0.86, w * 0.05); // 오른다리
  rr(ctx, w * 0.11, h * 0.02, w * 0.78, h * 0.18, w * 0.05); // 엉덩이~허리
  ctx.fillStyle = dark;
  rr(ctx, w * 0.11, h * 0.02, w * 0.78, h * 0.055, w * 0.02); // 벨트
}

// 신발: 옆에서 본 형태 (가로로 길다)
function drawShoe(ctx, w, h, main, dark) {
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.moveTo(w * 0.09, h * 0.72);
  ctx.lineTo(w * 0.11, h * 0.3);
  ctx.quadraticCurveTo(w * 0.17, h * 0.18, w * 0.32, h * 0.22);
  ctx.lineTo(w * 0.47, h * 0.38);
  ctx.quadraticCurveTo(w * 0.72, h * 0.46, w * 0.93, h * 0.6);
  ctx.lineTo(w * 0.95, h * 0.74);
  ctx.lineTo(w * 0.09, h * 0.74);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  rr(ctx, w * 0.05, h * 0.72, w * 0.92, h * 0.19, h * 0.08); // 밑창
}

// 아우터: 상의보다 크고 앞이 트인 형태 (가운데가 투명)
function drawOuter(ctx, w, h, main, dark) {
  ctx.fillStyle = dark;
  rr(ctx, w * 0.01, h * 0.15, w * 0.2, h * 0.5, w * 0.06); // 왼소매
  rr(ctx, w * 0.79, h * 0.15, w * 0.2, h * 0.5, w * 0.06); // 오른소매
  ctx.fillStyle = main;
  rr(ctx, w * 0.17, h * 0.12, w * 0.31, h * 0.84, w * 0.05); // 왼쪽 앞판
  rr(ctx, w * 0.52, h * 0.12, w * 0.31, h * 0.84, w * 0.05); // 오른쪽 앞판 (사이가 트임)
  ctx.fillStyle = dark;
  rr(ctx, w * 0.17, h * 0.12, w * 0.31, h * 0.1, w * 0.03); // 왼쪽 카라
  rr(ctx, w * 0.52, h * 0.12, w * 0.31, h * 0.1, w * 0.03); // 오른쪽 카라
}

const DRAW = { top: drawTop, bottom: drawBottom, shoes: drawShoe, outer: drawOuter };
const SIZE = {
  top: [560, 600],
  bottom: [440, 700],
  shoes: [660, 330],
  outer: [620, 660],
};

// 알파 0이 아닌 영역만 남기고 잘라낸다 → 실제 aspect를 얻기 위함
function trim(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, w, h);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return canvas; // 아무것도 안 그려졌으면 원본
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function toBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('[db] seed: 캔버스를 Blob으로 만들지 못했습니다.'));
      },
      type,
      quality,
    );
  });
}

// 축소 보관본 흉내: 밝은 배경에 얹은 작은 JPEG
async function makeSource(cut) {
  const max = 256;
  const scale = Math.min(max / cut.width, max / cut.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cut.width * scale));
  c.height = Math.max(1, Math.round(cut.height * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#efeae3'; // 촬영 배경(단색 이불) 느낌
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(cut, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', 0.8);
}

// 더미 12벌 — 상의 4 / 하의 4 / 신발 2 / 아우터 2
const SEED_SPEC = [
  // 상의 4
  { shape: 'top', hex: '#F7F6F2', baseColor: 'white', baseLabel: '화이트', tone: 'light', chroma: 'neutral',
    seasons: ['spring', 'summer'], tpo: ['daily'], warmth: 1 },
  { shape: 'top', hex: '#F0E6D2', baseColor: 'ivory', baseLabel: '아이보리', tone: 'light', chroma: 'muted',
    seasons: ['spring', 'fall'], tpo: ['daily', 'work'], warmth: 2 },
  { shape: 'top', hex: '#1F2A44', baseColor: 'navy', baseLabel: '네이비', tone: 'dark', chroma: 'muted',
    seasons: ['fall', 'winter'], tpo: ['daily', 'work'], warmth: 3 },
  { shape: 'top', hex: '#3A3A3C', baseColor: 'charcoal', baseLabel: '차콜', tone: 'dark', chroma: 'neutral',
    seasons: ['fall', 'winter'], tpo: ['daily'], warmth: 3 },
  // 하의 4
  { shape: 'bottom', hex: '#4A6FA5', baseColor: 'blue', baseLabel: '블루', tone: 'mid', chroma: 'muted',
    seasons: ['spring', 'fall', 'winter'], tpo: ['daily'], warmth: 3 },
  { shape: 'bottom', hex: '#1A1A1C', baseColor: 'black', baseLabel: '블랙', tone: 'dark', chroma: 'neutral',
    seasons: ['spring', 'fall', 'winter'], tpo: ['work', 'date'], warmth: 3 },
  { shape: 'bottom', hex: '#D8C3A5', baseColor: 'beige', baseLabel: '베이지', tone: 'light', chroma: 'muted',
    seasons: ['spring', 'summer', 'fall'], tpo: ['daily', 'work'], warmth: 2 },
  { shape: 'bottom', hex: '#6B7355', baseColor: 'olive', baseLabel: '올리브', tone: 'mid', chroma: 'muted',
    seasons: ['spring', 'fall'], tpo: ['daily'], warmth: 2 },
  // 신발 2
  { shape: 'shoes', hex: '#FAFAF8', baseColor: 'white', baseLabel: '화이트', tone: 'light', chroma: 'neutral',
    seasons: ['spring', 'summer', 'fall'], tpo: ['daily'], warmth: 2 },
  { shape: 'shoes', hex: '#6E5140', baseColor: 'brown', baseLabel: '브라운', tone: 'dark', chroma: 'muted',
    seasons: ['spring', 'fall', 'winter'], tpo: ['work', 'date'], warmth: 2 },
  // 아우터 2
  { shape: 'outer', hex: '#C19A6B', baseColor: 'camel', baseLabel: '카멜', tone: 'mid', chroma: 'muted',
    seasons: ['spring', 'fall'], tpo: ['daily', 'date'], warmth: 4 },
  { shape: 'outer', hex: '#33363B', baseColor: 'charcoal', baseLabel: '차콜', tone: 'dark', chroma: 'neutral',
    seasons: ['winter'], tpo: ['daily', 'work'], warmth: 5 },
];

const SEED_IDS_KEY = 'seed:ids';

/**
 * 개발용 더미 옷 12벌 주입.
 * 이미 넣어둔 시드가 남아 있으면 아무것도 하지 않고 0을 반환한다.
 * @returns {Promise<number>} 새로 넣은 개수
 */
export async function seed() {
  if (typeof document === 'undefined') throw new Error('[db] seed: 브라우저(캔버스) 환경에서만 실행할 수 있습니다.');

  // 이미 시드가 살아 있는지 확인 (clearAll 이후엔 다시 넣을 수 있게 실제 존재 여부로 판단)
  const prev = await getSetting(SEED_IDS_KEY, null);
  if (Array.isArray(prev) && prev.length) {
    const alive = await run('items', 'readonly', async (tx) => {
      const st = tx.objectStore('items');
      let n = 0;
      for (const id of prev) {
        const key = await p(st.getKey(id), 'seed(중복확인)');
        if (key !== undefined) n += 1;
      }
      return n;
    });
    if (alive > 0) return 0;
  }

  // 캔버스 작업은 비동기(toBlob)라 트랜잭션 밖에서 먼저 끝낸다
  const base = Date.now();
  const records = [];
  for (let i = 0; i < SEED_SPEC.length; i += 1) {
    const spec = SEED_SPEC[i];
    const [w, h] = SIZE[spec.shape];
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[db] seed: 2d 컨텍스트를 얻지 못했습니다.');
    ctx.clearRect(0, 0, w, h); // 배경은 투명 유지

    const dark = shade(spec.hex, -0.18);
    DRAW[spec.shape](ctx, w, h, spec.hex, dark);

    const cut = trim(canvas);
    const cutoutBlob = await toBlob(cut, 'image/png');
    const sourceBlob = await makeSource(cut);

    records.push({
      createdAt: base - (SEED_SPEC.length - 1 - i) * 60000, // 최신순 정렬이 보이도록 1분씩 벌린다
      category: spec.shape,
      colors: [
        { hex: spec.hex, ratio: 0.86 },
        { hex: dark, ratio: 0.14 },
      ],
      baseColor: spec.baseColor,
      baseLabel: spec.baseLabel,
      tone: spec.tone,
      chroma: spec.chroma,
      seasons: spec.seasons,
      tpo: spec.tpo,
      warmth: spec.warmth,
      cutoutBlob,
      aspect: cut.width / cut.height,
      segMethod: 'seed',
      sourceBlob,
    });
  }

  const ids = await run('items', 'readwrite', async (tx) => {
    const st = tx.objectStore('items');
    const out = [];
    for (const rec of records) {
      out.push(await p(st.add(rec), 'seed(add)'));
    }
    return out;
  });

  await setSetting(SEED_IDS_KEY, ids);
  return ids.length;
}

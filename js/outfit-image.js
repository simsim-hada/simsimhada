/**
 * outfit-image.js — 추천 코디를 옷들을 합성한 한 장의 이미지로 만든다
 *
 * 재료는 각 아이템의 cutoutBlob(투명 배경 PNG, 여백 트림 완료)과
 * aspect(트림 후 너비/높이)다. 사진을 가까이서 찍었든 멀리서 찍었든
 * 실제 픽셀 크기는 쓰지 않고, palette.js 의 CATEGORIES.size 로만 크기를 정한다.
 *
 * 기준 축이 카테고리마다 다른 것이 이 파일의 핵심이다.
 * 신발·가방은 가로로 긴 형태라 높이를 맞추면 화면을 뒤덮는다 → 너비 기준.
 *
 * 공개 API: renderOutfit(items, opts) / renderOutfitToCanvas(items, opts)
 *           clearCache(itemId) / layoutOutfit(items, size)
 *
 * layoutOutfit 은 DOM 을 쓰지 않는 순수 함수로 분리해 두었다(Node 에서 검증 가능).
 */

import { CATEGORIES, hexToRgb, toHex } from './palette.js';

/* ────────────────────────────────────────────────────────────
 * 레이아웃 튜닝 상수 — 눈으로 보고 조정할 지점은 전부 여기 모아둔다
 * 단위는 CATEGORIES.size 와 같은 "정규화 단위"(상의 높이 = 100)다.
 * ──────────────────────────────────────────────────────────── */

/** 기본 캔버스 한 변(px). 정사각. */
const CANVAS_SIZE = 1024;

/** 캔버스 가장자리 여백 비율(한 쪽). 0.06 → 좌우 각 6% 를 비운다. */
const PAD_RATIO = 0.06;

/** 상의 밑단이 하의 허리를 덮는 정도(상의 높이 기준 비율). */
const TOP_BOTTOM_OVERLAP = 0.12;

/** 하의(또는 원피스) 밑단과 신발 사이 간격. */
const SHOES_GAP = 8;

/** 아우터 너비 중 상의를 덮는 비율. 열린 겉옷을 왼쪽에 걸쳐놓은 느낌을 낸다. */
const OUTER_OVERLAP_X = 0.34;

/** 아우터를 기준 아이템(상의/원피스)보다 살짝 위로 올리는 양. 어깨선이 위에 오게. */
const OUTER_Y_SHIFT = -6;

/** 코어 열(상·하의)과 오른쪽 소품 열 사이 간격. */
const SIDE_GAP = 12;

/** 소품끼리의 세로 간격. */
const SIDE_ITEM_GAP = 10;

/** 소품 열의 세로 위치. 0 = 코어 맨 위, 1 = 코어 맨 아래에 맞춤. */
const SIDE_V_ANCHOR = 0.42;

/** 코어에 들어갈 수 없는 아이템(중복 카테고리·알 수 없는 카테고리)을
 *  오른쪽 소품 열에 놓을 때 쓰는 너비. 상의 크기로 넣으면 구성이 무너진다. */
const SIDE_EXTRA_WIDTH = 42;

/** 배율 기준 높이. 풀 착장(원피스/상하의 + 신발)이 대략 캔버스를 채우는 값.
 *  이 기준 없이 "무조건 캔버스에 꽉 맞추기"로 하면 아이템 1개짜리 구성이
 *  캔버스만큼 커져서 카드끼리 크기감이 들쭉날쭉해진다. */
const REF_UNITS = 245;

/** aspect 이상값 방어 범위. 0·NaN·무한대가 들어와도 좌표가 깨지지 않게. */
const ASPECT_MIN = 0.2;
const ASPECT_MAX = 5;

/** 폴백(누끼 없음/디코딩 실패) 색 블록 */
const FALLBACK_COLOR = '#c9c4bd';
const FALLBACK_RADIUS_RATIO = 0.12; // 짧은 변 기준 모서리 반경
const FALLBACK_EDGE = 'rgba(0, 0, 0, 0.10)';

/* ────────────────────────────────────────────────────────────
 * 캐시 상한
 * ──────────────────────────────────────────────────────────── */

/** 아이템 비트맵 캐시 상한(개). 옷장 100벌을 다 물고 있지 않도록 제한한다. */
const BITMAP_CACHE_MAX = 64;

/** 합성 결과 캐시 상한(개). 추천 카드 3개 × 사이즈/배경 조합을 감안한 여유값. */
const OUTFIT_CACHE_MAX = 24;

/* ────────────────────────────────────────────────────────────
 * 배치 계산 — 순수 함수
 * ──────────────────────────────────────────────────────────── */

const CORE_KEYS = ['outer', 'top', 'bottom', 'dress', 'shoes'];
const SIDE_KEYS = new Set(['bag', 'acc']);
const CAT_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

function safeAspect(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, n));
}

/** 카테고리의 axis/size 를 그대로 따라 정규화 크기를 낸다. aspect = 너비/높이. */
function normSize(item, catKey) {
  const cat = CAT_BY_KEY.get(catKey);
  const aspect = safeAspect(item && item.aspect);
  if (cat && cat.axis === 'height') return { w: cat.size * aspect, h: cat.size };
  const width = cat ? cat.size : SIDE_EXTRA_WIDTH;
  return { w: width, h: width / aspect };
}

/** 소품 열에 놓을 크기. 코어용 카테고리가 밀려온 경우는 너비 기준으로 작게 줄인다. */
function sideSize(item, catKey) {
  const cat = CAT_BY_KEY.get(catKey);
  if (cat && cat.axis === 'width') return normSize(item, catKey);
  const aspect = safeAspect(item && item.aspect);
  return { w: SIDE_EXTRA_WIDTH, h: SIDE_EXTRA_WIDTH / aspect };
}

function rectOf(item, catKey, size) {
  return { item, id: item && item.id != null ? item.id : null, category: catKey, x: 0, y: 0, w: size.w, h: size.h };
}

/**
 * 착장 배치를 계산한다. DOM 을 쓰지 않는다.
 * @param {Array} items 착장 순서 배열
 * @param {number} size 캔버스 한 변(px)
 * @returns {Array<{item, id, category, x, y, w, h}>} 그리는 순서대로 정렬된 사각형들
 */
export function layoutOutfit(items, size = CANVAS_SIZE) {
  const canvas = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : CANVAS_SIZE;
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it === 'object') : [];

  // 1) 자리 배정 — 코어 슬롯은 선착순 1개, 나머지는 오른쪽 소품 열로
  const slot = { outer: null, top: null, bottom: null, dress: null, shoes: null };
  const side = [];
  for (const it of list) {
    const key = String(it.category || '');
    if (!SIDE_KEYS.has(key) && CORE_KEYS.includes(key) && slot[key] === null) slot[key] = it;
    else side.push(it);
  }
  // 원피스는 상의+하의 자리를 통째로 차지한다
  if (slot.dress) {
    if (slot.top) { side.push(slot.top); slot.top = null; }
    if (slot.bottom) { side.push(slot.bottom); slot.bottom = null; }
  }

  // 2) 세로 착장 순서로 코어를 쌓는다. 코어의 가로 중심은 x = 0.
  const rects = [];
  const centered = (r) => { r.x = -r.w / 2; return r; };

  const dress = slot.dress ? centered(rectOf(slot.dress, 'dress', normSize(slot.dress, 'dress'))) : null;
  const top = slot.top ? centered(rectOf(slot.top, 'top', normSize(slot.top, 'top'))) : null;
  const bottom = slot.bottom ? centered(rectOf(slot.bottom, 'bottom', normSize(slot.bottom, 'bottom'))) : null;
  const shoes = slot.shoes ? centered(rectOf(slot.shoes, 'shoes', normSize(slot.shoes, 'shoes'))) : null;
  const outer = slot.outer ? centered(rectOf(slot.outer, 'outer', normSize(slot.outer, 'outer'))) : null;

  let cursor = 0; // 다음 아이템이 시작할 y
  if (dress) {
    dress.y = 0;
    cursor = dress.h;
  } else {
    if (top) {
      top.y = 0;
      cursor = top.h;
    }
    if (bottom) {
      // 상의가 있으면 밑단과 살짝 겹치게 올려붙인다
      bottom.y = top ? top.h - top.h * TOP_BOTTOM_OVERLAP : 0;
      cursor = bottom.y + bottom.h;
    }
  }
  if (shoes) {
    // 위에 아무것도 없으면 간격 없이 맨 위에서 시작 (구성이 빠져도 빈 공간이 남지 않게)
    shoes.y = cursor > 0 ? cursor + SHOES_GAP : 0;
    cursor = shoes.y + shoes.h;
  }

  // 코어 묶음(소품 위치 기준) — 아우터는 왼쪽으로 튀어나가므로 여기서 제외한다
  const core = [dress, top, bottom, shoes].filter(Boolean);
  const coreTop = core.length ? Math.min(...core.map((r) => r.y)) : 0;
  const coreBottom = core.length ? Math.max(...core.map((r) => r.y + r.h)) : 0;
  const coreRight = core.length ? Math.max(...core.map((r) => r.x + r.w)) : 0;

  // 3) 아우터 — 상의(없으면 원피스/하의) 왼쪽에 겹쳐 걸쳐놓는다
  if (outer) {
    const anchor = top || dress || bottom;
    if (anchor) {
      outer.x = anchor.x - outer.w * (1 - OUTER_OVERLAP_X);
      outer.y = anchor.y + OUTER_Y_SHIFT;
    } else {
      outer.y = 0; // 아우터 단독이면 그냥 중앙
    }
  }

  // 4) 가방·액세서리 — 오른쪽 여백에 작게 세로로 쌓는다
  const sideRects = side.map((it) => {
    const key = String(it.category || '');
    return rectOf(it, CAT_BY_KEY.has(key) ? key : 'acc', sideSize(it, key));
  });
  if (sideRects.length) {
    const colW = Math.max(...sideRects.map((r) => r.w));
    const totalH =
      sideRects.reduce((s, r) => s + r.h, 0) + SIDE_ITEM_GAP * (sideRects.length - 1);
    const x0 = coreRight + SIDE_GAP;
    let y0 = coreTop + (coreBottom - coreTop - totalH) * SIDE_V_ANCHOR;
    for (const r of sideRects) {
      r.x = x0 + (colW - r.w) / 2;
      r.y = y0;
      y0 += r.h + SIDE_ITEM_GAP;
    }
  }

  // 5) 그리는 순서 = 겹침 순서. 하의 → 상의 → 아우터 → 신발 → 소품
  const ordered = [dress, bottom, top, outer, shoes, ...sideRects].filter(Boolean);
  if (!ordered.length) return [];

  // 6) 실제 크기를 재서 캔버스에 꼭 맞게 균일 배율로 축소하고 중앙 정렬
  const minX = Math.min(...ordered.map((r) => r.x));
  const maxX = Math.max(...ordered.map((r) => r.x + r.w));
  const minY = Math.min(...ordered.map((r) => r.y));
  const maxY = Math.max(...ordered.map((r) => r.y + r.h));
  const boxW = maxX - minX;
  const boxH = maxY - minY;

  const avail = canvas * (1 - 2 * PAD_RATIO);
  const fitW = boxW > 0 ? avail / boxW : Infinity;
  const fitH = boxH > 0 ? avail / boxH : Infinity;
  const scale = Math.min(avail / REF_UNITS, fitW, fitH);

  const offX = (canvas - boxW * scale) / 2 - minX * scale;
  const offY = (canvas - boxH * scale) / 2 - minY * scale;

  for (const r of ordered) {
    r.x = r.x * scale + offX;
    r.y = r.y * scale + offY;
    r.w *= scale;
    r.h *= scale;
  }
  return ordered;
}

/* ────────────────────────────────────────────────────────────
 * 캐시
 * ──────────────────────────────────────────────────────────── */

/** itemId → Promise<ImageBitmap|null>. Map 삽입 순서를 LRU 로 쓴다. */
const bitmapCache = new Map();

/** 합성 캐시 키 → { itemIds, canvasPromise, blob }. */
const outfitCache = new Map();

function touch(map, key) {
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

function closeBitmap(promise) {
  Promise.resolve(promise)
    .then((bm) => { if (bm && typeof bm.close === 'function') bm.close(); })
    .catch(() => {});
}

function evictBitmaps() {
  while (bitmapCache.size > BITMAP_CACHE_MAX) {
    const oldest = bitmapCache.keys().next().value;
    const promise = bitmapCache.get(oldest);
    bitmapCache.delete(oldest);
    closeBitmap(promise);
  }
}

function evictOutfits() {
  while (outfitCache.size > OUTFIT_CACHE_MAX) {
    outfitCache.delete(outfitCache.keys().next().value);
  }
}

/**
 * 아이템별 비트맵 캐시. 같은 옷이 여러 코디에 나오므로 id 기준으로 한 번만 디코딩한다.
 * 실패(누끼 없음·디코딩 오류)는 null 로 돌려주고 캐시하지 않는다.
 */
function getBitmap(item) {
  const blob = item && item.cutoutBlob;
  if (!blob || typeof Blob === 'undefined' || !(blob instanceof Blob)) return Promise.resolve(null);

  const id = item.id != null ? String(item.id) : null;
  if (id !== null && bitmapCache.has(id)) return touch(bitmapCache, id);

  const promise = decodeBitmap(blob).then((bm) => {
    if (!bm && id !== null && bitmapCache.get(id) === promise) bitmapCache.delete(id);
    return bm;
  });
  if (id !== null) {
    bitmapCache.set(id, promise);
    evictBitmaps();
  }
  return promise;
}

async function decodeBitmap(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    return null; // 폴백으로 처리한다 — 예외를 던지지 않는다
  }
}

/* ────────────────────────────────────────────────────────────
 * 그리기
 * ──────────────────────────────────────────────────────────── */

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function fallbackHex(item) {
  const colors = item && Array.isArray(item.colors) ? item.colors : null;
  const raw = colors && colors[0] ? colors[0].hex : null;
  if (typeof raw === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.trim())) {
    return toHex(...hexToRgb(raw));
  }
  return FALLBACK_COLOR;
}

/** 누끼가 없거나 디코딩이 실패한 자리 — 대표색 블록을 카테고리 크기대로 채운다. */
function drawFallback(ctx, box) {
  const r = Math.min(box.w, box.h) * FALLBACK_RADIUS_RATIO;
  roundRectPath(ctx, box.x, box.y, box.w, box.h, r);
  ctx.fillStyle = fallbackHex(box.item);
  ctx.fill();
  ctx.lineWidth = Math.max(1, Math.min(box.w, box.h) * 0.02);
  ctx.strokeStyle = FALLBACK_EDGE;
  ctx.stroke();
}

async function composite(items, size, background) {
  const boxes = layoutOutfit(items, size);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[outfit-image] 2d 컨텍스트를 얻지 못했습니다.');

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 디코딩은 병렬로 끝내고, 그리기는 순서대로 한 번에 한다
  const bitmaps = await Promise.all(boxes.map((b) => getBitmap(b.item)));
  boxes.forEach((box, i) => {
    const bm = bitmaps[i];
    if (!bm) { drawFallback(ctx, box); return; }
    try {
      ctx.drawImage(bm, box.x, box.y, box.w, box.h);
    } catch {
      // 다른 렌더가 캐시에서 밀어내며 close 한 비트맵일 수 있다 → 색 블록으로 대체
      drawFallback(ctx, box);
    }
  });

  return canvas;
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('[outfit-image] PNG 인코딩에 실패했습니다.'));
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

function copyCanvas(src) {
  // 캐시된 캔버스를 그대로 넘기면 두 곳에 붙일 수 없고(DOM 노드는 한 곳에만 존재)
  // 호출한 쪽이 덧그리면 캐시가 오염된다. 복사는 drawImage 한 번이라 싸다.
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (ctx) ctx.drawImage(src, 0, 0);
  return out;
}

/* ────────────────────────────────────────────────────────────
 * 공개 API
 * ──────────────────────────────────────────────────────────── */

function normOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const n = Math.round(Number(o.size));
  return {
    size: Number.isFinite(n) && n > 0 ? Math.max(64, n) : CANVAS_SIZE,
    background: typeof o.background === 'string' && o.background ? o.background : null,
    cacheKey: o.cacheKey != null ? String(o.cacheKey) : null,
  };
}

function itemIdsOf(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id != null)
    .map((it) => String(it.id));
}

/** 같은 조합이라도 크기·배경이 다르면 다른 그림이라 키에 함께 넣는다. */
function entryFor(items, o) {
  if (o.cacheKey === null) {
    return { itemIds: itemIdsOf(items), canvasPromise: composite(items, o.size, o.background), blob: null };
  }
  const key = `${o.cacheKey}::${o.size}::${o.background || 'transparent'}`;
  if (outfitCache.has(key)) return touch(outfitCache, key);

  const entry = {
    itemIds: itemIdsOf(items),
    canvasPromise: composite(items, o.size, o.background).catch((err) => {
      outfitCache.delete(key); // 실패한 결과를 캐시에 남기지 않는다
      throw err;
    }),
    blob: null,
  };
  outfitCache.set(key, entry);
  evictOutfits();
  return entry;
}

/**
 * 코디 조합 이미지를 PNG Blob 으로 만든다.
 * @param {Array} items 착장 순서 배열 (아우터, 상의, 하의 또는 원피스, 신발, 가방)
 * @param {{size?:number, background?:string|null, cacheKey?:string|null}} opts
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function renderOutfit(items, opts = {}) {
  const o = normOpts(opts);
  const entry = entryFor(items, o);
  const canvas = await entry.canvasPromise;
  if (!entry.blob) entry.blob = await canvasToPng(canvas);
  return { blob: entry.blob, width: canvas.width, height: canvas.height };
}

/**
 * 같은 합성을 캔버스로 돌려준다. 화면 표시용 — Blob 인코딩 비용이 없다.
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderOutfitToCanvas(items, opts = {}) {
  const o = normOpts(opts);
  const entry = entryFor(items, o);
  const canvas = await entry.canvasPromise;
  return o.cacheKey === null ? canvas : copyCanvas(canvas);
}

/**
 * 캐시 비우기. 옷을 수정·삭제·회전하면 그 아이템의 비트맵과
 * 그 아이템이 들어간 합성 결과를 함께 버려야 한다.
 * @param {string|number|null} itemId 없으면 전부 비운다
 */
export function clearCache(itemId = null) {
  if (itemId == null) {
    for (const promise of bitmapCache.values()) closeBitmap(promise);
    bitmapCache.clear();
    outfitCache.clear();
    return;
  }
  const id = String(itemId);
  if (bitmapCache.has(id)) {
    closeBitmap(bitmapCache.get(id));
    bitmapCache.delete(id);
  }
  for (const [key, entry] of outfitCache) {
    if (entry.itemIds.includes(id)) outfitCache.delete(key);
  }
}

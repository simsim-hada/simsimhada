// coordinator.js — 코디 조합 생성 + 점수 계산 엔진
// 순수 함수만 둡니다. DOM·IndexedDB에 접근하지 않습니다 (호출하는 쪽이 데이터를 넣어줍니다).
//
// 입구는 buildOutfits(items, context) 하나입니다.
// 보조로 seasonForTemp / warmthBandForTemp / closetGaps 를 함께 내보냅니다.

import {
  CATEGORIES,
  categoryLabel,
  harmonyScore,
} from './palette.js';

/* ============================================================
   1. 튜닝 상수 — 값을 만지는 곳은 전부 이 구역입니다
   ============================================================ */

/**
 * 기온대 → 조합 보온 점수 합계의 허용 구간.
 *
 * 보온 점수는 아이템당 1~5(기본값은 CATEGORIES.warmth)이고,
 * 한 코디는 보통 3~4벌(상의+하의+신발, 추울 때 +아우터)이 모입니다.
 * 그래서 합계는 "아주 가벼운 3벌 = 3~4" 에서 "겨울 4벌 = 15~17" 사이에 놓입니다.
 *
 * - from: 이 기온 이상일 때 이 구간을 쓴다 (내림차순으로 훑음)
 * - min/max: 허용 합계. mid: 가장 알맞은 합계 (기온 적합도 가점의 중심)
 *
 * 각 구간은 아래위로 3~4점씩 이웃 구간과 겹칩니다.
 * 겹치지 않게 딱 잘라두면 16°C→17°C 처럼 1도 차이로 추천이 전부 바뀌어 버립니다.
 */
export const WARMTH_BANDS = [
  // 28°C↑ 반팔+얇은 하의+샌들(1+1+1). 아우터가 끼면 바로 벗어나게 좁게 잡음
  { from: 28,        key: 'veryHot',  label: '아주 더움', min: 2,  max: 6,  mid: 4 },
  // 23~27°C 반팔+면바지+스니커즈(1+2+2). 얇은 겉옷 한 장까지 허용
  { from: 23,        label: '더움',    key: 'hot',        min: 3,  max: 8,  mid: 5.5 },
  // 17~22°C 긴팔+바지+신발(2+2+2). 얇은 가디건(3)까지
  { from: 17,        label: '따뜻함',  key: 'mild',       min: 5,  max: 10, mid: 7.5 },
  // 12~16°C 니트+바지+신발+얇은 겉옷 → PLAN 기준선(7~10)에 아래위 여유 1점
  { from: 12,        label: '선선함',  key: 'cool',       min: 6,  max: 11, mid: 8.5 },
  // 8~11°C 코트/자켓이 사실상 필수(3+3+2+4=12)
  { from: 8,         label: '쌀쌀함',  key: 'chilly',     min: 8,  max: 13, mid: 10.5 },
  // 5~7°C 두꺼운 겉옷 + 두꺼운 상의(4+3+3+2=12~15)
  { from: 5,         label: '추움',    key: 'cold',       min: 10, max: 15, mid: 12.5 },
  // 5°C↓ 패딩(5)+니트(4)+기모 하의(4)+부츠(2)=15 이상. 위쪽은 사실상 열어둠
  { from: -Infinity, label: '아주 추움', key: 'veryCold',  min: 12, max: 22, mid: 16 },
];

// 기온을 모를 때(tempC === null) 외부에서 warmthBandForTemp / seasonForTemp 를 부르면
// 이 값으로 답합니다. buildOutfits 는 tempC 가 없으면 기온·계절 필터 자체를 걸지 않습니다.
const FALLBACK_BAND_KEY = 'mild';
const FALLBACK_SEASON = 'spring';

// 기온 → 계절 경계 (한국 기준 체감. 옷장 태그와 맞추기 위한 값이라 기상학 정의와는 다릅니다)
const SEASON_BOUNDS = {
  SUMMER_FROM: 23, // 이 위는 여름 옷
  SPRINGISH: 11,   // 11~22°C 간절기
  WINTER_UNDER: 5, // 5°C 미만은 겨울 옷
};

// 점수 가중치 — 배색(harmonyScore 0~100)에 이 값들을 더하고 0~100으로 자릅니다
const W = {
  TEMP_FIT: 14,        // 허용 구간 중앙에 딱 맞을 때의 최대 가점
  RECENT_EACH: 7,      // 7일 내 착용 아이템 1벌당 감점
  RECENT_MAX: 18,      // 그 감점의 상한
  FRESH_EACH: 6,       // 30일 이상 방치 아이템 1벌당 가점
  FRESH_MAX: 14,
  NEVER_EACH: 3,       // 착용 기록이 아예 없는 아이템 1벌당 가벼운 가점
  NEVER_MAX: 6,
  JITTER: 6,           // 다양성 지터 폭(±3). seed 기반 결정적 난수
  OVERLAP_EACH: 9,     // 이미 뽑힌 코디와 겹치는 아이템 1벌당 순위 페널티(표시 점수엔 반영 안 함)
};

const DAY_MS = 86400000;
const RECENT_DAYS = 7;   // 이 안쪽에 입었으면 "최근에 입은 옷"
const FRESH_DAYS = 30;   // 이 이상 안 입었으면 "방치된 옷"

// 완화 단계에서 기온 허용 폭을 넓히는 양 (PLAN: ±3)
const TEMP_RELAX = 3;

// 후보 폭발 방지 상한. 상의20×하의20×신발10×아우터5×가방5 = 수십만이 되므로 반드시 잘라야 합니다.
// 옷 100벌 수준에서 체감 지연이 없도록 잡은 값입니다(조합 평가 1건이 수 µs).
const LIMITS = {
  POOL: { outer: 4, top: 14, bottom: 14, dress: 8, shoes: 5, bag: 3 },
  CORES: 72,       // (상의×하의) + 원피스 코어 상한
  COMBOS: 4000,    // 실제로 평가하는 조합 수 상한
  SELECT_POOL: 240, // 다양성 선별을 돌릴 상위 후보 수
};

const REASON_MAX = 3; // 추천 이유 문장 최대 개수

// 코디 성립·다양성 판단 기준
const TARGET_PER_CATEGORY = 2; // 상의·하의는 최소 2벌씩 있어야 조합이 심심하지 않습니다

// 착장 순서 — items 배열과 조합 id 의 순서를 이걸로 고정합니다
const WEAR_ORDER = ['outer', 'top', 'bottom', 'dress', 'shoes', 'bag', 'acc'];

// 액세서리는 아직 조합에 넣지 않습니다 (자리만 남겨둠)
const USE_ACC = false;

/* ============================================================
   2. 잔손 도구
   ============================================================ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

const CAT_WARMTH = new Map(CATEGORIES.map((c) => [c.key, c.warmth]));

/** 아이템의 보온 점수. 없으면 카테고리 기본값으로 메꿉니다. */
function warmthOf(item) {
  if (!item) return 0;
  const base = CAT_WARMTH.has(item.category) ? CAT_WARMTH.get(item.category) : 2;
  return clamp(num(Number(item.warmth), base), 0, 5);
}

function sumWarmth(list) {
  let n = 0;
  for (const it of list) n += warmthOf(it);
  return n;
}

/* --- 한국어 조사 --- */

function hasFinalConsonant(word) {
  const s = String(word || '');
  if (!s) return false;
  const code = s.charCodeAt(s.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return false; // 한글 음절이 아니면 없는 것으로 봅니다
  return (code - 0xac00) % 28 !== 0;
}

const josa = {
  subject: (w) => (hasFinalConsonant(w) ? '이' : '가'),   // ~이/가
  object: (w) => (hasFinalConsonant(w) ? '을' : '를'),    // ~을/를
  topic: (w) => (hasFinalConsonant(w) ? '은' : '는'),     // ~은/는
  copula: (w) => (hasFinalConsonant(w) ? '이에요' : '예요'),
  and: (w) => (hasFinalConsonant(w) ? '과' : '와'),
};

/** ['상의','하의'] → '상의와 하의' */
function joinKo(words) {
  if (words.length === 0) return '';
  return words.reduce((acc, w, i) => (i === 0 ? w : `${acc}${josa.and(acc)} ${w}`));
}

/** 아이템을 문장에서 부를 이름. '네이비 상의' 처럼 색+카테고리로 만듭니다. */
function itemLabel(item) {
  const color = String(item.baseLabel || '').trim();
  const cat = categoryLabel(item.category);
  return color ? `${color} ${cat}` : cat;
}

/* --- seed 기반 결정적 의사난수 (Math.random 금지) --- */

/** 문자열+seed → 32bit 해시 (FNV-1a 변형) */
function hash32(str, seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32bit 해시 → 0~1 (xorshift-multiply 마감) */
function unit(h) {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * 조합 키에 붙는 -폭/2 ~ +폭/2 지터.
 * 조합 id 로만 계산하므로 열거 순서가 바뀌어도, 같은 seed 면 같은 값이 나옵니다.
 */
function jitterFor(key, seed, width) {
  return (unit(hash32(key, seed)) - 0.5) * width;
}

/* ============================================================
   3. 공개 보조 함수
   ============================================================ */

/**
 * 기온 → 계절 키.
 * 기온을 모르면(null·NaN) 가장 폭이 넓은 '봄'(간절기)으로 답합니다.
 * @param {number|null} tempC
 * @returns {'spring'|'summer'|'fall'|'winter'}
 */
export function seasonForTemp(tempC) {
  const t = Number(tempC);
  if (!Number.isFinite(t)) return FALLBACK_SEASON;
  if (t >= SEASON_BOUNDS.SUMMER_FROM) return 'summer';
  if (t < SEASON_BOUNDS.WINTER_UNDER) return 'winter';
  // 간절기는 봄·가을 옷이 사실상 같은 자리를 쓰므로, 따뜻한 쪽을 봄 / 쌀쌀한 쪽을 가을로 봅니다
  return t >= SEASON_BOUNDS.SPRINGISH ? 'spring' : 'fall';
}

/**
 * 기온 → 조합 보온 합계의 허용 구간.
 * 기온을 모르면 '따뜻함'(17~22°C) 구간으로 답합니다.
 * @param {number|null} tempC
 * @returns {{ min:number, max:number, mid:number, key:string, label:string }}
 */
export function warmthBandForTemp(tempC) {
  const t = Number(tempC);
  const band = Number.isFinite(t)
    ? WARMTH_BANDS.find((b) => t >= b.from)
    : WARMTH_BANDS.find((b) => b.key === FALLBACK_BAND_KEY);
  const b = band || WARMTH_BANDS[WARMTH_BANDS.length - 1];
  return { min: b.min, max: b.max, mid: b.mid, key: b.key, label: b.label };
}

/** 허용 구간을 아래위로 pad 만큼 넓힌 사본 */
function widenBand(band, pad) {
  return {
    ...band,
    min: Math.max(0, band.min - pad),
    max: band.max + pad,
  };
}

/**
 * 옷장에 무엇이 부족한지.
 * 코디가 아예 안 되는 상태면 그것을, 되긴 하지만 심심한 상태면 다양성 부족을 알려줍니다.
 * 충분하면 null.
 * @returns {{ missing:{category:string,label:string,need:number}[], message:string }|null}
 */
export function closetGaps(items) {
  const gaps = analyzeCloset(items);
  if (!gaps) return null;
  return { missing: gaps.missing, message: gaps.message };
}

/** closetGaps 의 내부판 — blocking(코디 자체가 불가능한지) 까지 함께 돌려줍니다 */
function analyzeCloset(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const count = (key) => list.filter((it) => it.category === key).length;

  const nTop = count('top');
  const nBottom = count('bottom');
  const nDress = count('dress');

  // 코디 최소 조건: (상의+하의) 또는 원피스
  const blocking = !((nTop >= 1 && nBottom >= 1) || nDress >= 1);

  const entry = (category, have) => ({
    category,
    label: categoryLabel(category),
    need: Math.max(1, TARGET_PER_CATEGORY - have),
  });

  if (blocking) {
    // 없는 쪽만 지목합니다. 상의가 있고 하의가 없으면 하의만, 둘 다 없으면 둘 다.
    const missing = [];
    if (nTop === 0) missing.push(entry('top', nTop));
    if (nBottom === 0) missing.push(entry('bottom', nBottom));

    const labels = joinKo(missing.map((m) => m.label));
    const need = Math.max(...missing.map((m) => m.need));
    const each = missing.length > 1 ? '각각 ' : '';
    const message =
      `${labels}${josa.subject(labels)} 없어서 코디를 만들 수 없어요. ` +
      `${labels}${josa.object(labels)} ${each}${need}~${need + 1}벌 등록해주세요`;

    return { blocking: true, missing, message };
  }

  // 원피스만 2벌 이상 있으면 원피스 옷장으로 보고 상의·하의를 재촉하지 않습니다
  if (nDress >= TARGET_PER_CATEGORY) return null;

  const thin = [];
  if (nTop < TARGET_PER_CATEGORY) thin.push(entry('top', nTop));
  if (nBottom < TARGET_PER_CATEGORY) thin.push(entry('bottom', nBottom));
  if (thin.length === 0) return null;

  const labels = joinKo(thin.map((m) => m.label));
  const need = Math.max(...thin.map((m) => m.need));
  const message =
    `${labels}${josa.subject(labels)} ${need}~${need + 1}벌 더 있으면 ` +
    '코디를 훨씬 다양하게 만들 수 있어요';

  return { blocking: false, missing: thin, message };
}

/* ============================================================
   4. 후보 만들기
   ============================================================ */

/** 아이템 하나가 상황(TPO)·계절 조건을 만족하는지 */
function itemPasses(item, tpo, season) {
  if (tpo) {
    const tags = Array.isArray(item.tpo) ? item.tpo : [];
    if (!tags.includes(tpo)) return false;
  }
  if (season) {
    const tags = Array.isArray(item.seasons) ? item.seasons : [];
    if (!tags.includes(season)) return false;
  }
  return true;
}

/**
 * 상한에 걸렸을 때 무엇을 남길지 결정하는 아이템 단위 사전점수.
 * 기온에 맞는 두께 + 오래 안 입은 옷을 우선으로 남기고, 지터로 매번 조금 섞습니다.
 */
function prescore(item, band, recency, seed) {
  const ideal = band ? clamp(band.mid / 3.2, 1, 5) : 2.5; // 한 코디에 3벌 남짓이 모인다고 보고 나눔
  const align = -5 * Math.abs(warmthOf(item) - ideal);
  const r = recency(item.id);
  const fresh = r.days === null ? 4 : clamp(r.days / 6, 0, 10);
  return align + fresh + jitterFor(`p:${item.id}`, seed, 4);
}

function poolsFor(items, band, tpo, season, recency, seed) {
  const byCat = new Map();
  for (const key of WEAR_ORDER) byCat.set(key, []);

  for (const item of items) {
    if (!item || !byCat.has(item.category)) continue;
    if (!itemPasses(item, tpo, season)) continue;
    byCat.get(item.category).push(item);
  }

  let truncated = false;
  for (const [key, list] of byCat) {
    const cap = LIMITS.POOL[key];
    // id 로 먼저 안정 정렬해 두면 사전점수가 같아도 결과가 흔들리지 않습니다
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!cap || list.length <= cap) continue;
    list.sort((a, b) => prescore(b, band, recency, seed) - prescore(a, band, recency, seed));
    list.length = cap;
    truncated = true;
  }

  return { pools: byCat, truncated };
}

/** 코디의 뼈대 — (상의+하의) 또는 (원피스) */
function buildCores(pools, seed) {
  const cores = [];
  const tops = pools.get('top');
  const bottoms = pools.get('bottom');

  for (const top of tops) {
    for (const bottom of bottoms) {
      cores.push({ parts: { top, bottom }, list: [top, bottom] });
    }
  }
  for (const dress of pools.get('dress')) {
    cores.push({ parts: { dress }, list: [dress] });
  }

  if (cores.length <= LIMITS.CORES) return { cores, truncated: false };

  // 상한을 넘으면 배색이 좋은 뼈대부터 남깁니다 (지터로 매번 조금 섞임)
  for (const core of cores) {
    core._key = comboId(core.parts);
    core._pre = harmonyScore(core.list).score + jitterFor(`c:${core._key}`, seed, 8);
  }
  cores.sort((a, b) => b._pre - a._pre || (a._key < b._key ? -1 : 1));
  cores.length = LIMITS.CORES;
  return { cores, truncated: true };
}

/**
 * 뼈대에 얹을 선택 항목 조합 — (아우터|없음) × (신발|없음) × (가방|없음).
 * 가방을 가장 바깥 축에 두어, 상한에 걸려도 아우터×신발 조합은 먼저 다 훑게 합니다.
 */
function buildVariants(pools) {
  const outers = [null, ...pools.get('outer')];
  const shoes = [null, ...pools.get('shoes')];
  const bags = [null, ...pools.get('bag')];

  const variants = [];
  for (const bag of bags) {
    for (const outer of outers) {
      for (const shoe of shoes) {
        variants.push({ outer, shoes: shoe, bag });
      }
    }
  }
  return variants;
}

/** 조합 → 안정적인 id. 같은 조합이면 항상 같은 문자열입니다. */
function comboId(parts) {
  const bits = [];
  for (const key of WEAR_ORDER) {
    const it = parts[key];
    if (it) bits.push(`${key}${it.id}`);
  }
  return bits.join('-');
}

/** 조합 → 착장 순서 아이템 배열 */
function orderedItems(parts) {
  const out = [];
  for (const key of WEAR_ORDER) {
    if (parts[key]) out.push(parts[key]);
  }
  return out;
}

/* ============================================================
   5. 점수
   ============================================================ */

/** lastWorn 맵을 (itemId → { days }) 조회 함수로 감쌉니다. days 는 기록이 없으면 null */
function recencyReader(lastWorn, now) {
  const get = (id) => {
    if (!lastWorn) return null;
    if (typeof lastWorn.get === 'function') return lastWorn.get(id) ?? null;
    return lastWorn[id] ?? null;
  };
  return (id) => {
    const raw = get(id);
    // null·undefined 는 "기록 없음" 입니다. Number(null) 이 0 이 되어
    // 1970년부터 안 입은 옷으로 읽히는 사고를 막기 위해 먼저 걸러냅니다.
    if (raw === null || raw === undefined || raw === '') return { days: null };
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return { days: null };
    return { days: Math.max(0, (now - ms) / DAY_MS) };
  };
}

/**
 * 조합 하나의 점수와 이유 문장.
 * band 는 지금 적용 중인 허용 구간, strictBand 는 완화 전 원래 구간입니다.
 * 기온 이유 문장은 "원래 구간" 안에 들어올 때만 붙입니다 — 완화해서 찾은 조합에
 * "오늘 기온에 맞아요" 라고 말하면 실제와 어긋나기 때문입니다.
 */
function scoreCombo(items, id, ctx) {
  const { tempC, strictBand, band, recency, seed } = ctx;

  const harmony = harmonyScore(items);
  let score = harmony.score;

  // 기온 적합도 — 허용 구간 중앙에 가까울수록 가점
  const warmthSum = sumWarmth(items);
  let tempReason = null;
  if (band) {
    const half = Math.max(1, (band.max - band.min) / 2);
    const fit = Math.max(0, 1 - Math.abs(warmthSum - band.mid) / half);
    score += W.TEMP_FIT * fit;
    const inStrict = strictBand && warmthSum >= strictBand.min && warmthSum <= strictBand.max;
    if (inStrict && Number.isFinite(tempC)) {
      tempReason = `오늘 ${Math.round(tempC)}°C에 맞는 보온감이에요`;
    }
  }

  // 최근 착용
  let recent = 0;
  let fresh = 0;
  let never = 0;
  let freshest = null;  // 가장 오래 방치된 아이템
  let neverItem = null; // 착용 기록이 아예 없는 첫 아이템
  for (const item of items) {
    const { days } = recency(item.id);
    if (days === null) {
      never += 1;
      if (!neverItem) neverItem = item;
      continue;
    }
    if (days <= RECENT_DAYS) recent += 1;
    else if (days >= FRESH_DAYS) {
      fresh += 1;
      if (!freshest || days > freshest.days) freshest = { item, days };
    }
  }
  score -= Math.min(W.RECENT_MAX, W.RECENT_EACH * recent);
  score += Math.min(W.FRESH_MAX, W.FRESH_EACH * fresh);
  score += Math.min(W.NEVER_MAX, W.NEVER_EACH * never);

  let freshReason = null;
  if (freshest) {
    const label = itemLabel(freshest.item);
    freshReason = `이 ${label}${josa.topic(label)} ${Math.floor(freshest.days)}일째 안 입으셨어요`;
  } else if (neverItem) {
    // 착용 기록이 없어 며칠째인지 말할 수 없는 경우 — 날짜를 지어내지 않고 사실만 적습니다
    const label = itemLabel(neverItem);
    freshReason = `아직 한 번도 안 입으신 ${label}${josa.copula(label)}`;
  }

  // 다양성 지터 — seed + 조합 id 로만 결정되므로 같은 seed 면 항상 같은 값
  score += jitterFor(id, seed, W.JITTER);

  // 이유 문장 — 배색 1개 → 기온 → 방치 → 남는 자리에 배색 추가
  const reasons = [];
  if (harmony.reasons[0]) reasons.push(harmony.reasons[0]);
  if (tempReason) reasons.push(tempReason);
  if (freshReason) reasons.push(freshReason);
  for (let i = 1; i < harmony.reasons.length && reasons.length < REASON_MAX; i++) {
    reasons.push(harmony.reasons[i]);
  }

  return {
    // raw: 순위 계산용 원점수. 0~100으로 자르기 전 값이라야 상위권이 100에 뭉치지 않습니다
    raw: score,
    score: clamp(Math.round(score), 0, 100),
    reasons: reasons.slice(0, REASON_MAX),
  };
}

/* ============================================================
   6. 한 판 돌리기 (필터 한 세트 = search 한 번)
   ============================================================ */

function search(items, opts) {
  const { band, strictBand, tpo, season, tempC, recency, seed } = opts;

  const { pools, truncated: poolCut } = poolsFor(items, band || strictBand, tpo, season, recency, seed);
  const { cores, truncated: coreCut } = buildCores(pools, seed);
  if (cores.length === 0) {
    return { found: [], generated: 0, capped: false, cores: 0 };
  }

  const variants = buildVariants(pools);
  const found = [];
  const seen = new Set();
  let generated = 0;
  let capped = false;

  // variant 를 바깥, core 를 안쪽으로 돌립니다.
  // 상한에 걸려도 모든 뼈대가 같은 수의 변형을 받아, 한 뼈대만 파고드는 일이 없습니다.
  outer: for (const variant of variants) {
    for (const core of cores) {
      if (generated >= LIMITS.COMBOS) {
        capped = true;
        break outer;
      }
      generated += 1;

      const parts = { ...core.parts };
      if (variant.outer) parts.outer = variant.outer;
      if (variant.shoes) parts.shoes = variant.shoes;
      if (variant.bag) parts.bag = variant.bag;

      const list = orderedItems(parts);

      // 기온 필터 — 보온 합계가 허용 구간 밖이면 버립니다 (점수 계산 전에 걸러 싸게 끝냄)
      if (band) {
        const sum = sumWarmth(list);
        if (sum < band.min || sum > band.max) continue;
      }

      const id = comboId(parts);
      if (seen.has(id)) continue;
      seen.add(id);

      const scored = scoreCombo(list, id, { tempC, band, strictBand, recency, seed });
      found.push({ id, items: list, score: scored.score, reasons: scored.reasons, raw: scored.raw });
    }
  }

  return { found, generated, capped: capped || poolCut || coreCut, cores: cores.length };
}

/**
 * 점수 상위에서 아이템 겹침이 적은 쪽을 골라 count 개를 뽑습니다.
 * 순위는 자르지 않은 원점수(raw)로 매기고, 겹침 페널티는 순서에만 반영합니다
 * (표시 점수를 깎으면 사용자에게 이유를 설명할 수 없는 감점이 됩니다).
 */
function pickDiverse(found, count) {
  const pool = found
    .slice()
    .sort((a, b) => b.raw - a.raw || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, LIMITS.SELECT_POOL);

  const picked = [];
  const used = new Map(); // itemId → 이미 뽑힌 코디에서 쓰인 횟수

  while (picked.length < count && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let overlap = 0;
      for (const it of cand.items) overlap += used.get(it.id) || 0;
      const val = cand.raw - W.OVERLAP_EACH * overlap;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0];
    picked.push(chosen);
    for (const it of chosen.items) used.set(it.id, (used.get(it.id) || 0) + 1);
  }

  // 내부용 raw 는 떼고 넘깁니다
  return picked.map(({ id, items, score, reasons }) => ({ id, items, score, reasons }));
}

/* ============================================================
   7. 완화 안내 문장
   ============================================================ */

const RELAX_CAUSE = {
  tpo: '상황에 딱 맞는 옷이 부족해요',
  temp: '기온에 딱 맞는 보온감이 부족해요',
  season: '이 계절 옷이 부족해요',
};

function relaxedNoteFor(relaxed) {
  if (!relaxed.length) return null;
  const causes = relaxed.map((k) => RELAX_CAUSE[k]).filter(Boolean);
  return `조건을 조금 넓혀서 찾았어요 — ${causes.join(', ')}`;
}

/* ============================================================
   8. 입구
   ============================================================ */

/**
 * 옷장 + 오늘의 조건 → 코디 추천.
 * @param {Array} items 옷장 전체
 * @param {{ tempC?:number|null, tpo?:string|null, lastWorn?:Map, now?:number, seed?:number, count?:number }} context
 * @returns {{ outfits:Array, relaxed:string[], relaxedNote:string|null, shortage:object|null, meta:object }}
 */
export function buildOutfits(items, context) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const ctx = context || {};

  const tempC = Number.isFinite(Number(ctx.tempC)) && ctx.tempC !== null ? Number(ctx.tempC) : null;
  const tpo = ctx.tpo || null;
  const seed = num(Number(ctx.seed), 0) | 0;
  const count = Math.max(1, Math.floor(num(Number(ctx.count), 3)));
  const now = num(Number(ctx.now), Date.now());
  const recency = recencyReader(ctx.lastWorn, now);

  // 기온을 모르면 기온·계절 필터를 걸지 않습니다 (날씨 실패 시에도 추천이 막히지 않아야 합니다)
  const strictBand = tempC === null ? null : warmthBandForTemp(tempC);
  const season = tempC === null ? null : seasonForTemp(tempC);

  // 완화 단계 — ① 상황 해제 → ② 기온 폭 ±3 확대 → ③ 기온·계절 해제
  const stages = [{ relaxed: [], tpo, band: strictBand, season }];
  if (tpo) stages.push({ relaxed: ['tpo'], tpo: null, band: strictBand, season });
  if (strictBand) {
    stages.push({
      relaxed: [...(tpo ? ['tpo'] : []), 'temp'],
      tpo: null,
      band: widenBand(strictBand, TEMP_RELAX),
      season,
    });
  }
  if (strictBand || season) {
    stages.push({
      relaxed: [...(tpo ? ['tpo'] : []), ...(strictBand ? ['temp'] : []), ...(season ? ['season'] : [])],
      tpo: null,
      band: null,   // 기온 필터 완전 해제
      season: null, // 계절 필터 해제
    });
  }

  const meta = {
    season,
    band: strictBand,
    stages: 0,
    generated: 0,
    cores: 0,
    candidates: 0,
    capped: false, // 후보 상한에 걸려 일부 조합을 보지 못했다는 표시
  };

  for (const stage of stages) {
    meta.stages += 1;
    const res = search(list, {
      band: stage.band,
      strictBand,
      tpo: stage.tpo,
      season: stage.season,
      tempC,
      recency,
      seed,
    });

    meta.generated += res.generated;
    meta.cores = Math.max(meta.cores, res.cores);
    if (res.capped) meta.capped = true;

    // 완화는 "0건일 때만" 합니다. 옷장이 얇으면 count 보다 적게 나올 수 있는데,
    // 그건 정상입니다 — 12°C에 상의+하의 두 벌짜리 조합을 억지로 채워 넣고
    // "오늘 기온에 맞아요" 라고 하면 추천 이유가 거짓이 됩니다.
    // relaxedNote 도 코디별이 아니라 결과 전체에 한 문장이라, 일부만 완화하면 설명이 어긋납니다.
    if (res.found.length === 0) continue;

    meta.candidates = res.found.length;
    const relaxed = stage.relaxed;
    return {
      outfits: pickDiverse(res.found, count),
      relaxed,
      relaxedNote: relaxedNoteFor(relaxed),
      shortage: null,
      meta,
    };
  }

  // 전부 풀어도 0건 — 무엇이 몇 벌 부족한지 짚어줍니다
  const gaps = analyzeCloset(list);
  const shortage = gaps && gaps.blocking
    ? { missing: gaps.missing, message: gaps.message }
    : {
        missing: [],
        message: '조건에 맞는 조합을 찾지 못했어요. 옷을 몇 벌 더 등록해주세요',
      };

  return {
    outfits: [],
    relaxed: stages.length > 1 ? stages[stages.length - 1].relaxed : [],
    relaxedNote: null,
    shortage,
    meta,
  };
}

// 액세서리 자리 — 지금은 조합에 넣지 않습니다. 넣게 되면 WEAR_ORDER 에 이미 자리가 있고
// buildVariants 에 축 하나만 더하면 됩니다 (조합 수가 다시 배로 늘어나므로 LIMITS 도 함께 조정).
export const ACC_ENABLED = USE_ACC;

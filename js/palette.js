// palette.js — 색 도메인 + 앱 공통 상수
// 순수 함수만 둡니다. DOM·저장소에 접근하지 않습니다.

/* ============================================================
   1. 앱 공통 상수
   ============================================================ */

// warmth: 보온 기본점수(기온 추천에서 합산), axis/size: 조합 이미지에서의 정규화 기준
export const CATEGORIES = [
  { key: 'outer',  label: '아우터',   warmth: 4, axis: 'height', size: 110 },
  { key: 'top',    label: '상의',     warmth: 2, axis: 'height', size: 100 },
  { key: 'bottom', label: '하의',     warmth: 2, axis: 'height', size: 115 },
  { key: 'dress',  label: '원피스',   warmth: 2, axis: 'height', size: 150 },
  { key: 'shoes',  label: '신발',     warmth: 1, axis: 'width',  size: 55  },
  { key: 'bag',    label: '가방',     warmth: 0, axis: 'width',  size: 45  },
  { key: 'acc',    label: '액세서리', warmth: 0, axis: 'width',  size: 30  },
];

export const SEASONS = [
  { key: 'spring', label: '봄' },
  { key: 'summer', label: '여름' },
  { key: 'fall',   label: '가을' },
  { key: 'winter', label: '겨울' },
];

export const TPOS = [
  { key: 'daily',  label: '데일리' },
  { key: 'work',   label: '직장' },
  { key: 'date',   label: '데이트' },
  { key: 'active', label: '운동' },
  { key: 'formal', label: '포멀' },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const SEASON_KEYS = SEASONS.map((s) => s.key);
export const TPO_KEYS = TPOS.map((t) => t.key);

// 조회는 매번 find 하지 않도록 한 번만 맵으로 만들어 둡니다.
const CAT_MAP = new Map(CATEGORIES.map((c) => [c.key, c]));
const SEASON_MAP = new Map(SEASONS.map((s) => [s.key, s]));
const TPO_MAP = new Map(TPOS.map((t) => [t.key, t]));

export function categoryOf(key) {
  return CAT_MAP.get(key) || null;
}
export function categoryLabel(key) {
  const c = CAT_MAP.get(key);
  return c ? c.label : '기타';
}
export function seasonOf(key) {
  return SEASON_MAP.get(key) || null;
}
export function seasonLabel(key) {
  const s = SEASON_MAP.get(key);
  return s ? s.label : '';
}
export function tpoOf(key) {
  return TPO_MAP.get(key) || null;
}
export function tpoLabel(key) {
  const t = TPO_MAP.get(key);
  return t ? t.label : '';
}

/* ============================================================
   2. 색 변환
   ============================================================ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** r,g,b (0~255) → [h 0~360, s 0~1, l 0~1] */
export function rgbToHsl(r, g, b) {
  const rr = clamp(r, 0, 255) / 255;
  const gg = clamp(g, 0, 255) / 255;
  const bb = clamp(b, 0, 255) / 255;

  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  const l = (max + min) / 2;

  if (d === 0) return [0, 0, l];

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;

  h *= 60;
  if (h < 0) h += 360;

  return [h, s, l];
}

/** h(0~360), s(0~1), l(0~1) → [r, g, b] 0~255 정수 */
export function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);

  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;

  let r = 0, g = 0, b = 0;
  if (hh < 60)       { r = c; g = x; b = 0; }
  else if (hh < 120) { r = x; g = c; b = 0; }
  else if (hh < 180) { r = 0; g = c; b = x; }
  else if (hh < 240) { r = 0; g = x; b = c; }
  else if (hh < 300) { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** r,g,b → '#rrggbb' */
export function toHex(r, g, b) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** '#rrggbb' | '#rgb' | 'rrggbb' → [r, g, b] */
export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ============================================================
   3. 색 이름 판별
   ============================================================ */

// 판별 임계값 — 옷 사진 기준으로 튜닝합니다.
// HSL의 s는 아주 밝거나 어두운 색에서 과장되게 커집니다(흰빛 아이보리가 s=0.5).
// 그래서 실제 색기운은 chroma = max-min = s*(1-|2l-1|) 로 따로 재서 씁니다.
const T = {
  NEUTRAL_S: 0.12,  // 이 아래 채도는 무채색으로 취급
  NEUTRAL_C: 0.055, // 색기운 자체가 이만큼 없으면 무채색
  WHITE_L: 0.86,    // 무채색 중 이 위는 화이트
  BLACK_L: 0.17,    // 무채색 중 이 아래는 블랙
  PURE_WHITE_L: 0.94, // 거의 흰색
  PURE_BLACK_L: 0.09, // 거의 검정
  PURE_C: 0.12,     // 흑/백으로 볼 때 허용하는 색기운

  IVORY_L: 0.84,    // 따뜻한 계열이 이만큼 밝고 색기운이 옅으면 아이보리
  IVORY_C: 0.16,
  BEIGE_L: 0.52,    // 밝고 탁한 주황 계열 → 베이지
  BEIGE_C: 0.32,
  BROWN_L: 0.44,    // 어두운 주황·노랑 계열 → 브라운
  BROWN_C: 0.65,    // 단 원색에 가까운 진노랑·진주황은 브라운이 아님
  BROWN_MUTED_L: 0.62, // 중명도라도 아주 탁하면 브라운(토프·카키브라운)
  BROWN_MUTED_C: 0.14,

  NAVY_L: 0.40,     // 어두운 파랑 → 네이비
  NAVY_MUTED_L: 0.50, // 탁한 중명도 파랑도 네이비 쪽
  NAVY_MUTED_S: 0.34,

  PINK_L: 0.72,     // 밝은 레드 → 핑크
  MINT_L: 0.70,     // 밝고 부드러운 청록 → 민트
};

const COLOR_LABELS = {
  white: '화이트', ivory: '아이보리', beige: '베이지', brown: '브라운',
  black: '블랙', gray: '그레이', red: '레드', orange: '오렌지',
  yellow: '옐로우', green: '그린', mint: '민트', blue: '블루',
  navy: '네이비', purple: '퍼플', pink: '핑크',
};

export const COLOR_KEYS = Object.keys(COLOR_LABELS);

/** 색 key → 한국어 이름 */
export function colorLabel(key) {
  return COLOR_LABELS[key] || '';
}

function named(key) {
  return { key, label: COLOR_LABELS[key] };
}

/**
 * HSL → 옷에서 쓰는 색 이름.
 * 무채색 → 명도 → 유채색 hue 순으로 걸러내되,
 * 네이비·베이지·브라운은 옷에서 압도적으로 흔해 별도 예외로 먼저 잡습니다.
 */
export function colorName(h, s, l) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const sat = clamp(Number(s) || 0, 0, 1);
  const lig = clamp(Number(l) || 0, 0, 1);
  const chr = sat * (1 - Math.abs(2 * lig - 1)); // 실제 색기운 (max-min)

  // 1) 거의 흑/백
  if (lig >= T.PURE_WHITE_L && chr < T.PURE_C) return named('white');
  if (lig <= T.PURE_BLACK_L && chr < T.PURE_C) return named('black');

  // 2) 무채색
  if (sat < T.NEUTRAL_S || chr < T.NEUTRAL_C) {
    if (lig >= T.WHITE_L) return named('white');
    if (lig <= T.BLACK_L) return named('black');
    return named('gray');
  }

  // 3) 따뜻한 계열(주황·노랑) 예외 — 아이보리 / 브라운 / 베이지
  if (hue >= 10 && hue < 68) {
    if (lig >= T.IVORY_L && chr < T.IVORY_C) return named('ivory');
    if (lig < T.BROWN_L && chr < T.BROWN_C) return named('brown');
    if (lig < T.BROWN_MUTED_L && chr < T.BROWN_MUTED_C) return named('brown');
    if (lig >= T.BEIGE_L && chr < T.BEIGE_C) return named('beige');
  }
  // 아주 밝고 노란기 도는 옅은 색은 hue가 조금 벗어나도 아이보리로 봅니다.
  if (hue >= 30 && hue < 100 && lig >= T.IVORY_L && chr < T.IVORY_C) {
    return named('ivory');
  }

  // 4) 파랑 계열 예외 — 네이비
  if (hue >= 195 && hue < 260) {
    if (lig < T.NAVY_L) return named('navy');
    if (lig < T.NAVY_MUTED_L && sat < T.NAVY_MUTED_S) return named('navy');
  }

  // 5) 일반 hue 구간
  if (hue < 12 || hue >= 345) {
    return lig >= T.PINK_L ? named('pink') : named('red');
  }
  if (hue < 40) return named('orange');
  if (hue < 68) return named('yellow');
  if (hue < 152) {
    // 아주 밝고 채도가 낮은 초록빛 청록은 민트로 읽힙니다.
    if (hue >= 130 && lig >= T.MINT_L) return named('mint');
    return named('green');
  }
  if (hue < 192) return named('mint');
  if (hue < 255) return named('blue');
  if (hue < 292) return named('purple');
  return named('pink'); // 292~345: 마젠타·로즈 계열
}

/* ============================================================
   4. 톤 / 채도 등급
   ============================================================ */

const TONE_LIGHT_L = 0.66;
const TONE_DARK_L = 0.34;
const VIVID_S = 0.55;

/** 명도 → 'light' | 'mid' | 'dark' */
export function toneOf(l) {
  const lig = clamp(Number(l) || 0, 0, 1);
  if (lig >= TONE_LIGHT_L) return 'light';
  if (lig <= TONE_DARK_L) return 'dark';
  return 'mid';
}

const VIVID_C = 0.35;

/** 채도+명도 → 'neutral' | 'muted' | 'vivid' */
export function chromaOf(s, l) {
  const sat = clamp(Number(s) || 0, 0, 1);
  const lig = clamp(Number(l) || 0, 0, 1);
  const chr = sat * (1 - Math.abs(2 * lig - 1));
  // 너무 밝거나 어두우면 s가 높아도 눈에는 무채색으로 보입니다(파스텔·차콜).
  if (sat < T.NEUTRAL_S || chr < 0.08) return 'neutral';
  if (sat >= VIVID_S && chr >= VIVID_C) return 'vivid';
  return 'muted';
}

/* ============================================================
   5. 배색 점수
   ============================================================ */

// 뉴트럴(중심을 잡아주는 색) — 이 색들끼리는 보색 판정에서 제외합니다.
const NEUTRAL_KEYS = new Set(['white', 'ivory', 'beige', 'black', 'gray', 'navy', 'brown']);

// 보색·톤온톤 판정용 대표 hue (뉴트럴은 hue를 쓰지 않음)
const HUE_OF = {
  red: 0, orange: 28, yellow: 52, green: 110,
  mint: 170, blue: 215, purple: 275, pink: 330,
};

const TONE_RANK = { dark: 0, mid: 1, light: 2 };

const SCORE = {
  BASE: 50,
  ANCHOR: 12,
  TONAL: 10,
  CONTRAST: 10,
  COMPLEMENT: 8,
  TOO_VIVID: -18,
};

const REASON = {
  ANCHOR: '뉴트럴 색이 중심을 잡아줘요',
  TONAL: '같은 톤으로 부드럽게 이어져요',
  CONTRAST: '톤 차이가 또렷해서 깔끔해요',
  COMPLEMENT: '포인트 컬러가 살아나요',
  TOO_VIVID: '원색이 너무 많아요',
};

const HUE_NEAR = 45;   // 이 안쪽이면 같은 계열
const COMP_MIN = 150;  // 대략 반대편으로 보는 각도 범위
const COMP_MAX = 210;

function hueGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 조합의 배색 점수.
 * items: [{ baseColor, tone, chroma }, ...]
 * → { score, reasons }  reasons는 점수에 실제 기여한 항목만
 */
export function harmonyScore(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const reasons = [];
  if (list.length < 2) return { score: SCORE.BASE, reasons };

  let score = SCORE.BASE;

  // 뉴트럴 앵커
  if (list.some((it) => NEUTRAL_KEYS.has(it.baseColor))) {
    score += SCORE.ANCHOR;
    reasons.push(REASON.ANCHOR);
  }

  // 톤 폭
  const ranks = list.map((it) => (it.tone in TONE_RANK ? TONE_RANK[it.tone] : 1));
  const toneSpread = Math.max(...ranks) - Math.min(...ranks);

  // 유채색 hue 폭
  const hues = list
    .filter((it) => !NEUTRAL_KEYS.has(it.baseColor) && it.baseColor in HUE_OF)
    .map((it) => HUE_OF[it.baseColor]);

  let hueSpread = 0;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      hueSpread = Math.max(hueSpread, hueGap(hues[i], hues[j]));
    }
  }

  const vividCount = list.filter((it) => it.chroma === 'vivid').length;

  // 톤온톤: 같은 계열로 모였거나, 톤이 한 자리에 모여 있을 때
  const sameFamily = hueSpread <= HUE_NEAR;
  const tonal = (sameFamily && toneSpread <= 1) || (toneSpread === 0 && vividCount <= 1);
  if (tonal) {
    score += SCORE.TONAL;
    reasons.push(REASON.TONAL);
  }

  // 명도 대비 (톤온톤과는 자연히 배타적)
  if (toneSpread >= 2) {
    score += SCORE.CONTRAST;
    reasons.push(REASON.CONTRAST);
  }

  // 보색 한 쌍 — 유채색끼리만 따집니다
  let hasComplement = false;
  for (let i = 0; i < hues.length && !hasComplement; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const g = hueGap(hues[i], hues[j]);
      if (g >= COMP_MIN && g <= COMP_MAX) { hasComplement = true; break; }
    }
  }
  if (hasComplement) {
    score += SCORE.COMPLEMENT;
    reasons.push(REASON.COMPLEMENT);
  }

  // 원색 과다
  if (vividCount >= 3) {
    score += SCORE.TOO_VIVID;
    reasons.push(REASON.TOO_VIVID);
  }

  return { score: clamp(Math.round(score), 0, 100), reasons };
}

// analyzer.js — 누끼된 이미지에서 대표 색·톤·계절을 뽑습니다.
// segment.js가 성공한 뒤에만 호출됩니다(배경 alpha=0). 순수 함수, DOM 접근 없음.

import { rgbToHsl, toHex, colorName, toneOf, chromaOf } from './palette.js';

/* ---- 튜닝 임계값 ---- */
const ALPHA_MIN = 200;      // 이보다 불투명한 픽셀만 분석 (경계 페더링 제외)
const MAX_SAMPLES = 4000;   // 전체를 다 돌면 느려서 균등 샘플링
const K = 3;                // 군집 수
const ITERATIONS = 9;       // 이 정도면 중심이 충분히 수렴합니다
const MIN_PIXELS = 50;      // 대상 픽셀이 이보다 적으면 기본값 반환
const MIN_CLUSTER_RATIO = 0.04; // 너무 작은 군집은 색 목록에서 뺍니다
const MAX_COLORS = 3;

// 밝아도 가을에 자주 입는 따뜻한 뉴트럴
const WARM_NEUTRALS = new Set(['beige', 'ivory', 'brown']);

// 분석할 게 없을 때 돌려줄 안전한 기본값 (예외를 던지지 않습니다)
const FALLBACK = {
  colors: [{ hex: '#9e9e9e', ratio: 1 }],
  baseColor: 'gray',
  baseLabel: '그레이',
  tone: 'mid',
  chroma: 'neutral',
  seasons: ['spring', 'summer', 'fall', 'winter'],
};

function fallback() {
  // 호출부가 마음대로 고쳐도 되도록 매번 새 객체를 만듭니다.
  return {
    colors: FALLBACK.colors.map((c) => ({ ...c })),
    baseColor: FALLBACK.baseColor,
    baseLabel: FALLBACK.baseLabel,
    tone: FALLBACK.tone,
    chroma: FALLBACK.chroma,
    seasons: FALLBACK.seasons.slice(),
  };
}

/** 불투명 픽셀을 최대 MAX_SAMPLES개까지 일정 간격으로 뽑습니다. */
function collectSamples(data) {
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > ALPHA_MIN) opaque++;
  }
  if (opaque < MIN_PIXELS) return null;

  const step = Math.max(1, Math.floor(opaque / MAX_SAMPLES));
  const n = Math.min(MAX_SAMPLES, Math.ceil(opaque / step));
  const r = new Float64Array(n);
  const g = new Float64Array(n);
  const b = new Float64Array(n);

  let seen = 0;
  let k = 0;
  for (let i = 0; i < data.length && k < n; i += 4) {
    if (data[i + 3] <= ALPHA_MIN) continue;
    if (seen % step === 0) {
      r[k] = data[i];
      g[k] = data[i + 1];
      b[k] = data[i + 2];
      k++;
    }
    seen++;
  }
  return { r, g, b, n: k, opaque };
}

/**
 * k-means (k=3). 초기 중심은 밝기순 정렬 후 3등분 구간의 중앙에서 골라
 * 같은 사진이면 항상 같은 결과가 나오게 합니다(난수 없음).
 */
function kmeans(s) {
  const { r, g, b, n } = s;

  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const lum = new Float64Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  // 밝기가 같으면 인덱스로 tie-break — 정렬 안정성까지 결정적으로.
  const sorted = Array.from(order).sort((a, c) => (lum[a] - lum[c]) || (a - c));

  const cx = new Float64Array(K);
  const cy = new Float64Array(K);
  const cz = new Float64Array(K);
  for (let j = 0; j < K; j++) {
    const idx = sorted[Math.min(n - 1, Math.floor(((2 * j + 1) * n) / (2 * K)))];
    cx[j] = r[idx]; cy[j] = g[idx]; cz[j] = b[idx];
  }

  const label = new Uint8Array(n);
  const sumR = new Float64Array(K);
  const sumG = new Float64Array(K);
  const sumB = new Float64Array(K);
  const cnt = new Uint32Array(K);

  for (let it = 0; it < ITERATIONS; it++) {
    sumR.fill(0); sumG.fill(0); sumB.fill(0); cnt.fill(0);

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < K; j++) {
        const dr = r[i] - cx[j];
        const dg = g[i] - cy[j];
        const db = b[i] - cz[j];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      label[i] = best;
      sumR[best] += r[i]; sumG[best] += g[i]; sumB[best] += b[i];
      cnt[best]++;
    }

    let moved = false;
    for (let j = 0; j < K; j++) {
      if (cnt[j] === 0) continue; // 빈 군집은 중심을 그대로 둡니다
      const nr = sumR[j] / cnt[j];
      const ng = sumG[j] / cnt[j];
      const nb = sumB[j] / cnt[j];
      if (nr !== cx[j] || ng !== cy[j] || nb !== cz[j]) moved = true;
      cx[j] = nr; cy[j] = ng; cz[j] = nb;
    }
    if (!moved) break; // 수렴하면 남은 반복은 낭비
  }

  const clusters = [];
  for (let j = 0; j < K; j++) {
    if (cnt[j] === 0) continue;
    clusters.push({
      r: Math.round(cx[j]),
      g: Math.round(cy[j]),
      b: Math.round(cz[j]),
      count: cnt[j],
    });
  }
  // 크기순, 같으면 밝은 쪽을 먼저 — 순서까지 결정적으로 고정
  clusters.sort((a, c) => (c.count - a.count)
    || ((c.r + c.g + c.b) - (a.r + a.g + a.b)));
  return clusters;
}

/**
 * 색만 보고 하는 추정이라 확신이 없으면 여러 계절을 넣습니다.
 * (사용자가 상세 화면에서 고칠 수 있습니다)
 */
function guessSeasons(baseKey, tone, chroma) {
  if (tone === 'dark') return ['fall', 'winter'];          // 어두운 색은 가을·겨울
  if (chroma === 'vivid') return ['spring', 'summer'];     // 선명한 원색
  if (tone === 'light') {
    // 화이트·아이보리처럼 밝고 채도 없는 색
    if (chroma === 'neutral') return ['spring', 'summer'];
    // 베이지·카멜은 밝아도 가을 옷인 경우가 많습니다
    if (WARM_NEUTRALS.has(baseKey)) return ['spring', 'summer', 'fall'];
    return ['spring'];                                     // 파스텔
  }
  return ['spring', 'summer', 'fall', 'winter'];            // 중명도는 단정하기 어려움
}

/**
 * 누끼 ImageData → 색/톤/계절 정보
 * @param {ImageData} imageData 배경이 alpha=0인 RGBA 데이터
 */
export function analyze(imageData) {
  if (!imageData || !imageData.data || !imageData.data.length) return fallback();

  const s = collectSamples(imageData.data);
  if (!s || s.n < 1) return fallback();

  const clusters = kmeans(s);
  if (!clusters.length) return fallback();

  const total = s.n;
  const colors = clusters
    .map((c) => ({ hex: toHex(c.r, c.g, c.b), ratio: Math.round((c.count / total) * 1000) / 1000 }))
    .filter((c, i) => i === 0 || c.ratio >= MIN_CLUSTER_RATIO)
    .slice(0, MAX_COLORS);

  // 가장 큰 군집이 그 옷의 대표색
  const main = clusters[0];
  const [h, sat, lig] = rgbToHsl(main.r, main.g, main.b);
  const name = colorName(h, sat, lig);
  const tone = toneOf(lig);
  const chroma = chromaOf(sat, lig);

  return {
    colors,
    baseColor: name.key,
    baseLabel: name.label,
    tone,
    chroma,
    seasons: guessSeasons(name.key, tone, chroma),
  };
}

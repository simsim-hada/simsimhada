/**
 * segment.js — 옷 사진 배경 제거(누끼)
 *
 * 단색 배경(이불/바닥/벽) 위에 옷 한 벌을 놓고 위에서 찍은 사진을 전제로,
 * 테두리에서 시작하는 flood-fill 로 배경을 지우고 투명 PNG 를 만든다.
 *
 * 색 비교는 전부 CIE Lab 에서 한다. RGB 유클리드 거리는 어두운 색 구간에서
 * 실제로 보이는 차이를 과소평가해서(예: 남색 셔츠 #2A2E45 와 어두운 바닥 #3A3632),
 * 옷을 배경으로 빨아들이고도 "성공"으로 통과하는 사고가 났다.
 *
 * 망가진 마스크를 통과시키는 것이 실패로 알리는 것보다 나쁘다는 원칙에 따라,
 * (1) 배경/옷 대표색의 지각적 대비, (2) 마스크 품질(구멍·경계 복잡도)을
 * 별도로 검사해 조금이라도 의심스러우면 bg_similar 로 되돌린다.
 *
 * 공개 API: segment(blob)
 */

/* ────────────────────────────────────────────────────────────
 * 튜닝 상수 — 실사진에서 조정할 지점은 전부 여기 모아둔다
 * ──────────────────────────────────────────────────────────── */

/** 처리 해상도. 장변 512px. 폰 사진(4000px)을 그대로 다루면 느리고,
 *  256px 이하로 줄이면 옷 경계가 뭉개져 누끼 품질이 떨어진다. */
const MAX_SIDE = 512;

/** 너무 어두운 사진 판정: 전체 평균 휘도(0~255) 하한.
 *  실내 야간 조명 아래 정상 사진이 대략 60~90, 조명 없이 찍으면 30 아래로 떨어진다. */
const DARK_LUMA_MIN = 40;

/** 테두리에서 배경색을 고를 때 쓰는 띠 두께(px). 1px 만 보면 압축 잡음에 흔들린다. */
const BORDER_BAND = 2;

/** 색 버킷 크기(채널당 2^5=32단계 → 8×8×8 = 512 버킷). 최빈 배경색 후보를 찾는 용도. */
const BUCKET_SHIFT = 5;

/** 배경 대표색 주변에서 "배경으로 볼 만한" 테두리 픽셀을 고르는 반경(ΔE).
 *  옷이 테두리에 걸쳐 있어도 그 픽셀이 표준편차를 오염시키지 않게 하려는 장치. */
const BORDER_INLIER_DE = 22;

/** 배경 대표색 재중심화 반복 횟수 (조명 그라데이션이 있는 배경 대응) */
const BG_REFINE_PASSES = 2;

/** flood-fill 임계값(ΔE) = BASE_TOL_DE + STD_K × (배경 테두리 픽셀 ΔE 표준편차), 상·하한 클램프.
 *  ΔE 2.3 이 사람이 겨우 구분하는 차이다. 상한을 두지 않으면 얼룩진 배경에서
 *  임계값이 커져 옷까지 먹는다 — 이번 실기기 사고의 직접 원인이라 보수적으로 잡았다. */
const BASE_TOL_DE = 3.5;
const STD_K = 2.0;
const TOL_MIN_DE = 6;    // 완전 단색 배경이라도 JPEG 잡음(ΔE 3~5)은 흡수해야 한다
const TOL_MAX_DE = 18;   // 이 이상이면 인접 톤의 옷이 배경으로 빨려 들어간다

/** 그라데이션(그림자) 배경 대응: 직전 배경 픽셀과 거의 같은 색이면
 *  배경색과의 거리를 조금 더 봐준다. 단 하드 상한(TOL × RELAX)은 유지. */
const TOL_RELAX = 2.2;
const LOCAL_STEP_DE = 3.0;  // 이웃 픽셀과의 최대 ΔE. 작아야 옷 경계를 못 넘는다

/** 어두운 색 보정: Lab 에서도 어두운 색끼리는 색상(a,b) 차이가 작게 나온다.
 *  L 이 DARK_L_REF 이하로 내려갈수록 채도 성분 가중치를 최대 (1+BOOST) 배까지 올린다. */
const DARK_L_REF = 50;
const DARK_CHROMA_BOOST = 1.0;

/** 저대비 차단(신규): 배경 대표색과 전경 대표색의 ΔE 가 이보다 작으면
 *  flood-fill 로는 원리적으로 분리가 안 되므로 마스크를 만들지 않고 실패시킨다.
 *  일반 상황 14 는 "눈으로도 한참 봐야 구분되는" 수준, 여기서 더 낮추면
 *  망가진 누끼가 통과한다. 정상 사진(옷/배경 ΔE 25 이상)은 넉넉히 통과한다. */
const MIN_CONTRAST_DE = 14;
/** 둘 다 어두울 때는 더 엄격하게. 어두운 색끼리는 카메라 노이즈·그림자만으로도
 *  ΔE 10 안팎이 흔들려서 경계가 신뢰할 수 없다. */
const MIN_CONTRAST_DE_DARK = 22;
const DARK_L_MAX = 45;  // 배경·옷 대표색 L 이 둘 다 이 값 이하면 "어두운 색끼리"
/** 절대값보다 중요한 조건: 대비가 flood-fill 임계값의 이 배수보다 크지 않으면
 *  옷의 주름·그림자만으로도 일부 픽셀이 임계값 안으로 들어와 갉아먹힌다.
 *  실기기 사고 사진(남색 셔츠/어두운 바닥)이 ΔE 30, tol 16~18 이라 여기서 걸린다.
 *  반대로 배경이 깨끗하면 tol 이 7~9 로 작아져 중간 대비 옷도 정상 통과한다. */
const CONTRAST_TOL_MARGIN = 2.0;

/** 마스크 품질 검사(신규) */
const MASK_HOLE_MAX = 0.10;    // 전경 안쪽에 뚫린 배경 구멍 비율 상한
const MASK_COMPACT_MAX = 7.0;  // 둘레²/(4π·면적). 원=1, 티셔츠 2~3, 갉아먹힌 마스크는 8 이상
const MASK_SMOOTH_PASSES = 1;  // 둘레 측정 전 3x3 다수결 평활화(압축 잡음에 의한 과대측정 방지)

/** 경계 타당성(신규): 마스크 경계선 위에 진짜 색 경계가 있는지 본다.
 *  경계 픽셀마다 법선 방향으로 안쪽 8px / 바깥쪽 8px 색을 떠서 ΔE 를 잰다.
 *  진짜 옷 가장자리라면 옷 색 vs 배경색이라 ΔE 가 크고, 옷이 배경색으로
 *  녹아드는 평평한 구간에서 fill 이 멈췄다면 ΔE 가 작다(= 갉아먹힌 경계).
 *  깊이 8px 는 합성 실험에서 정상/사고 분리가 가장 뚜렷했다
 *  (정상 최대 0.04, 갉아먹힌 마스크 최소 0.24). 옷 주변 그림자 링 때문에
 *  3~5px 로 얕게 재면 정상 사진도 오탐한다. */
const EDGE_PROBE_DEPTH = 8;
const EDGE_WEAK_CONTRAST_FRAC = 0.35; // 안팎 ΔE 가 전체 대비의 35% 미만이면 "약한 경계"
/** 약한 경계 비율 상한. 합성 검증에서 정상 사진은 최대 0.045(옷 그림자가 짙은 경우),
 *  갉아먹힌 마스크는 최소 0.221 이었다. 두 분포의 기하 중간값이라 양쪽으로 2배 이상 여유가 있다. */
const EDGE_WEAK_MAX = 0.10;
const EDGE_MIN_SAMPLES = 50;          // 표본이 이보다 적으면(아주 작은 옷) 판정하지 않는다

/** 판정 임계값 */
const BG_RATIO_MIN = 0.05;   // 배경이 5% 미만 → 배경/옷 색이 비슷해 구분 실패
const BG_RATIO_MAX = 0.90;   // 배경이 90% 초과 → 옷을 못 찾음
const FG_RATIO_MIN = 0.03;   // 옷이 3% 미만 → 너무 멀리서 찍음
const MARGIN_FILL_MAX = 0.97; // 옷 bbox 가 가로·세로 97% 이상 → 여백 없음
const FG_RATIO_NO_MARGIN = 0.92; // 화면 대부분이 옷 → 경계를 못 잡은 것으로 본다
/** 배경이 5% 미만일 때 "여백 없음"과 "배경 구분 실패"를 가르는 신호:
 *  테두리 1px 중 배경으로 지워진 비율. 옷이 꽉 찬 사진은 얇은 배경 띠라도
 *  테두리를 따라 길게 이어지지만, 무늬 많은 배경은 애초에 거의 안 지워진다. */
const NO_MARGIN_BORDER_MIN = 0.35;
const MULTI_RATIO = 0.15;    // 전경의 15% 이상 덩어리가 2개 이상 → 여러 벌
/** 배경이 90%를 넘을 때, "옷이 작게 찍힌 것"과 "옷이 아예 없는 것"을 가르는 최소 덩어리 크기.
 *  전체의 0.5% (512px 기준 대략 36×36px) 면 사람 눈에도 옷으로 보인다. */
const SUBJECT_BLOB_MIN = 0.005;

/** 잡티 제거: 전경의 2% 미만인 조각은 그림자/얼룩으로 보고 버린다.
 *  이걸 안 하면 구석 얼룩 하나가 바운딩 박스를 통째로 키운다. */
const SPECK_RATIO = 0.02;

/** 경계 처리 */
const FRINGE_BAND = 2;        // 경계에서 이 픽셀 안쪽까지를 fringe 검사 대상으로 본다
const FRINGE_TOL_SCALE = 1.35; // 경계 띠에서 배경색과 ΔE ≤ tol×이 값 이면 배경 잔재로 보고 제거
const EDGE_ERODE = 1;         // 남은 혼합 픽셀 제거용 침식(px). 2 이상은 얇은 끈을 지운다
const FEATHER_PASSES = 2;     // 알파 3x3 박스 블러 반복 횟수
const ALPHA_EDGE_LO = 0.30;   // 블러 후 알파 곡선: 이 이하는 완전 투명
const ALPHA_EDGE_HI = 0.80;   // 이 이상은 완전 불투명 (경계 띠를 좁혀 밝은 윤곽선을 없앤다)
const TRIM_PAD = 2;           // 트림 시 사방 여백(px)

const REASONS = {
  too_dark: '사진이 너무 어두워요. 밝은 곳에서 다시 찍어주세요',
  bg_similar: '배경과 옷 색이 비슷해서 옷을 구분하지 못했어요. 다른 색 배경 위에 놓고 다시 찍어주세요',
  no_subject: '옷을 찾지 못했어요. 옷이 화면 가운데에 들어오게 다시 찍어주세요',
  too_small: '옷이 너무 작게 담겼어요. 조금 더 가까이서 찍어주세요',
  no_margin: '옷 경계를 못 찾았어요. 옷 주변에 여백을 두고 찍어주세요',
  multiple: '한 장에 옷이 여러 벌 있는 것 같아요. 한 장에 한 벌만 담아주세요',
  decode: '이 사진 형식을 읽을 수 없어요. 아이폰이라면 설정 → 카메라 → 포맷 → 높은 호환성으로 바꿔주세요'
};

function fail(reason) {
  return { ok: false, reason, message: REASONS[reason] };
}

/* ────────────────────────────────────────────────────────────
 * 공개 API
 * ──────────────────────────────────────────────────────────── */

export async function segment(blob) {
  if (!blob || typeof blob !== 'object' || !blob.size) return fail('decode');

  let src;
  try {
    src = await decodeImage(blob);
  } catch (e) {
    return fail('decode'); // HEIC 등 브라우저가 못 읽는 포맷
  }
  if (!src || !src.width || !src.height) return fail('decode');

  try {
    // await 필수: finally 에서 비트맵을 닫기 전에 처리가 끝나야 한다
    return await runSegment(src);
  } catch (e) {
    // 캔버스 read 실패·메모리 부족 등 예기치 못한 오류도 재촬영 안내로 수렴시킨다
    return fail('decode');
  } finally {
    if (src && typeof src.close === 'function') src.close();
    if (src && src._revoke) src._revoke();
  }
}

/* ────────────────────────────────────────────────────────────
 * 1. 디코딩 (EXIF 회전 흡수)
 * ──────────────────────────────────────────────────────────── */

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image: 아이폰 세로 사진이 눕는 문제를 여기서 끝낸다
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) { /* 옵션 미지원 브라우저 → 아래로 */ }
    try {
      return await createImageBitmap(blob);
    } catch (e) { /* → <img> 폴백 */ }
  }
  return await decodeViaImgTag(blob);
}

function decodeViaImgTag(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      img._revoke = () => URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

/* ────────────────────────────────────────────────────────────
 * 본 처리: 리사이즈 → Lab → flood-fill → 판정 → 마스크 → 트림 → PNG
 * ──────────────────────────────────────────────────────────── */

async function runSegment(src) {
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  if (sw < 8 || sh < 8) return fail('decode');

  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);

  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const total = w * h;

  /* ── 판정 ①: 너무 어두운 사진 (가장 먼저) ── */
  if (meanLuma(data) < DARK_LUMA_MIN) return fail('too_dark');

  const lab = toLab(data, total);

  /* ── 테두리 색 통계 → 배경 대표색과 적응 임계값(ΔE) ── */
  const bg = estimateBackground(data, lab, w, h);
  const tol = clamp(BASE_TOL_DE + STD_K * bg.std, TOL_MIN_DE, TOL_MAX_DE);

  /* ── flood-fill: 테두리에서 연결된 배경만 지운다 ── */
  const bgMask = floodFillBackground(lab, w, h, bg, tol);

  let bgCount = 0;
  for (let i = 0; i < total; i++) bgCount += bgMask[i];
  const bgRatio = bgCount / total;
  const fgCount = total - bgCount;
  const fgRatio = fgCount / total;

  /* ── 연결 요소 라벨링 (반복 BFS, 8-이웃) + 잡티 제거 ── */
  const cc = labelForeground(bgMask, w, h);
  const keep = buildKeepMask(bgMask, cc, w, h, fgCount);
  const box = bboxOf(keep, w, h);

  let biggest = 0;
  let bigBlobs = 0;
  for (let k = 0; k < cc.sizes.length; k++) {
    if (cc.sizes[k] > biggest) biggest = cc.sizes[k];
    if (cc.sizes[k] >= fgCount * MULTI_RATIO) bigBlobs++;
  }

  // 옷이 화면을 꽉 채워 여백이 없는 상태. 이때는 테두리 flood-fill 이
  // 얇은 띠만 지우고 끝나므로 배경 비율도 같이 0 에 가까워진다.
  const framed = !!box &&
    (((box.x1 - box.x0 + 1) / w >= MARGIN_FILL_MAX &&
      (box.y1 - box.y0 + 1) / h >= MARGIN_FILL_MAX) ||
     fgRatio >= FG_RATIO_NO_MARGIN);
  const borderBgRatio = borderBackgroundRatio(bgMask, w, h);

  /* ── 판정 ②: 배경 비율 ──
   * 배경 비율 조건과 여백/크기 조건은 구간이 겹친다(예: 배경 1% 는
   * "배경색이 비슷해 못 지웠다"일 수도, "옷이 꽉 차 여백이 없다"일 수도 있다).
   * 표의 임계값은 그대로 두고, 겹칠 때만 더 정확한 안내 쪽으로 가른다. */
  if (bgRatio < BG_RATIO_MIN) {
    const noMargin = framed && borderBgRatio >= NO_MARGIN_BORDER_MIN;
    return fail(noMargin ? 'no_margin' : 'bg_similar');
  }
  if (bgRatio > BG_RATIO_MAX) {
    // 배경 90% 초과: 쓸 만한 덩어리가 남아 있으면 "작게 찍힌 옷", 아니면 "옷 없음"
    return fail(biggest >= total * SUBJECT_BLOB_MIN ? 'too_small' : 'no_subject');
  }

  /* ── 판정 ③(신규): 배경 vs 옷 대표색의 지각적 대비 ──
   * 여기서 걸러야 "어두운 옷 + 어두운 바닥"처럼 원리적으로 분리 불가능한 사진이
   * 갉아먹힌 마스크로 통과하는 사고를 막는다. */
  const fgLab = medianLab(lab, keep, total);
  if (!fgLab) return fail('no_subject');
  const contrast = Math.sqrt(deltaE2(bg.L, bg.A, bg.B, fgLab.L, fgLab.A, fgLab.B));
  const bothDark = bg.L <= DARK_L_MAX && fgLab.L <= DARK_L_MAX;
  const needContrast = Math.max(
    bothDark ? MIN_CONTRAST_DE_DARK : MIN_CONTRAST_DE,
    tol * CONTRAST_TOL_MARGIN
  );
  if (contrast < needContrast) return fail('bg_similar');

  /* ── 판정 ④: 옷 크기 ── */
  if (fgRatio < FG_RATIO_MIN) return fail('too_small');
  if (!box) return fail('no_subject'); // 잡티만 남은 경우

  /* ── 판정 ⑤: 여백 ── */
  if (framed) return fail('no_margin');

  /* ── 판정 ⑥: 여러 벌 ── */
  if (bigBlobs >= 2) return fail('multiple');

  /* ── 판정 ⑦(신규): 마스크 품질 ──
   * 대비 검사를 통과했더라도 그림자·무늬 때문에 마스크가 갉아먹히거나
   * 안쪽에 구멍이 뚫릴 수 있다. 실루엣이 옷처럼 생기지 않았으면 되돌린다. */
  const quality = maskQuality(keep, w, h, box);
  if (quality.holeRatio > MASK_HOLE_MAX || quality.compactness > MASK_COMPACT_MAX) {
    return fail('bg_similar');
  }
  if (edgeWeakRatio(keep, lab, w, h, contrast) > EDGE_WEAK_MAX) {
    return fail('bg_similar');
  }

  /* ── 알파 마스크: fringe 제거 + 침식 + 페더링 ── */
  const alpha = buildAlpha(keep, bgMask, lab, bg, tol, w, h);

  /* ── 트림 (bbox + 2px 여백) ── */
  const x0 = Math.max(0, box.x0 - TRIM_PAD);
  const y0 = Math.max(0, box.y0 - TRIM_PAD);
  const x1 = Math.min(w - 1, box.x1 + TRIM_PAD);
  const y1 = Math.min(h - 1, box.y1 + TRIM_PAD);
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;

  const outData = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    let sIdx = ((y + y0) * w + x0) * 4;
    let dIdx = y * tw * 4;
    let sA = (y + y0) * w + x0;
    for (let x = 0; x < tw; x++, sIdx += 4, dIdx += 4, sA++) {
      outData[dIdx] = data[sIdx];
      outData[dIdx + 1] = data[sIdx + 1];
      outData[dIdx + 2] = data[sIdx + 2];
      outData[dIdx + 3] = alpha[sA];
    }
  }
  const imageData = new ImageData(outData, tw, th);

  /* ── PNG 출력 ── */
  const outCanvas = makeCanvas(tw, th);
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.putImageData(imageData, 0, 0);
  const cutoutBlob = await canvasToPng(outCanvas);
  if (!cutoutBlob) return fail('decode');

  return {
    ok: true,
    cutoutBlob,
    imageData,
    aspect: tw / th,
    method: 'floodfill'
  };
}

/* ────────────────────────────────────────────────────────────
 * 색 공간 — sRGB → 선형 → XYZ(D65) → Lab
 * ──────────────────────────────────────────────────────────── */

/** sRGB 8bit → 선형값 LUT (픽셀마다 pow 를 부르지 않기 위해) */
const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t) {
  // (6/29)^3 = 0.008856
  return t > 0.008856451679 ? Math.cbrt(t) : (7.787037037 * t + 0.137931034);
}

function toLab(data, total) {
  const L = new Float32Array(total);
  const A = new Float32Array(total);
  const B = new Float32Array(total);
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const r = SRGB_LIN[data[p]], g = SRGB_LIN[data[p + 1]], b = SRGB_LIN[data[p + 2]];
    const fx = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { L, A, B };
}

/**
 * ΔE 제곱 (sqrt 생략, 비교용).
 * 어두운 색끼리는 같은 색상차라도 실제로는 더 잘 구분되므로 a,b 성분에 가중치를 준다.
 * 남색(#2A2E45)과 어두운 회갈색(#3A3632)을 서로 다른 색으로 취급하게 만드는 부분.
 */
function deltaE2(L1, A1, B1, L2, A2, B2) {
  const dL = L1 - L2, da = A1 - A2, db = B1 - B2;
  const minL = L1 < L2 ? L1 : L2;
  let k = 1;
  if (minL < DARK_L_REF) {
    k = 1 + DARK_CHROMA_BOOST * (1 - Math.max(0, minL) / DARK_L_REF);
  }
  return dL * dL + k * k * (da * da + db * db);
}

/* ────────────────────────────────────────────────────────────
 * 내부 헬퍼
 * ──────────────────────────────────────────────────────────── */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToPng(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch (e) {
      resolve(null);
    }
  });
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Rec.709 휘도의 전체 평균 (0~255) */
function meanLuma(data) {
  let sum = 0;
  const n = data.length >> 2;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    sum += 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return sum / n;
}

/**
 * 테두리 띠 픽셀에서 배경 대표색(Lab)과 산포(ΔE 표준편차)를 구한다.
 * RGB 버킷 최빈색으로 후보를 잡고 → Lab 에서 inlier 평균으로 재중심화한다.
 * 재중심화는 조명 그라데이션이 있는 배경에서 한쪽 구석이 임계값 밖으로
 * 밀려나 전경으로 남는 문제를 막는다.
 */
function estimateBackground(data, lab, w, h) {
  const counts = new Int32Array(1 << (3 * (8 - BUCKET_SHIFT)));
  const band = Math.min(BORDER_BAND, Math.floor(Math.min(w, h) / 2)) || 1;
  const idxs = [];

  for (let y = 0; y < h; y++) {
    const edgeRow = (y < band || y >= h - band);
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= band && x < w - band) {
        x = w - band - 1; // 가운데는 건너뛴다
        continue;
      }
      const i = y * w + x;
      counts[bucketOf(data, i)]++;
      idxs.push(i);
    }
  }

  let best = 0, bestCount = -1;
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] > bestCount) { bestCount = counts[k]; best = k; }
  }

  let sL = 0, sA = 0, sB = 0, n = 0;
  for (let t = 0; t < idxs.length; t++) {
    const i = idxs[t];
    if (bucketOf(data, i) !== best) continue;
    sL += lab.L[i]; sA += lab.A[i]; sB += lab.B[i]; n++;
  }
  if (n === 0) n = 1;
  let L = sL / n, A = sA / n, B = sB / n;

  const lim2 = BORDER_INLIER_DE * BORDER_INLIER_DE;
  for (let pass = 0; pass < BG_REFINE_PASSES; pass++) {
    let aL = 0, aA = 0, aB = 0, m = 0;
    for (let t = 0; t < idxs.length; t++) {
      const i = idxs[t];
      if (deltaE2(lab.L[i], lab.A[i], lab.B[i], L, A, B) > lim2) continue;
      aL += lab.L[i]; aA += lab.A[i]; aB += lab.B[i]; m++;
    }
    if (m === 0) break;
    L = aL / m; A = aA / m; B = aB / m;
  }

  // 배경으로 볼 만한(대표색에 가까운) 테두리 픽셀만으로 산포를 잰다.
  // 테두리에 옷이 걸쳐 있어도 임계값이 부풀지 않게 하려는 것.
  let sum2 = 0, m = 0;
  for (let t = 0; t < idxs.length; t++) {
    const i = idxs[t];
    const d2 = deltaE2(lab.L[i], lab.A[i], lab.B[i], L, A, B);
    if (d2 > lim2) continue;
    sum2 += d2; m++;
  }
  const std = m > 0 ? Math.sqrt(sum2 / m) : 0;

  return { L, A, B, std };
}

function bucketOf(data, i) {
  const p = i * 4;
  return ((data[p] >> BUCKET_SHIFT) << (2 * (8 - BUCKET_SHIFT))) |
         ((data[p + 1] >> BUCKET_SHIFT) << (8 - BUCKET_SHIFT)) |
         (data[p + 2] >> BUCKET_SHIFT);
}

/**
 * 테두리에서 시작하는 4-이웃 flood-fill. 스택 기반 반복문(재귀 금지).
 * 반환: Uint8Array (1 = 배경)
 */
function floodFillBackground(lab, w, h, bg, tol) {
  const total = w * h;
  const mask = new Uint8Array(total);
  const stack = new Int32Array(total); // 각 픽셀은 최대 1회만 push 되므로 이 크기면 충분
  let sp = 0;

  const L = lab.L, A = lab.A, B = lab.B;
  const tol2 = tol * tol;
  const relax2 = (tol * TOL_RELAX) * (tol * TOL_RELAX);
  const step2 = LOCAL_STEP_DE * LOCAL_STEP_DE;

  const seed = (i) => {
    if (mask[i]) return;
    if (deltaE2(L[i], A[i], B[i], bg.L, bg.A, bg.B) <= tol2) {
      mask[i] = 1;
      stack[sp++] = i;
    }
  };

  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

  while (sp > 0) {
    const cur = stack[--sp];
    const cL = L[cur], cA = A[cur], cB = B[cur];
    const cx = cur % w;
    const cy = (cur - cx) / w;

    for (let k = 0; k < 4; k++) {
      let nx = cx, ny = cy;
      if (k === 0) nx--;
      else if (k === 1) nx++;
      else if (k === 2) ny--;
      else ny++;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;

      const ni = ny * w + nx;
      if (mask[ni]) continue;

      const nL = L[ni], nA = A[ni], nB = B[ni];
      const dGlobal = deltaE2(nL, nA, nB, bg.L, bg.A, bg.B);

      let take = dGlobal <= tol2;
      if (!take && dGlobal <= relax2) {
        // 그림자 그라데이션: 직전 배경 픽셀과 거의 같은 색이면 이어서 지운다
        take = deltaE2(nL, nA, nB, cL, cA, cB) <= step2;
      }
      if (take) {
        mask[ni] = 1;
        stack[sp++] = ni;
      }
    }
  }

  return mask;
}

/**
 * 전경(mask===0)에 대한 8-이웃 연결 요소 라벨링. 반복 BFS.
 * 8-이웃을 쓰는 이유: 어깨선처럼 대각으로만 이어진 부분이 끊겨
 * 한 벌이 여러 벌로 오판되는 것을 막는다.
 */
function labelForeground(bgMask, w, h) {
  const total = w * h;
  const labels = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  const sizes = [];

  for (let start = 0; start < total; start++) {
    if (bgMask[start] || labels[start] !== -1) continue;

    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    let count = 0;

    while (head < tail) {
      const cur = queue[head++];
      count++;
      const cx = cur % w;
      const cy = (cur - cx) / w;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (bgMask[ni] || labels[ni] !== -1) continue;
          labels[ni] = id;
          queue[tail++] = ni;
        }
      }
    }
    sizes.push(count);
  }

  return { labels, sizes: Int32Array.from(sizes) };
}

/** 잡티(전경의 SPECK_RATIO 미만 조각)를 제거한 전경 마스크 */
function buildKeepMask(bgMask, cc, w, h, fgCount) {
  const total = w * h;
  const keep = new Uint8Array(total);
  const minSize = Math.max(1, Math.floor(fgCount * SPECK_RATIO));
  const alive = new Uint8Array(cc.sizes.length);
  for (let k = 0; k < cc.sizes.length; k++) alive[k] = cc.sizes[k] >= minSize ? 1 : 0;

  for (let i = 0; i < total; i++) {
    const lb = cc.labels[i];
    if (lb >= 0 && alive[lb]) keep[i] = 1;
  }
  return keep;
}

function bboxOf(keep, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!keep[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** 테두리 1px 링 중 배경으로 지워진 비율 */
function borderBackgroundRatio(bgMask, w, h) {
  let hit = 0, n = 0;
  for (let x = 0; x < w; x++) {
    hit += bgMask[x] + bgMask[(h - 1) * w + x];
    n += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    hit += bgMask[y * w] + bgMask[y * w + w - 1];
    n += 2;
  }
  return n > 0 ? hit / n : 0;
}

/** 마스크 영역의 대표색(Lab 채널별 중앙값). 무늬 옷에서도 흔들리지 않는다. */
function medianLab(lab, mask, total) {
  let n = 0;
  for (let i = 0; i < total; i++) n += mask[i];
  if (n === 0) return null;

  const MAX_SAMPLES = 20000;
  const stride = Math.max(1, Math.floor(n / MAX_SAMPLES));
  const cap = Math.ceil(n / stride) + 1;
  const sL = new Float32Array(cap), sA = new Float32Array(cap), sB = new Float32Array(cap);

  let k = 0, seen = 0;
  for (let i = 0; i < total && k < cap; i++) {
    if (!mask[i]) continue;
    if ((seen++ % stride) !== 0) continue;
    sL[k] = lab.L[i]; sA[k] = lab.A[i]; sB[k] = lab.B[i]; k++;
  }
  if (k === 0) return null;

  const mid = k >> 1;
  return {
    L: sL.subarray(0, k).sort()[mid],
    A: sA.subarray(0, k).sort()[mid],
    B: sB.subarray(0, k).sort()[mid]
  };
}

/**
 * 마스크 품질:
 *  - holeRatio: 전경 안쪽에 뚫린 배경 구멍 비율(상하좌우 모두 전경으로 막힌 픽셀).
 *               소매 사이 오목한 부분은 한쪽이 열려 있어 구멍으로 세지 않는다.
 *  - compactness: 둘레²/(4π·면적). 옷이 갉아먹혀 실루엣이 들쭉날쭉하면 급격히 커진다.
 */
function maskQuality(keep, w, h, box) {
  const smooth = smoothMask(keep, w, h, MASK_SMOOTH_PASSES);

  // 행/열별 전경 시작·끝
  const rowL = new Int32Array(h).fill(-1);
  const rowR = new Int32Array(h).fill(-1);
  const colT = new Int32Array(w).fill(-1);
  const colB = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!smooth[row + x]) continue;
      if (rowL[y] < 0) rowL[y] = x;
      rowR[y] = x;
      if (colT[x] < 0) colT[x] = y;
      colB[x] = y;
    }
  }

  let area = 0, holes = 0, perim = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    const row = y * w;
    for (let x = box.x0; x <= box.x1; x++) {
      const i = row + x;
      if (smooth[i]) {
        area++;
        // 4-이웃 중 배경/화면 밖과 맞닿은 변의 개수 = 둘레 기여
        if (x === 0 || !smooth[i - 1]) perim++;
        if (x === w - 1 || !smooth[i + 1]) perim++;
        if (y === 0 || !smooth[i - w]) perim++;
        if (y === h - 1 || !smooth[i + w]) perim++;
      } else if (x > rowL[y] && x < rowR[y] && y > colT[x] && y < colB[x]) {
        holes++;
      }
    }
  }

  const compactness = area > 0 ? (perim * perim) / (4 * Math.PI * area) : Infinity;
  const holeRatio = (area + holes) > 0 ? holes / (area + holes) : 0;
  return { holeRatio, compactness };
}

/**
 * 마스크 경계 중 "약한 경계"의 비율 = 경계 위치에 실제 색 경계가 없는 비율.
 * 경계 픽셀마다 바깥 방향을 찾아, 안쪽 d px 지점과 바깥 d px 지점의 색을 비교한다.
 * 옷 진짜 가장자리면 (옷 색 vs 배경색)이라 ΔE 가 대비만큼 크게 나오고,
 * 옷이 배경색으로 녹아드는 평평한 구간을 갈라놓았으면 ΔE 가 작게 나온다.
 * 사용자가 겪은 "어깨가 베어 물린" 사고를 잡는 검사.
 */
function edgeWeakRatio(keep, lab, w, h, contrast) {
  const need = contrast * EDGE_WEAK_CONTRAST_FRAC;
  const need2 = need * need;
  const d = EDGE_PROBE_DEPTH;
  let checked = 0, weak = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!keep[i]) continue;

      // 어느 방향이 바깥(배경)인지 찾는다
      let ox = 0, oy = 0;
      if (x > 0 && !keep[i - 1]) ox = -1;
      else if (x < w - 1 && !keep[i + 1]) ox = 1;
      else if (y > 0 && !keep[i - w]) oy = -1;
      else if (y < h - 1 && !keep[i + w]) oy = 1;
      else continue; // 경계가 아님

      const ix = x - ox * d, iy = y - oy * d;   // 옷 안쪽 탐침
      const gx = x + ox * d, gy = y + oy * d;   // 배경 쪽 탐침
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;

      const ii = iy * w + ix, gi = gy * w + gx;
      // 얇은 부분(탐침이 반대편으로 빠져나감)이나 좁은 틈은 표본에서 제외
      if (!keep[ii] || keep[gi]) continue;

      checked++;
      if (deltaE2(lab.L[ii], lab.A[ii], lab.B[ii],
                  lab.L[gi], lab.A[gi], lab.B[gi]) < need2) weak++;
    }
  }

  // 표본이 너무 적으면(작은 옷) 판단을 유보한다 — 정상 사진을 막는 쪽이 더 나쁘다
  return checked >= EDGE_MIN_SAMPLES ? weak / checked : 0;
}

/** 3x3 다수결 평활화. 압축 잡음 때문에 둘레가 과대 측정되는 것을 막는다. */
function smoothMask(mask, w, h, passes) {
  let cur = mask;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            n++;
            c += cur[ny * w + nx];
          }
        }
        next[y * w + x] = (c * 2 > n) ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * 알파 마스크 생성.
 *  1) fringe 제거: 경계 띠에서 배경색과 거의 같은 픽셀(=옷/배경 혼합 픽셀)을 떼어낸다.
 *     경계 띠로 제한하는 이유는, 옷 안쪽의 배경색 무늬까지 지우면 안 되기 때문.
 *  2) 1px 침식 → 남은 혼합 픽셀 정리
 *  3) 3x3 박스 블러 페더링 후 알파 곡선으로 전이 구간을 좁힌다.
 *     (블러만 하면 반투명 띠가 넓어져 밝은 윤곽선처럼 보인다)
 */
function buildAlpha(keep, bgMask, lab, bg, tol, w, h) {
  const total = w * h;
  const band = dilate(bgMask, w, h, FRINGE_BAND);
  const fringeTol2 = (tol * FRINGE_TOL_SCALE) * (tol * FRINGE_TOL_SCALE);

  let base = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!keep[i]) continue;
    if (band[i] && deltaE2(lab.L[i], lab.A[i], lab.B[i], bg.L, bg.A, bg.B) <= fringeTol2) continue;
    base[i] = 1;
  }

  for (let e = 0; e < EDGE_ERODE; e++) {
    const next = new Uint8Array(total);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!base[i]) continue;
        const up = y > 0 ? base[i - w] : 0;
        const dn = y < h - 1 ? base[i + w] : 0;
        const lf = x > 0 ? base[i - 1] : 0;
        const rt = x < w - 1 ? base[i + 1] : 0;
        next[i] = (up && dn && lf && rt) ? 1 : 0;
      }
    }
    base = next;
  }

  const alpha = new Uint8ClampedArray(total);
  for (let i = 0; i < total; i++) alpha[i] = base[i] ? 255 : 0;

  const tmp = new Uint8ClampedArray(total);
  for (let pass = 0; pass < FEATHER_PASSES; pass++) boxBlur3(alpha, tmp, w, h);

  const lo = ALPHA_EDGE_LO * 255;
  const span = (ALPHA_EDGE_HI - ALPHA_EDGE_LO) * 255;
  for (let i = 0; i < total; i++) {
    const v = alpha[i];
    alpha[i] = v <= lo ? 0 : (v >= lo + span ? 255 : ((v - lo) / span) * 255);
  }
  return alpha;
}

/** 4-이웃 팽창을 r 회 반복 (마스크 주변 r 픽셀 띠를 얻는 용도) */
function dilate(mask, w, h, r) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] ||
            (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) {
          next[i] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** 3x3 박스 블러(분리형). tmp 는 재사용 버퍼. */
function boxBlur3(buf, tmp, w, h) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = buf[row + (x > 0 ? x - 1 : 0)];
      const c = buf[row + x];
      const r = buf[row + (x < w - 1 ? x + 1 : w - 1)];
      tmp[row + x] = (l + c + r) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = (y > 0 ? y - 1 : 0) * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      buf[row + x] = (tmp[up + x] + tmp[row + x] + tmp[dn + x]) / 3;
    }
  }
}

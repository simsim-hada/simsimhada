// weather.js — 오늘 기온 조회 + 수동 입력 폴백
//
// 이 파일은 절대 예외를 던지지 않습니다. 실패는 전부 반환값으로 표현합니다.
// (추천 화면이 날씨 때문에 막히면 앱이 못 쓰는 상태가 되기 때문)
//
// 폴백 순서:
//   1) 수동 기온      → source: 'manual'  (사용자가 정한 값이 최우선. 절대 덮어쓰지 않음)
//   2) 신선한 캐시    → source: 'cache'
//   3) 위치 + 네트워크 → source: 'geo'    (성공 시 캐시에 기록)
//   4) 오래된 캐시    → source: 'cache'   (오프라인에서 "마지막으로 알던 기온")
//   5) 아무것도 없음  → source: 'none', tempC: null

/* ============================================================
   상수
   ============================================================ */

const LS_MANUAL = 'pickfit.weather.manual';
const LS_CACHE = 'pickfit.weather.cache';

const DEFAULT_MAX_AGE = 30 * 60 * 1000; // 캐시 신선도 기준 30분
const GEO_TIMEOUT = 8000;               // 위치 권한 팝업을 무시해도 8초 뒤 포기
const FETCH_TIMEOUT = 8000;             // 네트워크가 죽어 있어도 8초 뒤 포기

const API = 'https://api.open-meteo.com/v1/forecast';

// 기온으로 쓸 수 있는 범위. 이 밖의 값은 손상된 데이터로 보고 버립니다.
const TEMP_MIN = -60;
const TEMP_MAX = 60;

/* ============================================================
   WMO weather code → 한국어 라벨 / 이모지
   Open-Meteo는 weather_code 로 WMO 코드를 줍니다.
   ============================================================ */

const WMO = {
  0:  ['맑음',            '☀️'],
  1:  ['대체로 맑음',      '🌤️'],
  2:  ['구름 조금',        '⛅'],
  3:  ['흐림',            '☁️'],

  45: ['안개',            '🌫️'],
  48: ['서리 안개',        '🌫️'],

  51: ['약한 이슬비',      '🌦️'],
  53: ['이슬비',          '🌦️'],
  55: ['강한 이슬비',      '🌧️'],
  56: ['얼어붙는 이슬비',   '🌧️'],
  57: ['강한 얼어붙는 이슬비', '🌧️'],

  61: ['약한 비',          '🌦️'],
  63: ['비',              '🌧️'],
  65: ['강한 비',          '🌧️'],
  66: ['얼어붙는 비',      '🌧️'],
  67: ['강한 얼어붙는 비',  '🌧️'],

  71: ['약한 눈',          '🌨️'],
  73: ['눈',              '❄️'],
  75: ['강한 눈',          '❄️'],
  77: ['싸락눈',           '🌨️'],

  80: ['약한 소나기',      '🌦️'],
  81: ['소나기',          '🌧️'],
  82: ['강한 소나기',      '🌧️'],

  85: ['약한 소낙눈',      '🌨️'],
  86: ['소낙눈',          '🌨️'],

  95: ['뇌우',            '⛈️'],
  96: ['뇌우와 우박',      '⛈️'],
  99: ['강한 뇌우와 우박',  '⛈️'],
};

// 코드가 비었을 때(수동 입력 등)
const NO_CODE = ['날씨 정보 없음', '🌡️'];
// 표에 없는 코드는 구간으로 대충 맞춥니다. 그래도 모르면 '흐림'.
const UNKNOWN = ['흐림', '☁️'];

function wmoEntry(code) {
  if (code === null || code === undefined) return NO_CODE;
  const n = Number(code);
  if (!Number.isFinite(n)) return NO_CODE;
  if (WMO[n]) return WMO[n];

  // 구간 폴백 — 미래에 새 코드가 늘어도 엉뚱한 라벨이 나오지 않게
  if (n >= 95) return WMO[95];
  if (n >= 85) return WMO[85];
  if (n >= 80) return WMO[81];
  if (n >= 71) return WMO[73];
  if (n >= 61) return WMO[63];
  if (n >= 51) return WMO[53];
  if (n >= 45) return WMO[45];
  if (n >= 0 && n <= 3) return WMO[3];
  return UNKNOWN;
}

/** WMO 날씨 코드 → 한국어 라벨 */
export function weatherLabel(code) {
  return wmoEntry(code)[0];
}

/** WMO 날씨 코드 → 이모지 (아이콘 자산 대체용) */
export function weatherEmoji(code) {
  return wmoEntry(code)[1];
}

/* ============================================================
   localStorage 안전 접근
   사파리 프라이빗 모드 등에서 접근 자체가 던지므로 전부 감쌉니다.
   ============================================================ */

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // 용량 초과·차단. 캐시는 없어도 앱은 돌아가야 합니다.
  }
}

function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
}

// 값이 없으면 null. Number(null)이 0이 되어 "0도"로 오인되지 않게 먼저 걸러냅니다.
function validTemp(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < TEMP_MIN || n > TEMP_MAX) return null;
  return Math.round(n * 10) / 10;
}

// 코드·강수량용. 여기도 null이 0으로 새어들어가면 '맑음'으로 오인됩니다.
function numOrNull(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ============================================================
   수동 기온
   ============================================================ */

/** 사용자가 직접 정한 기온. 없으면 null */
export function getManualTemp() {
  return validTemp(lsGet(LS_MANUAL));
}

/**
 * 수동 기온 저장. 이후 getWeather()는 이 값을 최우선으로 돌려줍니다.
 * 잘못된 값이면 저장하지 않고 false를 반환합니다.
 */
export function setManualTemp(tempC) {
  const t = validTemp(tempC);
  if (t === null) return false;
  return lsSet(LS_MANUAL, String(t));
}

/** 수동 기온 해제 → 다음 호출부터 다시 자동 조회 */
export function clearManualTemp() {
  lsRemove(LS_MANUAL);
}

/* ============================================================
   캐시
   ============================================================ */

function readCache() {
  const raw = lsGet(LS_CACHE);
  if (!raw) return null;
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    lsRemove(LS_CACHE); // 깨진 캐시는 버립니다
    return null;
  }
  if (!o || typeof o !== 'object') return null;

  const tempC = validTemp(o.tempC);
  const fetchedAt = numOrNull(o.fetchedAt);
  if (tempC === null || fetchedAt === null) return null;

  const code = numOrNull(o.code);
  const precip = numOrNull(o.precip) ?? 0;

  return {
    tempC,
    precip,
    code,
    label: weatherLabel(code),
    source: 'cache',
    place: typeof o.place === 'string' && o.place ? o.place : null,
    fetchedAt,
  };
}

function writeCache(w) {
  lsSet(
    LS_CACHE,
    JSON.stringify({
      tempC: w.tempC,
      precip: w.precip,
      code: w.code,
      place: w.place,
      fetchedAt: w.fetchedAt,
    })
  );
}

/* ============================================================
   위치 + Open-Meteo
   ============================================================ */

// getCurrentPosition은 브라우저에 따라 권한 팝업을 띄운 채로 timeout이 흐르지 않습니다.
// 그래서 옵션 timeout과 별도로 우리 쪽 타이머로도 끊습니다.
function getPosition(timeoutMs) {
  return new Promise((resolve) => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : null;
    if (!geo) return resolve(null);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      geo.getCurrentPosition(
        (pos) => finish(pos && pos.coords ? pos.coords : null),
        () => finish(null), // 거부·실패 모두 조용히 폴백
        { timeout: timeoutMs, maximumAge: 10 * 60 * 1000, enableHighAccuracy: false }
      );
    } catch {
      finish(null);
    }
  });
}

async function fetchCurrent(lat, lon, timeoutMs) {
  const url =
    `${API}?latitude=${encodeURIComponent(lat.toFixed(3))}` +
    `&longitude=${encodeURIComponent(lon.toFixed(3))}` +
    `&current=temperature_2m,precipitation,weather_code`;

  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (ac) ac.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ac ? ac.signal : undefined,
      cache: 'no-store', // 서비스워커도 이 도메인은 통과시킵니다
    });
    if (!res.ok) return null;

    const json = await res.json();
    const cur = json && json.current;
    if (!cur) return null;

    const tempC = validTemp(cur.temperature_2m);
    if (tempC === null) return null;

    const code = numOrNull(cur.weather_code);
    const precip = numOrNull(cur.precipitation) ?? 0;

    return { tempC, precip, code };
  } catch {
    return null; // 오프라인·타임아웃·CORS·JSON 오류 전부 여기로
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   본체
   ============================================================ */

/**
 * 오늘 기온을 구합니다. 실패해도 던지지 않고 source로 알립니다.
 *
 * @param {{ allowGeo?: boolean, maxAgeMs?: number }} opts
 * @returns {Promise<{ tempC: number|null, precip: number, code: number|null,
 *                     label: string, source: 'geo'|'cache'|'manual'|'none',
 *                     place: string|null, fetchedAt: number }>}
 */
export async function getWeather(opts = {}) {
  const { allowGeo = true, maxAgeMs = DEFAULT_MAX_AGE } = opts || {};
  const now = Date.now();

  // 1) 수동 기온이 최우선. 사용자가 정한 값은 조회로 덮어쓰지 않습니다.
  const manual = getManualTemp();
  if (manual !== null) {
    return {
      tempC: manual,
      precip: 0,
      code: null,
      label: '직접 입력',
      source: 'manual',
      place: null,
      fetchedAt: now,
    };
  }

  // 2) 신선한 캐시면 네트워크를 건드리지 않습니다.
  const cached = readCache();
  const maxAge = numOrNull(maxAgeMs) ?? DEFAULT_MAX_AGE;
  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt <= maxAge) {
    return cached;
  }

  // 3) 위치 → Open-Meteo (API 키 불필요)
  if (allowGeo) {
    const coords = await getPosition(GEO_TIMEOUT);
    if (coords && Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude)) {
      const cur = await fetchCurrent(coords.latitude, coords.longitude, FETCH_TIMEOUT);
      if (cur) {
        const fresh = {
          tempC: cur.tempC,
          precip: cur.precip,
          code: cur.code,
          label: weatherLabel(cur.code),
          source: 'geo',
          place: null, // 지역명은 별도 API가 필요하므로 두지 않습니다
          fetchedAt: Date.now(),
        };
        writeCache(fresh);
        return fresh;
      }
    }
  }

  // 4) 오래된 캐시라도 있으면 보여줍니다 — 오프라인에서 "마지막으로 알던 기온"
  if (cached) return cached;

  // 5) 아무것도 없음 → 호출한 쪽이 수동 입력 UI로 전환합니다
  return {
    tempC: null,
    precip: 0,
    code: null,
    label: NO_CODE[0],
    source: 'none',
    place: null,
    fetchedAt: now,
  };
}

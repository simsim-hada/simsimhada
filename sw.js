// sw.js — PICKFIT 서비스워커
//
// 목표: 비행기 모드에서 앱을 열어도 옷장과 코디 추천이 그대로 동작한다.
// 사진은 IndexedDB에 있으므로 여기서는 앱 껍데기(HTML/CSS/JS/아이콘)만 캐시한다.
//
// 등록 코드는 여기에 없다. 등록은 app.js가 한다.

/* ============================================================
   버전 — 셸을 고칠 때 이 문자열만 올리면 옛 캐시가 정리된다
   ============================================================ */

const VERSION = 'v1';
const CACHE_NAME = `pickfit-shell-${VERSION}`;
const CACHE_PREFIX = 'pickfit-shell-';

// 하위 경로 배포(예: /pickfit/)에서도 동작하도록 전부 상대 경로로 둔다.
const SHELL = [
  './',
  './index.html',
  './manifest.json',

  './css/theme.css',
  './css/base.css',

  './js/app.js',
  './js/db.js',
  './js/segment.js',
  './js/analyzer.js',
  './js/palette.js',
  './js/coordinator.js',
  './js/outfit-image.js',
  './js/weather.js',
  './js/backup.js',

  './assets/icon-outer.svg',
  './assets/icon-top.svg',
  './assets/icon-bottom.svg',
  './assets/icon-dress.svg',
  './assets/icon-shoes.svg',
  './assets/icon-bag.svg',
  './assets/icon-acc.svg',
  './assets/tab-closet.svg',
  './assets/tab-today.svg',
  './assets/tab-settings.svg',
  './assets/empty-closet.svg',
  './assets/logo.svg',

  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ============================================================
   install — 셸 미리 캐시
   addAll은 하나만 404여도 전체가 실패하므로 개별로 add하고 실패는 무시한다.
   (아직 만들어지지 않은 파일이 목록에 있어도 설치가 깨지지 않아야 한다)
   ============================================================ */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            // cache: 'reload' — 브라우저 HTTP 캐시의 낡은 사본을 담지 않도록
            await cache.add(new Request(path, { cache: 'reload' }));
          } catch {
            /* 없는 파일·네트워크 실패는 건너뛴다 */
          }
        })
      );
      // 여기서 skipWaiting()을 하지 않는다. 열려 있는 화면이 옛 셸로 돌고 있는데
      // 새 모듈이 섞여 들어오면 화면이 깨진다. 새 버전 적용은
      // 다음 실행 또는 app.js가 보내는 SKIP_WAITING 메시지로 한다.
    })()
  );
});

/* ============================================================
   activate — 옛 버전 캐시 삭제 + 즉시 제어권 확보
   ============================================================ */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      // 첫 설치 때도 이미 열려 있는 탭이 오프라인 동작을 얻게 한다.
      await self.clients.claim();
    })()
  );
});

/* ============================================================
   message — 앱의 "새 버전 적용" 버튼
   ============================================================ */

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ============================================================
   fetch
   - 문서(navigate)      : network-first  → 새 버전을 놓치지 않는다
   - 정적 자원(css/js/img): stale-while-revalidate → 즉시 렌더 + 뒤에서 갱신
   - 외부 도메인          : 통과 (open-meteo 등은 캐시하지 않는다)
   - GET 아님             : 통과
   ============================================================ */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // http(s)가 아닌 스킴(chrome-extension: 등)은 캐시 API가 거부한다.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 외부 도메인(api.open-meteo.com 등)은 손대지 않는다.
  // 오프라인이면 그냥 실패하게 두고 weather.js가 폴백을 처리한다.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, req));
});

/* ── 문서: 네트워크 먼저, 실패하면 캐시 ───────────────────── */

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    // 오프라인 — 같은 URL → index.html → 루트 순으로 되짚는다
    return (
      (await cache.match(req, { ignoreSearch: true })) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      offlineResponse()
    );
  }
}

/* ── 정적 자원: 캐시를 즉시 주고 뒤에서 갱신 ───────────────── */

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: false });

  const update = fetch(req)
    .then((res) => {
      // 불투명 응답(no-cors)이나 오류는 캐시에 넣지 않는다
      if (res && res.ok && res.type !== 'opaque') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    // 응답은 이미 끝났지만 갱신은 계속 살려 둔다
    event.waitUntil(update);
    return cached;
  }

  const fresh = await update;
  return fresh || offlineResponse();
}

/* ── 캐시도 네트워크도 없을 때 ─────────────────────────────── */

function offlineResponse() {
  return new Response('', {
    status: 504,
    statusText: 'PICKFIT: 오프라인이고 캐시에도 없습니다',
  });
}

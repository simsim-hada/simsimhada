import * as db from './db.js';
import { segment } from './segment.js';
import { analyze } from './analyzer.js';
import { CATEGORIES, SEASONS, TPOS, categoryOf } from './palette.js';
import { buildOutfits, closetGaps } from './coordinator.js';
import { renderOutfit, clearCache } from './outfit-image.js';
import * as weather from './weather.js';
import * as backup from './backup.js';

/* ── 유틸 ─────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const show = (el, on = true) => { el.hidden = !on; };
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

// 원본은 장변 1024 / 품질 0.75로 줄여 보관한다. 누끼와 원본을 온전히 둘 다
// 들고 있으면 용량이 두 배가 되기 때문.
const SOURCE_MAX = 1024;
const SOURCE_QUALITY = 0.75;

const objectUrls = new Set();
function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.add(u);
  return u;
}
function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls.clear();
}

/* 한국어 조사는 앞말의 종성 유무로 갈린다. 문구를 조립할 때 "하의이" 같은 게
   나오지 않도록 마지막 글자의 받침을 보고 고른다. */
function withParticle(word, withJong, withoutJong) {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return word + withoutJong;
  return word + ((code - 0xac00) % 28 !== 0 ? withJong : withoutJong);
}

/* 추천 이유는 "…예요" 로 끝나는 문장들이 배열로 온다. 공백으로만 이으면
   한 문장처럼 뭉쳐 읽히므로 마침표로 끊어준다. */
function joinReasons(reasons) {
  if (!reasons?.length) return '';
  return reasons.map(r => r.replace(/[.\s]+$/, '')).join('. ') + '.';
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  show(el, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(el, false), 2200);
}

/* 누끼 PNG를 90도 회전한다. 폰으로 찍으면 눕거나 뒤집혀 들어오는 경우가 있어
   등록 단계에서 바로잡을 수 있어야 한다. 가로/세로가 바뀌므로 aspect도 뒤집힌다. */
async function rotateBlob(blob, dir) { // dir: -1 왼쪽, +1 오른쪽
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.height;
  c.height = bmp.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(dir * Math.PI / 2);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  bmp.close?.();
  return await new Promise(res => c.toBlob(res, 'image/png'));
}

let rotating = false;
async function withRotateLock(fn) {
  if (rotating) return;
  rotating = true;
  for (const b of $$('.rotatebtn')) b.disabled = true;
  try { await fn(); } finally { rotating = false; }
}

const ROTATE_ROW = `
  <div class="rotate-row">
    <button class="rotatebtn" data-act="rot-l" aria-label="왼쪽으로 회전">↺</button>
    <button class="rotatebtn" data-act="rot-r" aria-label="오른쪽으로 회전">↻</button>
  </div>`;

async function makeSourceBlob(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, SOURCE_MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise(res => c.toBlob(res, 'image/jpeg', SOURCE_QUALITY));
  } catch {
    return null; // 원본 보관 실패는 등록을 막을 이유가 못 된다
  }
}

/* ── 상태 ─────────────────────────────────────────────── */

const state = {
  tab: 'closet',
  filter: 'all',
  items: [],
  counts: {},
  retakes: 0,
  detailId: null,
  today: { tpo: null, tempC: null, wx: null, outfits: [], busy: false },
  add: {
    step: 'cat',
    batchCategory: null,   // null = 종류 섞임
    cards: [],             // 확정 대기 카드
    saved: 0,
    skipped: 0,
  },
};

/* ── 화면 전환 ────────────────────────────────────────── */

function setTab(tab) {
  state.tab = tab;
  for (const v of $$('.view')) show(v, v.dataset.view === tab);
  for (const t of $$('.tab')) t.classList.toggle('is-on', t.dataset.tab === tab);
  if (tab === 'settings') renderSettings();
  if (tab === 'today') openToday();
}

/* 파일을 사용자에게 넘기는 경로는 기기마다 다르다. iOS는 다운로드가 잘 안 먹어서
   공유 시트가 훨씬 확실하다. 되는 것부터 순서대로 시도한다. */
async function handOffFile(blob, filename, shareTitle) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: shareTitle });
      return 'share';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancel';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'download';
}

/* ── 옷장 ─────────────────────────────────────────────── */

async function loadCloset() {
  state.items = await db.getItems();
  state.counts = await db.countByCategory();
  state.retakes = (await db.getRetakes()).length;
  renderCloset();
}

function renderCloset() {
  releaseUrls();
  renderFilter();

  const list = state.filter === 'all'
    ? state.items
    : state.items.filter(i => i.category === state.filter);

  const grid = $('#closet-grid');
  const empty = $('#closet-empty');
  const total = state.items.length;

  $('#closet-count').textContent = total ? `${total}벌` : '';

  show(empty, total === 0);
  show(grid, total > 0);

  grid.innerHTML = list.map(item => `
    <button class="card" data-act="open-detail" data-id="${item.id}">
      <span class="card-img checker">
        <img src="${urlFor(item.cutoutBlob)}" alt="" loading="lazy">
      </span>
      <span class="card-meta">
        <span class="card-cat">${categoryOf(item.category)?.label ?? ''}</span>
        <span class="card-color">${item.baseLabel ?? ''}</span>
      </span>
    </button>
  `).join('');

  if (total > 0 && list.length === 0) {
    grid.innerHTML = `<p class="grid-empty">이 종류의 옷이 아직 없어요</p>`;
  }

  // 코디를 만들려면 뭐가 더 필요한지 미리 알려준다 (추천 0건에 도달하기 전에 막는다).
  // 여기서는 상시 노출되는 낮은 강도의 힌트라, 추천 화면의 강한 문구를 그대로 쓰지 않는다.
  const gaps = closetGaps(state.items);
  const gapNote = $('#gap-note');
  show(gapNote, total > 0 && !!gaps);
  if (total > 0 && gaps) {
    const labels = gaps.missing.map(m => m.label).join(' · ');
    gapNote.textContent = `코디를 만들려면 ${withParticle(labels, '이', '가')} 더 필요해요`;
  }

  // 재촬영 대기 배너
  const banner = $('#retake-banner');
  show(banner, state.retakes > 0);
  if (state.retakes > 0) {
    banner.innerHTML = `다시 찍을 사진 <b>${state.retakes}장</b>이 있어요
      <button class="btn btn-link" data-act="open-add">지금 추가하기</button>`;
  }
}

function renderFilter() {
  const used = CATEGORIES.filter(c => (state.counts[c.key] ?? 0) > 0);
  const chips = [{ key: 'all', label: '전체' }, ...used];
  $('#closet-filter').innerHTML = chips.map(c => `
    <button class="chip ${state.filter === c.key ? 'is-on' : ''}"
            data-act="filter" data-key="${c.key}">
      ${c.label}${c.key === 'all' ? '' : ` <span class="chip-n">${state.counts[c.key]}</span>`}
    </button>
  `).join('');
}

/* ── 오늘 코디 ────────────────────────────────────────── */

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function openToday() {
  $('#today-date').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  renderTpoChips();
  await loadWeather();
  await refreshOutfits();
}

function renderTpoChips() {
  const chips = [{ key: null, label: '전체' }, ...TPOS];
  $('#tpo-filter').innerHTML = chips.map(t => `
    <button class="chip ${state.today.tpo === t.key ? 'is-on' : ''}"
            data-act="set-tpo" data-key="${t.key ?? ''}">${t.label}</button>
  `).join('');
}

async function loadWeather() {
  const wx = await weather.getWeather();
  state.today.wx = wx;
  state.today.tempC = wx.tempC;

  $('#weather-emoji').textContent = weather.weatherEmoji(wx.code);
  $('#weather-temp').textContent = wx.tempC == null ? '--°' : `${Math.round(wx.tempC)}°`;
  $('#weather-label').textContent = wx.tempC == null ? '기온을 알 수 없어요' : (wx.label ?? '');

  const srcText = { geo: '위치 기반', cache: '저장된 값', manual: '직접 입력', none: '' };
  $('#weather-src').textContent = srcText[wx.source] ?? '';

  // 기온을 못 구했거나 사용자가 직접 정한 경우에만 슬라이더를 노출한다
  const needManual = wx.tempC == null || wx.source === 'manual';
  const panel = $('#temp-manual');
  show(panel, needManual);
  if (needManual) {
    const v = Math.round(wx.tempC ?? 15);
    $('.slider[data-act="set-temp"]', panel).value = v;
    $('#temp-manual-val').textContent = `${v}°`;
    if (wx.tempC == null) state.today.tempC = v;
  }
}

async function refreshOutfits() {
  if (state.today.busy) return;
  state.today.busy = true;

  const box = $('#outfits');
  const shortageBox = $('#shortage');
  const note = $('#relaxed-note');

  try {
    const items = state.items.length ? state.items : await db.getItems();
    state.items = items;

    // 착용 이력을 한 번에 모아 coordinator에 넘긴다 (아이템마다 조회하면 느리다)
    const wears = await db.getWears();
    const lastWorn = new Map();
    for (const w of wears) {
      const ts = new Date(w.date).getTime();
      for (const id of w.itemIds) {
        if (!lastWorn.has(id) || lastWorn.get(id) < ts) lastWorn.set(id, ts);
      }
    }

    const res = buildOutfits(items, {
      tempC: state.today.tempC,
      tpo: state.today.tpo,
      lastWorn,
      now: Date.now(),
      seed: hashSeed(todayISO() + (state.today.tpo ?? '') + items.length),
      count: 3,
    });

    state.today.outfits = res.outfits;

    show(note, !!res.relaxedNote);
    if (res.relaxedNote) note.textContent = res.relaxedNote;

    show(shortageBox, !!res.shortage);
    if (res.shortage) {
      shortageBox.innerHTML = `
        <p class="shortage-title">${res.shortage.message}</p>
        <p class="shortage-desc">코디는 상의와 하의만 있어도 만들어져요.</p>
        <button class="btn btn-primary" data-act="open-add">옷 추가하기</button>`;
    }

    box.innerHTML = res.outfits.map((o, i) => `
      <article class="outfit" data-oid="${o.id}">
        <div class="outfit-img" id="oimg-${i}"></div>
        <div class="outfit-body">
          <p class="outfit-why">${joinReasons(o.reasons)}</p>
          <p class="outfit-list">${o.items.map(it => `${it.baseLabel} ${categoryOf(it.category).label}`).join(' · ')}</p>
          <div class="outfit-acts">
            <button class="btn btn-primary" data-act="wear" data-i="${i}">이거 입었어요</button>
            <button class="btn btn-ghost" data-act="save-img" data-i="${i}">이미지 저장</button>
          </div>
        </div>
      </article>`).join('');

    // 합성 이미지는 무거우므로 카드 마크업을 먼저 띄우고 뒤이어 채운다
    for (let i = 0; i < res.outfits.length; i++) {
      const o = res.outfits[i];
      const slot = $(`#oimg-${i}`);
      if (!slot) continue;
      try {
        const { blob } = await renderOutfit(o.items, { cacheKey: o.id });
        slot.innerHTML = `<img src="${urlFor(blob)}" alt="">`;
      } catch (err) {
        console.error('코디 이미지 합성 실패', err);
        slot.innerHTML = '';
      }
      await nextFrame();
    }
  } catch (err) {
    console.error(err);
    toast('코디를 만들지 못했어요');
  } finally {
    state.today.busy = false;
  }
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function wearOutfit(i) {
  const o = state.today.outfits[i];
  if (!o) return;
  await db.addWear({ itemIds: o.items.map(it => it.id), date: todayISO(), tpo: state.today.tpo });
  toast('기록했어요. 다음 추천에서 잠시 빠집니다');
  await refreshOutfits();
}

async function saveOutfitImage(i) {
  const o = state.today.outfits[i];
  if (!o) return;
  try {
    const { blob } = await renderOutfit(o.items, { cacheKey: o.id, background: '#ffffff' });
    const how = await handOffFile(blob, `pickfit-${todayISO()}.png`, '오늘 코디');
    if (how === 'download') toast('이미지를 저장했어요');
  } catch (err) {
    console.error(err);
    toast('이미지를 만들지 못했어요');
  }
}

/* ── 옷 추가: 단계 이동 ───────────────────────────────── */

const STEPS = { cat: '#add-step-cat', pick: '#add-step-pick', proc: '#add-step-proc', cards: '#add-step-cards', done: '#add-step-done' };

function setAddStep(step) {
  state.add.step = step;
  for (const [k, sel] of Object.entries(STEPS)) show($(sel), k === step);
  const titles = { cat: '옷 추가', pick: '사진 넣기', proc: '분석 중', cards: '확인하기', done: '완료' };
  $('#add-title').textContent = titles[step];
  $('#add-step').textContent = step === 'cards' ? `${state.add.cards.length}장 남음` : '';
}

function openAdd() {
  state.add = { step: 'cat', batchCategory: null, cards: [], saved: 0, skipped: 0 };
  renderBatchCats();
  setAddStep('cat');
  show($('#sheet-add'), true);
}

function closeAdd() {
  show($('#sheet-add'), false);
  loadCloset();
}

function renderBatchCats() {
  $('#batch-cat').innerHTML = CATEGORIES.map(c => `
    <button class="catbtn" data-act="pick-cat" data-key="${c.key}">
      <span class="ico" data-ico="${c.key}"></span>${c.label}
    </button>
  `).join('');
}

function goPick(category) {
  state.add.batchCategory = category;
  const label = category ? categoryOf(category).label : null;
  $('#pick-lead').textContent = label
    ? `${label} 사진을 골라주세요`
    : '사진을 골라주세요';
  setAddStep('pick');
}

/* ── 옷 추가: 사진 처리 ───────────────────────────────── */

async function processFiles(files) {
  const list = [...files];
  if (!list.length) return;

  setAddStep('proc');
  const bar = $('#proc-bar');
  const sub = $('#proc-sub');
  bar.style.width = '0%';

  const cards = [];
  let done = 0;

  for (const file of list) {
    $('#proc-text').textContent = `사진을 분석하고 있어요 (${done + 1}/${list.length})`;
    await nextFrame(); // 화면이 멈추지 않게 매 장마다 렌더 기회를 준다

    const card = await processOne(file);
    cards.push(card);

    done++;
    bar.style.width = `${Math.round(done / list.length * 100)}%`;
    const okCount = cards.filter(c => !c.failed).length;
    sub.textContent = `${okCount}장 성공 · ${done - okCount}장 실패`;
  }

  state.add.cards = cards;
  if (!cards.length) { setAddStep('pick'); return; }
  setAddStep('cards');
  renderStack();
}

async function processOne(file) {
  let res;
  try {
    res = await segment(file);
  } catch (err) {
    res = { ok: false, reason: 'decode', message: '이 사진을 처리하지 못했어요. 다른 사진으로 시도해주세요' };
  }

  if (!res.ok) {
    return { failed: true, file, reason: res.reason, message: res.message };
  }

  const tags = analyze(res.imageData);
  const cat = state.add.batchCategory;

  return {
    failed: false,
    file,
    draft: {
      category: cat,                                   // 섞임 모드면 null → 카드에서 선택
      colors: tags.colors,
      baseColor: tags.baseColor,
      baseLabel: tags.baseLabel,
      tone: tags.tone,
      chroma: tags.chroma,
      seasons: tags.seasons,
      tpo: ['daily'],
      warmth: cat ? categoryOf(cat).warmth : 2,
      cutoutBlob: res.cutoutBlob,
      aspect: res.aspect,
      segMethod: res.method ?? 'floodfill',
    },
  };
}

/* ── 옷 추가: 확정 카드 스택 ──────────────────────────── */

function renderStack() {
  const stack = $('#card-stack');
  const cards = state.add.cards;
  $('#add-step').textContent = `${cards.length}장 남음`;

  if (!cards.length) { finishAdd(); return; }

  // 맨 위 카드 + 뒤에 겹쳐 보일 2장만 그린다
  const visible = cards.slice(0, 3);
  stack.innerHTML = visible.map((card, i) =>
    card.failed ? failCardHtml(card, i) : okCardHtml(card, i)
  ).reverse().join('');

  bindTopCard();
  const top = cards[0];
  const bar = $('.stackbar');
  show(bar, !top.failed);
  if (!top.failed) {
    const keep = $('[data-act="card-keep"]');
    const needCat = !top.draft.category;
    keep.disabled = needCat;
    keep.textContent = needCat ? '종류를 골라주세요' : '저장';
  }
}

function okCardHtml(card, depth) {
  const d = card.draft;
  return `
  <article class="qcard ${depth === 0 ? 'is-top' : ''}" style="--depth:${depth}">
    <div class="qcard-img checker"><img src="${urlFor(d.cutoutBlob)}" alt=""></div>
    ${depth === 0 ? ROTATE_ROW : ''}
    <div class="qcard-body">
      <div class="qcard-colors">
        ${d.colors.map(c => `<span class="swatch" style="background:${c.hex}"></span>`).join('')}
        <span class="qcard-colorname">${d.baseLabel}</span>
      </div>
      ${depth === 0 ? `
      <div class="field">
        <span class="field-label">종류</span>
        <div class="chiprow">
          ${CATEGORIES.map(c => `<button class="chip ${d.category === c.key ? 'is-on' : ''}"
            data-act="set-cat" data-key="${c.key}">${c.label}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <span class="field-label">계절</span>
        <div class="chiprow">
          ${SEASONS.map(s => `<button class="chip ${d.seasons.includes(s.key) ? 'is-on' : ''}"
            data-act="toggle-season" data-key="${s.key}">${s.label}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <span class="field-label">상황</span>
        <div class="chiprow">
          ${TPOS.map(t => `<button class="chip ${d.tpo.includes(t.key) ? 'is-on' : ''}"
            data-act="toggle-tpo" data-key="${t.key}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <span class="field-label">두께 <b class="field-val">${'●'.repeat(d.warmth)}${'○'.repeat(5 - d.warmth)}</b></span>
        <input class="slider" type="range" min="1" max="5" value="${d.warmth}" data-act="set-warmth">
      </div>` : ''}
    </div>
  </article>`;
}

function failCardHtml(card, depth) {
  return `
  <article class="qcard is-fail ${depth === 0 ? 'is-top' : ''}" style="--depth:${depth}">
    <div class="qcard-img"><img src="${urlFor(card.file)}" alt=""></div>
    <div class="qcard-body">
      <p class="fail-title">이 사진은 배경을 지우지 못했어요</p>
      <p class="fail-msg">${card.message}</p>
      ${depth === 0 ? `
      <button class="btn btn-primary btn-wide" data-act="retry-shot">다시 찍기</button>
      <button class="btn btn-ghost btn-wide" data-act="skip-fail">나중에 하기</button>
      <p class="fail-note">나중에 하기를 누르면 설정의 “다시 찍을 사진”에 보관됩니다.</p>` : ''}
    </div>
  </article>`;
}

function topCard() { return state.add.cards[0]; }

/* 맨 위 카드 좌우 드래그 — 오른쪽은 저장, 왼쪽은 버리기 */
function bindTopCard() {
  const el = $('.qcard.is-top');
  if (!el || topCard()?.failed) return;

  let startX = 0, dx = 0, dragging = false;

  const onDown = e => {
    if (e.target.closest('button, input')) return; // 칩·슬라이더 조작은 드래그가 아니다
    dragging = true;
    startX = e.clientX;
    el.classList.add('is-dragging');
    el.setPointerCapture?.(e.pointerId);
  };
  const onMove = e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('is-dragging');
    el.style.transform = '';
    if (dx > 90) keepTop();
    else if (dx < -90) dropTop();
    dx = 0;
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

async function keepTop() {
  const card = topCard();
  if (!card || card.failed || !card.draft.category) return;

  const source = await makeSourceBlob(card.file);
  await db.addItem({ ...card.draft, sourceBlob: source, createdAt: Date.now() });
  maybeAskPersist();

  state.add.saved++;
  state.add.cards.shift();
  renderStack();
}

function dropTop() {
  state.add.cards.shift();
  renderStack();
}

async function skipFail() {
  const card = topCard();
  if (!card?.failed) return;
  await db.addRetake({
    imageBlob: card.file,
    reason: card.reason,
    message: card.message,
    createdAt: Date.now(),
  });
  state.add.skipped++;
  state.add.cards.shift();
  renderStack();
}

async function keepAll() {
  const remaining = [...state.add.cards];
  for (const card of remaining) {
    if (card.failed || !card.draft.category) continue;
    const source = await makeSourceBlob(card.file);
    await db.addItem({ ...card.draft, sourceBlob: source, createdAt: Date.now() });
    state.add.saved++;
    state.add.cards = state.add.cards.filter(c => c !== card);
  }
  maybeAskPersist();
  renderStack();
  if (state.add.cards.length) toast('종류를 고르지 않았거나 실패한 사진이 남았어요');
}

function finishAdd() {
  const { saved, skipped } = state.add;
  $('#done-title').textContent = saved ? `${saved}벌 등록 완료` : '등록된 옷이 없어요';
  $('#done-desc').textContent = skipped
    ? `${skipped}장은 다시 찍어주세요. 설정 → 다시 찍을 사진에 보관해뒀어요.`
    : '옷장에서 확인해보세요.';
  setAddStep('done');
}

/* 실패한 한 장만 교체 — 나머지 진행 상황은 유지된다 */
let replacingCard = null;
function retryShot() {
  replacingCard = topCard();
  $('#file-replace').click();
}

async function onReplacePicked(file) {
  if (!file || !replacingCard) return;
  setAddStep('proc');
  $('#proc-text').textContent = '다시 분석하고 있어요';
  $('#proc-bar').style.width = '50%';
  $('#proc-sub').textContent = '';
  await nextFrame();

  const card = await processOne(file);
  const idx = state.add.cards.indexOf(replacingCard);
  if (idx >= 0) state.add.cards[idx] = card;
  replacingCard = null;

  $('#proc-bar').style.width = '100%';
  setAddStep('cards');
  renderStack();
}

/* ── 카드 편집 ────────────────────────────────────────── */

function editTop(fn) {
  const card = topCard();
  if (!card || card.failed) return;
  fn(card.draft);
  renderStack();
}

/* 회전 버튼은 확정 카드와 상세 화면 양쪽에 있다. 열려 있는 쪽을 대상으로 삼는다. */
function rotateCurrent(dir) {
  const detailOpen = !$('#sheet-detail').hidden;

  withRotateLock(async () => {
    if (detailOpen) {
      const item = await db.getItem(state.detailId);
      if (!item) return;
      item.cutoutBlob = await rotateBlob(item.cutoutBlob, dir);
      item.aspect = 1 / item.aspect;
      await db.updateItem(item);
      clearCache(item.id);   // 합성 이미지에 예전 방향이 남아 있으면 안 된다
      await openDetail(item.id);
    } else {
      const card = topCard();
      if (!card || card.failed) return;
      card.draft.cutoutBlob = await rotateBlob(card.draft.cutoutBlob, dir);
      card.draft.aspect = 1 / card.draft.aspect;
      renderStack();
    }
  });
}

/* ── 아이템 상세 ──────────────────────────────────────── */

async function openDetail(id) {
  const item = await db.getItem(id);
  if (!item) return;
  state.detailId = id;

  const wornAt = await db.lastWornAt(id);
  const wornText = wornAt
    ? `${Math.floor((Date.now() - wornAt) / 86400000)}일 전에 입었어요`
    : '아직 입은 기록이 없어요';

  $('#detail-body').innerHTML = `
    <div class="detail-img checker"><img src="${urlFor(item.cutoutBlob)}" alt=""></div>
    ${ROTATE_ROW}
    <div class="detail-colors">
      ${item.colors.map(c => `<span class="swatch" style="background:${c.hex}"></span>`).join('')}
      <span class="detail-colorname">${item.baseLabel}</span>
    </div>
    <p class="detail-worn">${wornText}</p>
    <div class="field">
      <span class="field-label">종류</span>
      <div class="chiprow">
        ${CATEGORIES.map(c => `<button class="chip ${item.category === c.key ? 'is-on' : ''}"
          data-act="d-cat" data-key="${c.key}">${c.label}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <span class="field-label">계절</span>
      <div class="chiprow">
        ${SEASONS.map(s => `<button class="chip ${item.seasons.includes(s.key) ? 'is-on' : ''}"
          data-act="d-season" data-key="${s.key}">${s.label}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <span class="field-label">상황</span>
      <div class="chiprow">
        ${TPOS.map(t => `<button class="chip ${item.tpo.includes(t.key) ? 'is-on' : ''}"
          data-act="d-tpo" data-key="${t.key}">${t.label}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <span class="field-label">두께 <b class="field-val">${'●'.repeat(item.warmth)}${'○'.repeat(5 - item.warmth)}</b></span>
      <input class="slider" type="range" min="1" max="5" value="${item.warmth}" data-act="d-warmth">
    </div>
  `;
  show($('#sheet-detail'), true);
}

async function editDetail(fn) {
  const item = await db.getItem(state.detailId);
  if (!item) return;
  fn(item);
  await db.updateItem(item);
  clearCache(item.id);   // 종류가 바뀌면 조합 이미지의 크기 정규화도 달라진다
  await openDetail(item.id);
}

/* ── 설정 ─────────────────────────────────────────────── */

async function renderSettings() {
  const est = await db.estimate();
  $('#storage-desc').textContent = est
    ? `${est.usageText} 사용 중 (한도 ${est.quotaText})`
    : '이 브라우저에서는 확인할 수 없어요';

  const retakes = await db.getRetakes();
  $('#retake-desc').textContent = `${retakes.length}장`;

  // 영구 저장 — 이게 꺼져 있으면 브라우저가 저장 공간을 회수할 수 있다
  const p = await backup.persistState();
  const btn = $('#persist-btn');
  if (!p.supported) {
    $('#persist-desc').textContent = '이 브라우저에서는 지원하지 않아요';
    show(btn, false);
  } else if (p.persisted) {
    $('#persist-desc').textContent = '켜짐 — 브라우저가 데이터를 임의로 지우지 않습니다';
    show(btn, false);
  } else {
    $('#persist-desc').textContent = '꺼짐 — 저장 공간이 부족하면 데이터가 지워질 수 있어요';
    show(btn, true);
  }

  const warn = $('#backup-warn');
  const rem = await backup.backupReminder();
  show(warn, !!rem);
  if (rem) warn.textContent = rem.message;

  renderInstallTip();
}

/* 홈 화면에 추가하면 저장 데이터가 유지될 가능성이 크게 올라간다.
   안드로이드는 설치 프롬프트 API가 있지만 iOS는 없어서 직접 안내해야 한다. */
let installEvent = null;
function renderInstallTip() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const tip = $('#install-tip');
  if (standalone) { show(tip, false); return; }

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  show(tip, true);
  show($('#install-btn'), !!installEvent);
  $('#install-tip-desc').textContent = installEvent
    ? '버튼을 누르면 바로 추가됩니다'
    : isIOS
      ? '공유 버튼 → “홈 화면에 추가”를 눌러주세요'
      : '브라우저 메뉴 → “홈 화면에 추가”를 눌러주세요';
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  if (state.tab === 'settings') renderInstallTip();
});

/* ── 백업 ─────────────────────────────────────────────── */

async function doExport() {
  toast('백업 파일을 만들고 있어요…');
  try {
    const r = await backup.exportBackup({ includeSource: false });
    const how = await handOffFile(r.blob, r.filename, 'PICKFIT 백업');
    if (how !== 'cancel') toast(`옷 ${r.itemCount}벌을 백업했어요`);
    renderSettings();
  } catch (err) {
    console.error(err);
    toast('백업에 실패했어요');
  }
}

async function doRestore(file) {
  if (!file) return;
  let info;
  try {
    info = await backup.inspectBackup(file);
  } catch (err) {
    console.error(err);
    toast('백업 파일을 읽을 수 없어요');
    return;
  }

  const merge = confirm(
    `옷 ${info.itemCount}벌, 착용기록 ${info.wearCount}건이 담긴 백업입니다.\n\n`
    + '확인 = 지금 옷장에 추가하기\n취소 = 지금 옷장을 지우고 이 백업으로 덮어쓰기'
  );

  if (!merge && !confirm('지금 등록된 옷을 모두 지웁니다. 정말 덮어쓸까요?')) return;

  toast('복원하고 있어요…');
  try {
    const r = await backup.importBackup(file, { mode: merge ? 'merge' : 'replace' });
    toast(`옷 ${r.items}벌을 복원했어요${r.skipped ? ` (${r.skipped}개 건너뜀)` : ''}`);
    if (r.warnings?.length) console.warn('복원 경고', r.warnings);
    clearCache();
    await loadCloset();
    renderSettings();
  } catch (err) {
    console.error(err);
    toast('복원에 실패했어요');
  }
}

/* ── 이벤트 바인딩 ────────────────────────────────────── */

function toggle(arr, key) {
  const i = arr.indexOf(key);
  if (i >= 0) arr.splice(i, 1); else arr.push(key);
  return arr;
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act], [data-tab]');
  if (!el) return;
  const act = el.dataset.act;
  const key = el.dataset.key;

  if (el.dataset.tab) return setTab(el.dataset.tab);

  switch (act) {
    /* 옷장 */
    case 'filter': state.filter = key; renderCloset(); break;
    case 'open-detail': openDetail(Number(el.dataset.id)); break;
    case 'close-detail': show($('#sheet-detail'), false); loadCloset(); break;
    case 'delete-item':
      if (confirm('이 옷을 지울까요?')) {
        clearCache(state.detailId);
        await db.deleteItem(state.detailId);
        show($('#sheet-detail'), false);
        toast('지웠어요');
        loadCloset();
      }
      break;
    case 'd-cat': editDetail(i => { i.category = key; }); break;
    case 'd-season': editDetail(i => toggle(i.seasons, key)); break;
    case 'd-tpo': editDetail(i => toggle(i.tpo, key)); break;

    /* 오늘 코디 */
    case 'set-tpo':
      state.today.tpo = key || null;
      renderTpoChips();
      refreshOutfits();
      break;
    case 'weather-refresh':
      weather.clearManualTemp();
      await loadWeather();
      refreshOutfits();
      break;
    case 'wear': wearOutfit(Number(el.dataset.i)); break;
    case 'save-img': saveOutfitImage(Number(el.dataset.i)); break;

    /* 백업 · 설치 */
    case 'export': doExport(); break;
    case 'persist': {
      const r = await backup.requestPersist();
      toast(r.granted ? '영구 저장을 켰어요' : '브라우저가 허용하지 않았어요');
      renderSettings();
      break;
    }
    case 'install':
      if (installEvent) {
        installEvent.prompt();
        installEvent = null;
        renderInstallTip();
      }
      break;

    /* 옷 추가 */
    case 'open-add': openAdd(); break;
    case 'close-add': closeAdd(); break;
    case 'pick-cat': goPick(key); break;
    case 'cat-mixed': goPick(null); break;
    case 'set-cat': editTop(d => { d.category = key; d.warmth = categoryOf(key).warmth; }); break;
    case 'toggle-season': editTop(d => toggle(d.seasons, key)); break;
    case 'toggle-tpo': editTop(d => toggle(d.tpo, key)); break;
    case 'rot-l': rotateCurrent(-1); break;
    case 'rot-r': rotateCurrent(1); break;
    case 'card-keep': keepTop(); break;
    case 'card-drop': dropTop(); break;
    case 'keep-all': keepAll(); break;
    case 'retry-shot': retryShot(); break;
    case 'skip-fail': skipFail(); break;
    case 'add-more': openAdd(); break;

    /* 설정 */
    case 'seed': {
      const n = await db.seed();
      toast(`샘플 ${n}벌을 넣었어요`);
      loadCloset();
      break;
    }
    case 'clear-retakes':
      await db.clearRetakes();
      toast('비웠어요');
      renderSettings();
      loadCloset();
      break;
    case 'reset':
      if (confirm('등록한 옷과 기록을 모두 지웁니다. 계속할까요?')) {
        await db.clearAll();
        toast('초기화했어요');
        renderSettings();
        loadCloset();
      }
      break;
  }
});

document.addEventListener('input', e => {
  const act = e.target.dataset.act;
  if (act === 'set-warmth') editTop(d => { d.warmth = Number(e.target.value); });
  if (act === 'd-warmth') editDetail(i => { i.warmth = Number(e.target.value); });
  if (act === 'set-temp') {
    const v = Number(e.target.value);
    $('#temp-manual-val').textContent = `${v}°`;
    state.today.tempC = v;
  }
});

/* 슬라이더는 드래그 중 계속 값이 바뀌므로, 손을 뗐을 때만 저장하고 재계산한다 */
document.addEventListener('change', e => {
  if (e.target.dataset.act !== 'set-temp') return;
  weather.setManualTemp(Number(e.target.value));
  $('#weather-temp').textContent = `${Number(e.target.value)}°`;
  $('#weather-src').textContent = '직접 입력';
  refreshOutfits();
});

$('#file-pick').addEventListener('change', e => {
  processFiles(e.target.files);
  e.target.value = '';
});
$('#file-shot').addEventListener('change', e => {
  processFiles(e.target.files);
  e.target.value = '';
});
$('#file-replace').addEventListener('change', e => {
  onReplacePicked(e.target.files[0]);
  e.target.value = '';
});
$('#file-restore').addEventListener('change', e => {
  doRestore(e.target.files[0]);
  e.target.value = '';
});

/* ── 시작 ─────────────────────────────────────────────── */

setTab('closet');
loadCloset().catch(err => {
  console.error(err);
  toast('저장소를 열지 못했어요');
});

/* 오프라인에서도 앱이 열리게 한다. 실패해도 앱 동작에는 영향이 없어야 한다. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('서비스워커 등록 실패 (오프라인 지원만 비활성)', err);
    });
  });
}

/* 첫 등록에 성공한 시점에 영구 저장 권한을 요청한다. 사용할 이유가 생긴 뒤에
   물어야 브라우저와 사용자 모두 승인할 가능성이 높다. */
let persistAsked = false;
async function maybeAskPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { await backup.requestPersist(); } catch { /* 실패는 조용히 넘긴다 */ }
}

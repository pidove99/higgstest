// ==UserScript==
// @name         네이버 예약 취소표 자동 잡기
// @namespace    https://github.com/pidove99/higgstest
// @version      1.0.0
// @description  목·금·토·일 날짜를 돌며 열린 회차를 자동 선택하고 '다음'까지 눌러줍니다.
// @match        https://*.naver.com/*
// @run-at       document-idle
// @grant        GM_notification
// @updateURL    https://raw.githubusercontent.com/pidove99/higgstest/claude/vibrant-gauss-vxmb9k/naver-booking-watcher/naver-booking-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/pidove99/higgstest/claude/vibrant-gauss-vxmb9k/naver-booking-watcher/naver-booking-watcher.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.__rwLoaded) return;
  window.__rwLoaded = true;

  const LS = 'rw_settings_v1';
  const DEF = { days: [4, 5, 6, 0], from: '', to: '', interval: 15, dateWait: 1.2,
                reloadEvery: 10, autoNext: true, running: false, cycle: 0 };
  const load = () => { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { return Object.assign({}, DEF); } };
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} };
  let S = load();
  // 새로고침 직후(2분 이내)가 아니면 자동 재개하지 않음
  if (S.running && Date.now() - (S.beat || 0) > 120000) { S.running = false; save(); }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const KO = ['일', '월', '화', '수', '목', '금', '토'];
  const fmt = (key) => { const d = new Date(key + 'T00:00:00'); return `${d.getMonth() + 1}/${d.getDate()}(${KO[d.getDay()]})`; };

  // ---------------------------------------------------------------- 화면 인식
  function scan() {
    const t0 = new Date();
    const opts = { y: t0.getFullYear(), m: t0.getMonth() + 1, d: t0.getDate(), colorCheck: true, grayLum: 0.55 };
    const out = { ok: false, ym: null, cells: [], slots: [], reason: '' };
    const isVis = (el) => {
      if (el.closest('#rw-panel')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
    };
    const txt = (el) => (el.innerText || '').replace(/ /g, ' ').trim();
    const clsOf = (e) => (typeof e.className === 'string' ? e.className : (e.getAttribute && e.getAttribute('class')) || '');
    const all = Array.from(document.querySelectorAll('body *'));

    for (const el of all) {
      if (el.childElementCount > 3) continue;
      const t = txt(el);
      if (t.length > 14) continue;
      const m = t.match(/^(\d{4})\s*(?:\.|년|-|\/)\s*(\d{1,2})\s*(?:\.|월)?$/);
      if (m && isVis(el)) { out.ym = { y: +m[1], m: +m[2] }; break; }
    }
    if (!out.ym) { out.reason = '달력(예: 2026.11)을 찾지 못함'; return out; }

    const heads = [];
    for (const el of all) {
      if (el.childElementCount > 0) continue;
      const i = KO.indexOf(txt(el));
      if (i >= 0 && isVis(el)) { const r = el.getBoundingClientRect(); heads.push({ i, x: r.left + r.width / 2, y: r.top + r.height / 2, b: r.bottom }); }
    }
    heads.sort((a, b) => a.y - b.y);
    let row = null;
    for (let s = 0; s < heads.length && !row; s++) {
      const g = heads.filter(h => Math.abs(h.y - heads[s].y) < 8);
      if (new Set(g.map(h => h.i)).size === 7) row = g;
    }
    if (!row) { out.reason = '요일 줄(일~토)을 찾지 못함'; return out; }
    const cols = {};
    for (const h of row) if (!(h.i in cols)) cols[h.i] = h.x;
    const xs = Object.values(cols).sort((a, b) => a - b);
    const colW = (xs[6] - xs[0]) / 6;
    const headBottom = Math.max(...row.map(h => h.b));
    const maxY = headBottom + colW * 9;
    const nearestCol = (x) => { let best = -1, bd = 1e9; for (const k in cols) { const d = Math.abs(cols[k] - x); if (d < bd) { bd = d; best = +k; } } return bd <= colW * 0.45 ? best : -1; };

    const cand = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > colW * 1.3 || r.height > colW * 2.2) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy <= headBottom || cy > maxY) continue;
      const t = txt(el);
      const m = t.match(/^(\d{1,2}|오늘)(?=\s|$)/);
      if (!m || t.length > 20 || !isVis(el)) continue;
      const col = nearestCol(cx);
      if (col < 0) continue;
      cand.push({ el, t, col, cx, cy, tok: m[1] });
    }
    const cells = cand.filter(c => !cand.some(o => o !== c && o.el.contains(c.el)));
    cells.sort((a, b) => (Math.abs(a.cy - b.cy) < colW * 0.4 ? a.cx - b.cx : a.cy - b.cy));
    const sameMonth = out.ym.y === opts.y && out.ym.m === opts.m;
    let phase = null, last = 0;
    for (const c of cells) {
      const n = c.tok === '오늘' ? (sameMonth ? opts.d : null) : +c.tok;
      if (n === null || n < 1 || n > 31) continue;
      if (phase === null) phase = n > 7 ? -1 : 0;
      else if (n < last) phase += 1;
      last = n;
      if (phase !== 0) continue;
      let click = c.el.closest('button,a,[role="button"],td,li');
      if (!click || click.getBoundingClientRect().width > colW * 1.3) click = c.el;
      const key = `${out.ym.y}-${String(out.ym.m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
      click.setAttribute('data-rw-day', key);
      const dis = !!(click.disabled || click.closest('[disabled]') || click.getAttribute('aria-disabled') === 'true');
      out.cells.push({ key, day: n, wd: new Date(out.ym.y, out.ym.m - 1, n).getDay(), disabled: dis });
    }
    out.ok = out.cells.length > 0;
    if (!out.ok) out.reason = '날짜 칸을 찾지 못함';

    const sc = [];
    for (const el of all) {
      const t = txt(el);
      if (t.length > 30) continue;
      const m = t.match(/^(오전|오후)\s*(\d{1,2})\s*:\s*(\d{2})/);
      if (m && isVis(el)) sc.push({ el, t, m });
    }
    const inner = sc.filter(c => !sc.some(o => o !== c && c.el.contains(o.el)));
    const seen = new Set();
    const BAD = /(disab|unselect|sold|dim|inactive|closed|impossible|unavail|deactiv|blocked|expired|full)/i;
    const SEL = /(^|[\s_-])(selected|active|on|checked|is-selected|current)($|[\s_-])/i;
    inner.forEach((c, idx) => {
      let btn = c.el.closest('button,a,[role="button"],label,li') || c.el;
      if (inner.some(o => o !== c && btn.contains(o.el))) btn = c.el;
      if (seen.has(btn)) return;
      seen.add(btn);
      let h = (+c.m[2]) % 12; if (c.m[1] === '오후') h += 12;
      const hhmm = String(h).padStart(2, '0') + ':' + c.m[3];
      const chain = [];
      for (let p = c.el; p; p = p.parentElement) { chain.push(p); if (p === btn) break; }
      const clsAll = chain.map(clsOf).join(' ');
      const reasons = [];
      if (btn.disabled || c.el.closest('[disabled]')) reasons.push('disabled');
      if (chain.some(e => e.getAttribute('aria-disabled') === 'true')) reasons.push('aria');
      if (BAD.test(clsAll)) reasons.push('class');
      if (/매진|마감|불가|대기/.test(txt(btn))) reasons.push('text');
      const st = getComputedStyle(btn);
      if (st.pointerEvents === 'none') reasons.push('pe');
      if (parseFloat(st.opacity) < 0.5) reasons.push('opacity');
      const selected = SEL.test(clsAll) || ['aria-pressed', 'aria-selected', 'aria-checked'].some(a => btn.getAttribute(a) === 'true');
      if (opts.colorCheck && !selected) {
        const rgb = (getComputedStyle(c.el).color.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
        if ((0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > opts.grayLum) reasons.push('gray');
      }
      btn.setAttribute('data-rw-slot', String(idx));
      out.slots.push({ idx: String(idx), label: c.t.split('\n')[0].trim(), hhmm, selected,
                       available: reasons.length === 0 && !selected,
                       sig: [clsAll, btn.getAttribute('aria-pressed'), btn.getAttribute('aria-selected'), st.backgroundColor, st.color].join('|') });
    });
    return out;
  }

  // ---------------------------------------------------------------- 동작
  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  async function clickNext() {
    const RE = /^\s*다음(\s*단계)?\s*$/;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(b => !b.closest('#rw-panel') && RE.test(b.innerText || ''));
      for (const b of btns.reverse()) {
        const r = b.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (b.disabled || b.getAttribute('aria-disabled') === 'true' || /(disab|dim|inactive|unselect)/i.test(b.className || '')) continue;
        realClick(b);
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < 5; i++) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 1500; o.connect(g); g.connect(audio.destination);
        const t = audio.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.3, t); g.gain.setValueAtTime(0, t + 0.25);
        o.start(t); o.stop(t + 0.3);
      }
    } catch (e) {}
  }
  function alertUser(msg) {
    beep();
    try { if (typeof GM_notification === 'function') GM_notification({ title: '취소표 잡음!', text: msg }); } catch (e) {}
    let n = 0; const orig = document.title;
    const iv = setInterval(() => { document.title = (n++ % 2) ? orig : '🔔 취소표 잡음!'; if (n > 40) { clearInterval(iv); document.title = orig; } }, 700);
  }

  const inRange = (hhmm) => (!S.from || hhmm >= S.from) && (!S.to || hhmm <= S.to);

  async function cycle() {
    let res = scan();
    if (!res.ok) {
      const tab = Array.from(document.querySelectorAll('a,button,[role="tab"]')).find(e => (e.innerText || '').trim() === '예약하기');
      if (tab) { realClick(tab); await sleep(2000); res = scan(); }
      if (!res.ok) { status('⚠️ ' + res.reason + ' — 예약 달력을 띄워주세요'); return false; }
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const targets = res.cells.filter(c => S.days.includes(c.wd) && !c.disabled && new Date(c.key + 'T00:00:00') >= today);
    if (!targets.length) { status('대상 날짜 없음 (요일 설정 확인)'); return false; }
    const summary = [];
    for (const t of targets) {
      if (!S.running) return false;
      scan();
      const cell = document.querySelector(`[data-rw-day="${t.key}"]`);
      if (!cell) { summary.push(fmt(t.key) + ':?'); continue; }
      realClick(cell);
      status(`${fmt(t.key)} 확인 중... (#${S.cycle})`);
      await sleep(S.dateWait * 1000 + Math.random() * 500);
      const after = scan();
      const cands = after.slots.filter(s => s.available && inRange(s.hhmm));
      summary.push(`${fmt(t.key)}:${cands.length}/${after.slots.length}`);
      for (const s of cands) {
        const btn = document.querySelector(`[data-rw-slot="${s.idx}"]`);
        if (!btn) continue;
        realClick(btn);
        await sleep(800);
        const chk = scan().slots.find(x => x.label === s.label);
        if (chk && !chk.selected && chk.sig === s.sig) continue;   // 오인식 → 다음 후보
        let step = '회차 선택';
        if (S.autoNext) step += (await clickNext()) ? ' + 다음 클릭' : " (다음 버튼 직접 누르세요)";
        S.running = false; save(); render();
        const msg = `${fmt(t.key)} ${s.label} ${step} 완료! 예약을 마무리하세요.`;
        status('✅ ' + msg);
        alertUser(msg);
        return true;
      }
    }
    status(`#${S.cycle} ` + summary.join('  '));
    return false;
  }

  async function loop() {
    while (S.running) {
      S.cycle += 1; S.beat = Date.now(); save();
      let done = false;
      try { done = await cycle(); } catch (e) { status('오류: ' + e.message); }
      if (done || !S.running) break;
      const wait = Math.max(5, S.interval) * (0.8 + Math.random() * 0.5) * 1000;
      const end = Date.now() + wait;
      while (S.running && Date.now() < end) await sleep(250);
      if (S.running && S.reloadEvery > 0 && S.cycle % S.reloadEvery === 0) {
        S.beat = Date.now(); save();
        status('새로고침...'); await sleep(300); location.reload(); return;
      }
    }
  }

  // ---------------------------------------------------------------- 패널 UI
  let panel = null, statusEl = null;
  function status(t) { if (statusEl) statusEl.textContent = t; }
  function render() {
    if (!panel) return;
    panel.querySelector('#rw-go').textContent = S.running ? '■ 중지' : '▶ 시작';
    panel.querySelector('#rw-go').style.background = S.running ? '#e5484d' : '#03c75a';
  }
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'rw-panel';
    panel.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;width:250px;background:#fff;border:2px solid #03c75a;border-radius:10px;padding:10px;font:13px/1.5 sans-serif;color:#222;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    const dayBoxes = [4, 5, 6, 0, 1, 2, 3].map(i => `<label style="margin-right:4px"><input type="checkbox" data-wd="${i}" ${S.days.includes(i) ? 'checked' : ''}>${KO[i]}</label>`).join('');
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:4px;cursor:pointer" id="rw-title">🎫 취소표 자동 잡기 <span style="float:right">－</span></div>
      <div id="rw-body">
        <div>${dayBoxes}</div>
        <div>시간대 <input id="rw-from" placeholder="12:00" size="5" value="${S.from}"> ~ <input id="rw-to" placeholder="18:00" size="5" value="${S.to}"></div>
        <div>간격 <input id="rw-int" type="number" min="5" style="width:48px" value="${S.interval}">초 · 새로고침 <input id="rw-rel" type="number" min="0" style="width:40px" value="${S.reloadEvery}">바퀴</div>
        <div><label><input type="checkbox" id="rw-next" ${S.autoNext ? 'checked' : ''}> '다음' 버튼까지 자동 클릭</label></div>
        <button id="rw-go" style="width:100%;margin-top:6px;padding:8px;border:0;border-radius:6px;color:#fff;font-weight:bold;cursor:pointer"></button>
      </div>
      <div id="rw-status" style="margin-top:6px;font-size:12px;color:#555;word-break:keep-all">대기 중</div>`;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#rw-status');
    panel.querySelector('#rw-title').onclick = () => { const b = panel.querySelector('#rw-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
    const readForm = () => {
      S.days = Array.from(panel.querySelectorAll('[data-wd]')).filter(x => x.checked).map(x => +x.dataset.wd);
      const norm = (v) => { const m = (v || '').trim().match(/^(\d{1,2}):(\d{2})$/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
      S.from = norm(panel.querySelector('#rw-from').value);
      S.to = norm(panel.querySelector('#rw-to').value);
      S.interval = Math.max(5, +panel.querySelector('#rw-int').value || 15);
      S.reloadEvery = Math.max(0, +panel.querySelector('#rw-rel').value || 0);
      S.autoNext = panel.querySelector('#rw-next').checked;
      save();
    };
    panel.querySelectorAll('input').forEach(i => i.addEventListener('change', readForm));
    panel.querySelector('#rw-go').onclick = () => {
      readForm();
      try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) {}
      S.running = !S.running;
      if (S.running) { S.cycle = 0; S.beat = Date.now(); }
      save(); render();
      if (S.running) { status('시작!'); loop(); } else status('중지됨');
    };
    render();
  }

  // 예약 달력이 있는 화면(네이버지도 iframe 포함)에서만 패널을 띄운다
  let tries = 0;
  const finder = setInterval(() => {
    tries++;
    if (!document.body) return;
    const text = document.body.innerText || '';
    const likely = /일\s*월\s*화\s*수\s*목\s*금\s*토/.test(text) && /(오전|오후)\s*\d{1,2}:\d{2}|회차|예약/.test(text);
    if (likely && scan().ok) {
      clearInterval(finder);
      buildPanel();
      if (S.running) { status('새로고침 후 이어서 감시'); loop(); }
    } else if (S.running && tries === 8) {
      // 새로고침 뒤 달력이 안 보이면 '예약하기' 탭을 눌러본다
      const tab = Array.from(document.querySelectorAll('a,button,[role="tab"]')).find(e => (e.innerText || '').trim() === '예약하기');
      if (tab) realClick(tab);
    }
  }, 1500);
})();

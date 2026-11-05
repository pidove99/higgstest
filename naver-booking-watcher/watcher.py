#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
네이버 예약 취소표(회차) 감시 + 자동 선택 매크로

동작
  1) 네이버 예약 달력 화면(예: 네이버지도 > 매장 > 예약하기)을 브라우저로 띄운다.
  2) 목/금/토/일(기본값) 날짜를 차례로 눌러본다.
  3) 회차 버튼 중 '선택 가능한' 것이 나오면 자동으로 눌러서 선택해 둔다.
  4) 달력 아래 '다음' 버튼이 활성화되면 그것까지 누른다. (--no-next 로 끌 수 있음)
  5) 알림(소리 / 선택 시 텔레그램) 후 멈춘다. 이후 정보 입력·예약 확정은 직접 진행.

클래스명이 바뀌어도 동작하도록 화면 구조로 요소를 찾는다.
  - 달력: "2026.11" 같은 연/월 헤더 + '일 월 화 수 목 금 토' 요일 줄
  - 날짜: 요일 열에 맞춰 놓인 숫자(또는 '오늘') 칸
  - 회차: "오전 10:30" / "오후 3:00" 형태의 버튼
  - 선택 가능 여부: disabled / aria-disabled / 클래스(unselectable, soldout, disabled...) /
    '매진·마감' 문구 / 흐린 글자색 등을 종합해 판단

처음엔 --inspect 로 인식 결과를 꼭 확인하세요. (README.md 참고)
"""
import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, Error as PWError
except ImportError:  # pragma: no cover
    print("playwright 가 필요합니다:  pip install -r requirements.txt  후  playwright install chromium")
    sys.exit(1)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
WEEKDAY_KO = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}  # python weekday()
KO_WEEKDAY = "월화수목금토일"

# ---------------------------------------------------------------------------
# 페이지 안에서 실행되는 인식 스크립트
# ---------------------------------------------------------------------------
SCAN_JS = r"""
(opts) => {
  const out = { ok: false, ym: null, cells: [], slots: [], reason: '' };
  const isVis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  };
  const txt = (el) => (el.innerText || '').replace(/ /g, ' ').trim();
  const clsOf = (e) => (typeof e.className === 'string' ? e.className : (e.getAttribute && e.getAttribute('class')) || '');
  const all = Array.from(document.querySelectorAll('body *'));

  // 1) 연/월 헤더 (2026.11 / 2026. 11. / 2026년 11월)
  for (const el of all) {
    if (el.childElementCount > 3) continue;
    const t = txt(el);
    if (t.length > 14) continue;
    const m = t.match(/^(\d{4})\s*(?:\.|년|-|\/)\s*(\d{1,2})\s*(?:\.|월)?$/);
    if (m && isVis(el)) { out.ym = { y: +m[1], m: +m[2] }; break; }
  }
  if (!out.ym) { out.reason = '달력 연/월 헤더(예: 2026.11)를 찾지 못함'; return out; }

  // 2) 요일 헤더 줄
  const names = ['일', '월', '화', '수', '목', '금', '토'];
  const heads = [];
  for (const el of all) {
    if (el.childElementCount > 0) continue;
    const i = names.indexOf(txt(el));
    if (i >= 0 && isVis(el)) {
      const r = el.getBoundingClientRect();
      heads.push({ i, x: r.left + r.width / 2, y: r.top + r.height / 2, b: r.bottom });
    }
  }
  heads.sort((a, b) => a.y - b.y);
  let row = null;
  for (let s = 0; s < heads.length && !row; s++) {
    const g = heads.filter(h => Math.abs(h.y - heads[s].y) < 8);
    if (new Set(g.map(h => h.i)).size === 7) row = g;
  }
  if (!row) { out.reason = "요일 헤더(일~토)를 찾지 못함"; return out; }
  const cols = {};
  for (const h of row) if (!(h.i in cols)) cols[h.i] = h.x;
  const xs = Object.values(cols).sort((a, b) => a - b);
  const colW = (xs[6] - xs[0]) / 6;
  const headBottom = Math.max(...row.map(h => h.b));
  const maxY = headBottom + colW * 9;
  const nearestCol = (x) => {
    let best = -1, bd = 1e9;
    for (const k in cols) { const d = Math.abs(cols[k] - x); if (d < bd) { bd = d; best = +k; } }
    return bd <= colW * 0.45 ? best : -1;
  };

  // 3) 날짜 칸
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

  const sameMonthAsToday = out.ym.y === opts.y && out.ym.m === opts.m;
  let phase = null, last = 0;
  for (const c of cells) {
    let n = c.tok === '오늘' ? (sameMonthAsToday ? opts.d : null) : +c.tok;
    if (n === null || n < 1 || n > 31) continue;
    if (phase === null) phase = n > 7 ? -1 : 0;
    else if (n < last) phase += 1;
    last = n;
    if (phase !== 0) continue;               // 이전/다음 달 칸은 제외
    let click = c.el.closest('button,a,[role="button"],td,li');
    if (!click || click.getBoundingClientRect().width > colW * 1.3) click = c.el;
    const key = `${out.ym.y}-${String(out.ym.m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    click.setAttribute('data-rw-day', key);
    const dis = !!(click.disabled || click.closest('[disabled]') || click.getAttribute('aria-disabled') === 'true');
    const wd = new Date(out.ym.y, out.ym.m - 1, n).getDay();
    out.cells.push({ key, day: n, text: c.t.replace(/\s+/g, ' '), disabled: dis,
                     soldout: /매진/.test(c.t), cls: clsOf(click).slice(0, 100),
                     colMismatch: wd !== c.col });
  }
  out.ok = out.cells.length > 0;
  if (!out.ok) out.reason = '날짜 칸을 찾지 못함';

  // 4) 회차 버튼
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
    if (chain.some(e => e.getAttribute('aria-disabled') === 'true')) reasons.push('aria-disabled');
    const bm = clsAll.match(BAD); if (bm) reasons.push('class:' + bm[0]);
    if (/매진|마감|불가|대기/.test(txt(btn))) reasons.push('text');
    const st = getComputedStyle(btn);
    if (st.pointerEvents === 'none') reasons.push('pointer-events');
    if (parseFloat(st.opacity) < 0.5) reasons.push('opacity');
    const selected = SEL.test(clsAll) || btn.getAttribute('aria-pressed') === 'true' ||
                     btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-checked') === 'true';
    if (opts.colorCheck && !selected) {
      const rgb = (getComputedStyle(c.el).color.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
      const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      if (lum > opts.grayLum) reasons.push('gray-text(' + lum.toFixed(2) + ')');
    }
    btn.setAttribute('data-rw-slot', String(idx));
    out.slots.push({ idx: String(idx), label: c.t.split('\n')[0].trim(), hhmm,
                     available: reasons.length === 0 && !selected, selected, reasons,
                     cls: clsAll.slice(0, 120),
                     sig: [clsAll, btn.getAttribute('aria-pressed'), btn.getAttribute('aria-selected'),
                           st.backgroundColor, st.color, st.borderColor].join('|') });
  });
  out.bodyLen = (document.body.innerText || '').length;
  return out;
}
"""


# ---------------------------------------------------------------------------
# 유틸
# ---------------------------------------------------------------------------
def log(msg):
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def beep(times=5):
    try:
        import winsound  # Windows
        for _ in range(times):
            winsound.Beep(1500, 250)
            time.sleep(0.1)
        return
    except Exception:
        pass
    for _ in range(times):
        print("\a", end="", flush=True)
        time.sleep(0.3)


def telegram(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return
    try:
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=10)
    except Exception as e:
        log(f"텔레그램 전송 실패: {e}")


def notify(text):
    log("🔔 " + text)
    telegram(text)
    beep()


def parse_hhmm(s):
    """'15:30', '오후 3:30', '오전 10:00' -> 'HH:MM'"""
    s = s.strip()
    m = re.match(r"^(오전|오후)?\s*(\d{1,2})\s*:\s*(\d{2})$", s)
    if not m:
        raise argparse.ArgumentTypeError(f"시간 형식 오류: {s!r} (예: 15:30, 오후 3:30)")
    h = int(m.group(2))
    if m.group(1):
        h = h % 12 + (12 if m.group(1) == "오후" else 0)
    return f"{h:02d}:{m.group(3)}"


def scan_opts(args):
    t = dt.date.today()
    return {"y": t.year, "m": t.month, "d": t.day,
            "colorCheck": not args.no_color_check, "grayLum": args.gray_lum}


def scan(frame, args):
    return frame.evaluate(SCAN_JS, scan_opts(args))


def find_booking_frame(ctx, args):
    """모든 탭/iframe 중 예약 달력이 있는 곳을 찾는다 (네이버지도는 iframe 안에 있음)."""
    last_reason = ""
    for page in reversed(ctx.pages):
        for fr in page.frames:
            try:
                res = scan(fr, args)
            except PWError:
                continue
            if res.get("ok"):
                return page, fr, res
            if res.get("reason") and res.get("ym"):
                last_reason = res["reason"]
    return None, None, last_reason


def try_open_booking_tab(ctx):
    """'예약하기' 탭/버튼을 눌러 달력을 다시 띄워본다."""
    for page in reversed(ctx.pages):
        for fr in page.frames:
            try:
                loc = fr.get_by_text("예약하기", exact=True)
                if loc.count() > 0:
                    loc.first.click(timeout=2000)
                    time.sleep(2.0)
                    return True
            except PWError:
                continue
    return False


def ensure_frame(ctx, args, interactive):
    page, fr, res = find_booking_frame(ctx, args)
    if fr:
        return page, fr, res
    try_open_booking_tab(ctx)
    page, fr, res = find_booking_frame(ctx, args)
    if fr:
        return page, fr, res
    if not interactive:
        raise RuntimeError(f"예약 달력을 찾지 못했습니다. {res or ''}")
    beep(2)
    input(f"⚠️  예약 달력을 찾지 못했습니다 ({res or '화면 확인 필요'}).\n"
          "    브라우저에서 예약 달력/회차 화면을 띄운 뒤 Enter 를 누르세요...")
    return ensure_frame(ctx, args, interactive)


def pick_dates(cells, args):
    today = dt.date.today()
    explicit = None
    if args.dates:
        explicit = set()
        for tok in re.split(r"[,\s]+", args.dates.strip()):
            if not tok:
                continue
            explicit.add(int(tok) if tok.isdigit() else dt.date.fromisoformat(tok))
    wds = {WEEKDAY_KO[c] for c in args.days if c in WEEKDAY_KO}
    out = []
    for c in cells:
        d = dt.date.fromisoformat(c["key"])
        if d < today:
            continue
        if explicit is not None:
            if d not in explicit and d.day not in explicit:
                continue
        elif d.weekday() not in wds:
            continue
        if args.until and d > args.until:
            continue
        if c["disabled"] and not args.include_disabled:
            continue
        out.append(c)
    if args.max_dates:
        out = out[: args.max_dates]
    return out


def time_ok(hhmm, args):
    if args.times and hhmm not in args.times:
        return False
    if args.time_from and hhmm < args.time_from:
        return False
    if args.time_to and hhmm > args.time_to:
        return False
    return True


def order_slots(slots, args):
    if args.times:
        rank = {t: i for i, t in enumerate(args.times)}
        return sorted(slots, key=lambda s: rank.get(s["hhmm"], 999))
    return slots


def label_date(key):
    d = dt.date.fromisoformat(key)
    return f"{d.month}/{d.day}({KO_WEEKDAY[d.weekday()]})"


def click_slot_and_verify(frame, slot, args):
    """회차를 누르고 실제로 선택됐는지 확인. (흐린 버튼을 잘못 인식한 경우 거르기)"""
    before = slot["sig"]
    frame.locator(f'[data-rw-slot="{slot["idx"]}"]').first.click(timeout=3000)
    time.sleep(0.8)
    after = scan(frame, args)
    same = [s for s in after["slots"] if s["label"] == slot["label"]]
    if not same:
        return True  # 다음 단계 화면으로 넘어감
    s = same[0]
    return s["selected"] or s["sig"] != before


NEXT_RE = re.compile(r"^\s*다음(\s*단계)?\s*$")
NEXT_BAD = re.compile(r"(disab|dim|inactive|unselect)", re.I)


def click_next(page, frame, timeout=6.0):
    """회차 선택 후 활성화되는 '다음' 버튼을 찾아 누른다. 누른 뒤 화면이 넘어갔는지까지 확인."""
    frames = [frame] + [f for f in page.frames if f is not frame]
    deadline = time.time() + timeout
    while time.time() < deadline:
        for fr in frames:
            try:
                loc = fr.locator('button, a, [role="button"], input[type="button"], input[type="submit"]') \
                        .filter(has_text=NEXT_RE)
                for i in range(loc.count() - 1, -1, -1):
                    b = loc.nth(i)
                    if not b.is_visible() or not b.is_enabled():
                        continue
                    if b.get_attribute("aria-disabled") == "true" or NEXT_BAD.search(b.get_attribute("class") or ""):
                        continue
                    b.scroll_into_view_if_needed(timeout=2000)
                    b.click(timeout=3000)
                    time.sleep(1.0)
                    # 버튼이 사라졌거나(다음 화면) 더 이상 누를 수 없으면 성공으로 본다
                    try:
                        still = b.is_visible() and b.is_enabled()
                    except PWError:
                        still = False
                    if still:
                        log("'다음' 을 눌렀는데 화면이 그대로입니다 (필수 체크 항목이 있는지 확인).")
                    return True
            except PWError:
                continue
        time.sleep(0.3)
    return False


# ---------------------------------------------------------------------------
# 실행 모드
# ---------------------------------------------------------------------------
def open_context(p, args):
    if args.cdp:
        browser = p.chromium.connect_over_cdp(args.cdp)
        if not browser.contexts:
            raise RuntimeError("CDP 로 연결된 크롬에 열린 창이 없습니다.")
        return browser.contexts[0]
    profile = Path(args.profile).expanduser().resolve()
    profile.mkdir(parents=True, exist_ok=True)
    kw = dict(user_data_dir=str(profile), headless=args.headless, locale="ko-KR")
    if args.headless:
        kw["viewport"] = {"width": 1480, "height": 1240}
    else:
        kw["no_viewport"] = True
        kw["args"] = ["--start-maximized"]
    if args.chrome_path:
        return p.chromium.launch_persistent_context(executable_path=args.chrome_path, **kw)
    if not args.bundled_chromium:
        try:
            return p.chromium.launch_persistent_context(channel="chrome", **kw)
        except PWError:
            log("설치된 Chrome 을 못 찾아 Playwright Chromium 으로 실행합니다.")
    return p.chromium.launch_persistent_context(**kw)


def run_inspect(ctx, args):
    page, fr, res = ensure_frame(ctx, args, interactive=not args.headless)
    print(f"\n[달력] {res['ym']['y']}.{res['ym']['m']}  (frame: {fr.url[:90]})")
    for c in res["cells"]:
        flag = []
        if c["disabled"]:
            flag.append("disabled")
        if c["soldout"]:
            flag.append("매진")
        if c["colMismatch"]:
            flag.append("요일열 불일치!")
        print(f"  {label_date(c['key']):>9}  '{c['text']}'  {' '.join(flag)}  cls={c['cls']}")
    print(f"\n[회차] {len(res['slots'])}개 (현재 선택된 날짜 기준)")
    for s in res["slots"]:
        st = "✅ 가능" if s["available"] else ("◉ 선택됨" if s["selected"] else "✖ 불가")
        print(f"  {s['label']:<10} {st:<6} {', '.join(s['reasons'])}  cls={s['cls']}")
    print("\n[대상 날짜]", ", ".join(label_date(c["key"]) for c in pick_dates(res["cells"], args)) or "(없음)")
    (HERE / "inspect.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n자세한 결과: {HERE / 'inspect.json'}")


def run_watch(ctx, args):
    interactive = not args.headless
    cycle = 0
    started = time.time()
    while True:
        cycle += 1
        if args.max_minutes and time.time() - started > args.max_minutes * 60:
            log("최대 실행 시간 도달 → 종료")
            return False
        page, fr, res = ensure_frame(ctx, args, interactive)
        if args.reload_every and cycle > 1 and (cycle - 1) % args.reload_every == 0:
            log("페이지 새로고침")
            page.reload(wait_until="domcontentloaded")
            time.sleep(3)
            page, fr, res = ensure_frame(ctx, args, interactive)

        targets = pick_dates(res["cells"], args)
        if not targets:
            log("대상 날짜가 없습니다. --days / --dates / --until 을 확인하세요.")
            return False
        summary = []
        for t in targets:
            key = t["key"]
            try:
                cur = scan(fr, args)
                if not any(c["key"] == key for c in cur["cells"]):
                    summary.append(f"{label_date(key)}:?")
                    continue
                fr.locator(f'[data-rw-day="{key}"]').first.click(timeout=3000)
            except PWError as e:
                summary.append(f"{label_date(key)}:클릭실패")
                log(f"{label_date(key)} 클릭 실패: {str(e).splitlines()[0]}")
                break  # 프레임이 바뀌었을 수 있음 → 다음 사이클에서 다시 찾기
            time.sleep(args.date_wait + random.uniform(0, 0.5))
            try:
                after = scan(fr, args)
            except PWError:
                break
            slots = after["slots"]
            cands = order_slots([s for s in slots if s["available"] and time_ok(s["hhmm"], args)], args)
            summary.append(f"{label_date(key)}:{len(cands)}/{len(slots)}")
            if not cands:
                continue

            names = ", ".join(s["label"] for s in cands)
            if args.dry_run:
                notify(f"[취소표] {label_date(key)} 회차 열림: {names}  (dry-run: 클릭 안 함)")
                return True
            for s in cands:
                try:
                    if click_slot_and_verify(fr, s, args):
                        step = "회차 선택"
                        if not args.no_next:
                            if click_next(page, fr):
                                step = "회차 선택 + '다음' 클릭"
                            else:
                                step = "회차 선택 ('다음' 버튼은 못 찾음 → 직접 누르세요)"
                        shot = HERE / "shots" / f"{dt.datetime.now():%Y%m%d_%H%M%S}.png"
                        shot.parent.mkdir(exist_ok=True)
                        try:
                            page.screenshot(path=str(shot))
                        except PWError:
                            pass
                        notify(f"[취소표 잡음] {label_date(key)} {s['label']} {step} 완료! "
                               f"브라우저에서 예약을 마무리하세요. (스크린샷: {shot.name})")
                        return True
                    log(f"{label_date(key)} {s['label']}: 눌렀지만 선택되지 않음 → 오인식으로 보고 건너뜀")
                except PWError as e:
                    log(f"{s['label']} 클릭 실패: {str(e).splitlines()[0]}")
        log(f"#{cycle} 가능/전체 회차  " + "  ".join(summary))
        wait = args.interval * random.uniform(0.8, 1.3)
        time.sleep(wait)


def main():
    ap = argparse.ArgumentParser(description="네이버 예약 취소표 감시 + 회차 자동 선택")
    ap.add_argument("--url", help="처음 열 주소 (네이버지도 매장 주소나 booking.naver.com 예약 주소)")
    ap.add_argument("--days", default="목금토일", help="눌러볼 요일 (기본: 목금토일)")
    ap.add_argument("--dates", help="특정 날짜만: '6,7,13' 또는 '2026-11-06,2026-11-07'")
    ap.add_argument("--until", type=dt.date.fromisoformat, help="이 날짜까지만 확인 (YYYY-MM-DD)")
    ap.add_argument("--max-dates", type=int, default=0, help="가까운 날짜부터 최대 N개만")
    ap.add_argument("--times", type=lambda s: [parse_hhmm(x) for x in s.split(",") if x.strip()],
                    help="원하는 회차만 (우선순위 순): '오후 3:00,15:30'")
    ap.add_argument("--from", dest="time_from", type=parse_hhmm, help="이 시간 이후 회차만 (예: 12:00)")
    ap.add_argument("--to", dest="time_to", type=parse_hhmm, help="이 시간 이전 회차만 (예: 18:00)")
    ap.add_argument("--interval", type=float, default=15, help="한 바퀴 돈 뒤 쉬는 시간(초, 기본 15)")
    ap.add_argument("--date-wait", type=float, default=1.2, help="날짜 클릭 후 회차 로딩 대기(초)")
    ap.add_argument("--reload-every", type=int, default=10, help="N바퀴마다 새로고침 (0=안 함)")
    ap.add_argument("--max-minutes", type=float, default=0, help="최대 실행 시간(분, 0=무제한)")
    ap.add_argument("--dry-run", action="store_true", help="회차를 누르지 않고 알림만")
    ap.add_argument("--no-next", action="store_true", help="회차만 선택하고 '다음' 버튼은 누르지 않기")
    ap.add_argument("--inspect", action="store_true", help="인식 결과만 출력하고 종료")
    ap.add_argument("--include-disabled", action="store_true", help="비활성 날짜도 눌러보기")
    ap.add_argument("--no-color-check", action="store_true", help="흐린 글자색으로 불가 판단하지 않기")
    ap.add_argument("--gray-lum", type=float, default=0.55, help="이 밝기 이상 글자는 '흐림'으로 판단")
    ap.add_argument("--cdp", help="이미 켜둔 크롬에 붙기: http://127.0.0.1:9222")
    ap.add_argument("--profile", default=str(HERE / "chrome-profile"), help="로그인 유지용 브라우저 프로필 폴더")
    ap.add_argument("--bundled-chromium", action="store_true", help="설치된 Chrome 대신 Playwright Chromium 사용")
    ap.add_argument("--chrome-path", help="크롬 실행 파일 경로를 직접 지정")
    ap.add_argument("--headless", action="store_true", help="창 없이 실행 (테스트용)")
    args = ap.parse_args()

    if args.interval < 5:
        log("interval 이 너무 짧으면 네이버에서 차단될 수 있어 5초로 올립니다.")
        args.interval = 5

    with sync_playwright() as p:
        ctx = open_context(p, args)
        page = ctx.pages[-1] if ctx.pages else ctx.new_page()
        if args.url:
            page.goto(args.url, wait_until="domcontentloaded")
        if not args.headless:
            input("\n👉 브라우저에서 네이버 로그인 후, 예약 달력(회차 선택) 화면을 띄우고 Enter 를 누르세요...")
        else:
            time.sleep(1.5)

        if args.inspect:
            run_inspect(ctx, args)
            return
        log(f"감시 시작: 요일={args.days if not args.dates else args.dates}, 간격≈{args.interval:.0f}s"
            + ("  [dry-run]" if args.dry_run else ""))
        try:
            ok = run_watch(ctx, args)
        except KeyboardInterrupt:
            log("중지됨")
            return
        if ok and not args.headless:
            input("\n✅ 브라우저에서 예약을 마무리하세요. 끝나면 Enter (창이 닫힙니다)...")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

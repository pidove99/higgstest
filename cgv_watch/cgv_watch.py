"""CGV 회차 오픈 알림 스크립트.

CGV '영화별 예매' 화면을 일정 간격으로 새로고침하면서 지정한 극장 버튼을 차례로 눌러보고,
원하는 시간대(예: 06:00~12:00)에 시작하는 회차가 올라오면 PC 알림 + 소리로 알려준다.
예매/결제는 하지 않는다.

사용 예:
    python cgv_watch.py --url "<영화·날짜를 고른 상태의 CGV 예매 URL>" \
        --movie "치이카와" --date 30 \
        --theater 왕십리 --theater 용산아이파크몰 --theater 홍대 --theater 여의도 \
        --from 06:00 --to 12:00 --headed
"""

import argparse
import platform
import random
import re
import subprocess
import sys
import time
import urllib.request
import webbrowser
from datetime import datetime

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

MIN_INTERVAL = 0  # 0이면 한 바퀴 끝나자마자 바로 다음 바퀴
NO_SCHEDULE = "스케줄이 없습니다"
TIME = r"([01]?\d|2[0-9]):([0-5]\d)"
START_END_PATTERN = re.compile(TIME + r"\s*[~\-–]\s*" + TIME)
TIME_PATTERN = re.compile(r"(?<![\d.])" + TIME + r"(?!\d)")


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def to_minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def start_times(text):
    """화면 텍스트에서 회차 시작 시각 목록을 뽑는다. 'HH:MM ~ HH:MM' 형식이면 앞쪽만 쓴다."""
    if NO_SCHEDULE in text:
        return []
    pairs = START_END_PATTERN.findall(text)
    if pairs:
        found = [f"{int(h):02d}:{m}" for h, m, _, _ in pairs]
    else:
        found = [f"{int(h):02d}:{m}" for h, m in TIME_PATTERN.findall(text)]
    return sorted(set(found))


def _click_visible(page, label):
    for locator in (
        page.get_by_role("button", name=label, exact=True),
        page.get_by_role("tab", name=label, exact=True),
        page.get_by_text(label, exact=True),
    ):
        try:
            # 같은 글자가 숨은 요소에도 있을 수 있어서, 화면에 보이는 것부터 누른다
            for item in locator.all():
                if item.is_visible():
                    try:
                        item.click(timeout=3_000)
                    except Exception:
                        # 날짜 줄처럼 옆으로 밀리는 슬라이드에서는 버튼이 화면 밖에 있어 일반 클릭이 안 된다.
                        # 그럴 때는 요소에 직접 클릭 이벤트를 보낸다.
                        item.evaluate("el => el.click()")
                    return True
        except Exception:
            continue
    return False


def click_text(page, label):
    """버튼/칩을 보이는 글자 그대로 찾아 누른다."""
    if _click_visible(page, label):
        return True
    # 안내 팝업(예: 상영 일정 없음)이 버튼을 가리고 있을 수 있어 닫고 한 번 더 시도한다
    page.keyboard.press("Escape")
    for text in ("확인", "닫기"):
        try:
            btn = page.get_by_role("button", name=text, exact=True)
            if btn.count() and btn.first.is_visible():
                btn.first.click(timeout=2_000)
                break
        except Exception:
            pass
    page.wait_for_timeout(300)
    return _click_visible(page, label)


def open_showtime(page, args, label, hhmm):
    """감시 중인 창에서 날짜·극장·회차 버튼을 눌러 좌석 선택 화면까지만 연다. 좌석은 고르지 않는다."""
    date, theater = args.targets[label]
    if date and len(args.date) > 1:
        if not click_text(page, date):
            return False
        settle(page, 0.5, idle_timeout=2)
    if not click_text(page, theater):
        return False
    settle(page, args.settle, idle_timeout=3)
    labels = [hhmm] + ([hhmm[1:]] if hhmm.startswith("0") else [])
    for label in labels:
        if click_text(page, label):
            return True
    return False


def hold_window(opened):
    """좌석 화면을 연 브라우저가 닫히지 않도록 사용자가 끝낼 때까지 기다린다."""
    if opened:
        print("\n크롬 창에 좌석 선택 화면을 열어 두었습니다. 좌석 선택과 결제는 직접 하세요.")
    else:
        print("\n회차 버튼을 누르지 못했습니다. 크롬 창에서 직접 회차를 눌러 주세요.")
    input("예매를 마치면 여기서 Enter를 눌러 종료하세요. (먼저 누르면 크롬 창이 닫힙니다)\n")


PAGE_TEXT_JS = """() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
    const t = walker.currentNode.textContent.trim();
    if (t) out.push(t);
  }
  return out.join("\\n");
}"""


def page_text(page):
    """화면 글자를 요소마다 줄을 나눠 읽는다. (나란히 붙은 시간 버튼이 '13:2015:30'처럼 붙지 않게)"""
    return page.evaluate(PAGE_TEXT_JS)


def settle(page, seconds, idle_timeout=10):
    try:
        page.wait_for_load_state("networkidle", timeout=idle_timeout * 1000)
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(int(seconds * 1000))


def check_once(page, args):
    """새로고침 후 극장별로 눌러보고 {극장: [시작시각...]}(시간대 안쪽만)을 돌려준다."""
    if args.reload:
        page.reload(wait_until="domcontentloaded", timeout=45_000)
        settle(page, args.settle)
    body = page_text(page)
    if args.movie and args.movie not in body:
        log(f"화면에서 '{args.movie}'를 찾지 못했습니다. 새로고침하면 영화 선택이 풀리는지 확인하세요.")
    # 날짜가 하나이고 새로고침하지 않으면 날짜 선택이 그대로 유지되므로 다시 누르지 않는다
    dates = args.date or [None]
    click_dates = len(dates) > 1 or args.reload or bool(args.refresh_date)

    result, dumps = {}, {}
    for date in dates:
        if args.refresh_date:
            # 시간표를 확실히 새로 불러오도록 다른 날짜를 먼저 눌렀다가 돌아온다 (그 날짜 결과는 보지 않음)
            if click_text(page, args.refresh_date):
                settle(page, 0.5, idle_timeout=2)
            else:
                log(f"새로고침용 날짜 '{args.refresh_date}' 버튼을 찾지 못했습니다.")
        if date and click_dates:
            if not click_text(page, date):
                # 날짜를 못 눌렀으면 다른 날짜 시간표를 이 날짜로 착각하지 않도록 이번 바퀴는 건너뛴다
                log(f"날짜 '{date}' 버튼을 찾지 못했습니다.")
                continue
            settle(page, 0.5, idle_timeout=2)
        for theater in args.theater:
            label = f"{date}일 {theater}" if len(dates) > 1 else theater
            args.targets[label] = (date, theater)
            if not click_text(page, theater):
                log(f"극장 '{theater}' 버튼을 찾지 못했습니다. 화면에 극장 즐겨찾기가 되어 있는지 확인하세요.")
                continue
            settle(page, args.settle, idle_timeout=3)
            text = page_text(page)
            dumps[label] = text
            times = start_times(text)
            result[label] = [t for t in times if args.start <= to_minutes(t) <= args.end]
    return result, dumps


SEAT_STATUS_JS = """(labels) => {
  // 회차 시각 글자를 가진 보이는 요소를 찾고, 그 요소를 감싼 버튼의 글자/상태를 돌려준다
  for (const label of labels) {
    for (const el of document.querySelectorAll("body *")) {
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
      if (own !== label || !el.getClientRects().length) continue;
      let box = el;
      for (let i = 0; i < 4 && box.parentElement; i++) {
        if (["BUTTON", "A", "LI"].includes(box.tagName)) break;
        box = box.parentElement;
      }
      return {
        text: box.innerText || "",
        cls: String(box.className || "") + " " + String(el.className || ""),
        disabled: !!box.disabled || box.getAttribute("aria-disabled") === "true",
      };
    }
  }
  return null;
}"""


def seat_status(page, hhmm):
    """회차 버튼 상태: 'open'(예매 가능), 'soldout'(매진), None(화면에 없음)."""
    labels = [hhmm] + ([hhmm[1:]] if hhmm.startswith("0") else [])
    info = page.evaluate(SEAT_STATUS_JS, labels)
    if info is None:
        return None, ""
    text = info["text"]
    seats = re.search(r"(\d+)\s*석", text)
    sold = (
        "매진" in text
        or info["disabled"]
        or re.search(r"sold|disabl", info["cls"], re.I) is not None
        or (seats is not None and int(seats.group(1)) == 0)
    )
    detail = " ".join(text.split())
    return ("soldout" if sold else "open"), detail


def watch_seats(page, args):
    """매진된 회차가 다시 예매 가능해지면 알린다."""
    dates = args.date or [None]
    names = ", ".join(f"{th} {'/'.join(ts)}" for th, ts in args.seat_targets.items())
    log(f"매진 회차 감시 시작: {names} (Ctrl+C로 종료)")
    last, pending = {}, set()
    while True:
        try:
            for date in dates:
                if date and len(dates) > 1 and not click_text(page, date):
                    log(f"날짜 '{date}' 버튼을 찾지 못했습니다.")
                    continue
                for theater, times in args.seat_targets.items():
                    if not click_text(page, theater):
                        log(f"극장 '{theater}' 버튼을 찾지 못했습니다.")
                        continue
                    settle(page, args.settle, idle_timeout=3)
                    for t in times:
                        key = (date, theater, t)
                        name = f"{date + '일 ' if date and len(dates) > 1 else ''}{theater} {t}"
                        state, detail = seat_status(page, t)
                        if key not in last:
                            shown = {"open": "예매 가능", "soldout": "매진", None: "화면에 없음"}[state]
                            log(f"기준 상태 {name}: {shown} ({detail})")
                        elif state == "open" and last[key] != "open":
                            # 화면 전환 중 잘못 읽는 경우를 막기 위해 두 번 연속 '예매 가능'일 때 알린다
                            if key in pending:
                                pending.discard(key)
                                log(f"매진 풀림! {name} ({detail})")
                                notify("CGV 매진 회차 풀림!", name)
                                opened = open_showtime(page, args, theater if date is None or len(dates) == 1
                                                       else f"{date}일 {theater}", t) if args.open_seat else None
                                beep(5)
                                if opened is not None:
                                    hold_window(opened)
                                    return
                            else:
                                pending.add(key)
                                continue
                        if state != "open":
                            pending.discard(key)
                        last[key] = state
            log("확인 중 (" + ", ".join(
                f"{th} {t} {'가능' if last.get((d, th, t)) == 'open' else '매진' if last.get((d, th, t)) == 'soldout' else '?'}"
                for d in dates for th, ts in args.seat_targets.items() for t in ts) + ")")
        except PlaywrightTimeout:
            log("페이지 로딩 시간 초과, 다음 바퀴에 재시도")
        except Exception as e:
            log(f"오류: {e!r}, 다음 바퀴에 재시도")
        if args.interval > 0:
            time.sleep(args.interval + random.uniform(0, args.interval * 0.2))


NTFY_TOPIC = None  # --ntfy 로 정하면 휴대폰(ntfy 앱)으로도 알림을 보낸다


def push_phone(title, message):
    """ntfy 로 휴대폰 푸시 알림을 보낸다. 스마트워치도 휴대폰 알림을 그대로 받는다."""
    if not NTFY_TOPIC:
        return
    url = NTFY_TOPIC if NTFY_TOPIC.startswith("http") else f"https://ntfy.sh/{NTFY_TOPIC}"
    try:
        req = urllib.request.Request(
            url,
            data=f"{title}\n{message}".encode("utf-8"),
            headers={"Title": "CGV", "Priority": "urgent", "Tags": "rotating_light"},
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log(f"휴대폰 알림 전송 실패: {e!r}")


def notify(title, message):
    push_phone(title, message)
    try:
        from plyer import notification

        notification.notify(title=title, message=message[:250], timeout=30)
        return
    except Exception:
        pass
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["osascript", "-e", f'display notification "{message[:200]}" with title "{title}"'],
                           check=False)
        elif system == "Linux":
            subprocess.run(["notify-send", title, message[:250]], check=False)
    except FileNotFoundError:
        pass


def beep(times):
    system = platform.system()
    for _ in range(times):
        try:
            if system == "Windows":
                import os
                import winsound

                # Beep()은 PC에 따라 소리가 안 나서, Windows 기본 알람 소리 파일을 재생한다
                media = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Media")
                for name in ("Alarm01.wav", "Windows Notify System Generic.wav", "notify.wav"):
                    wav = os.path.join(media, name)
                    if os.path.exists(wav):
                        winsound.PlaySound(wav, winsound.SND_FILENAME)
                        break
                else:
                    winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                    time.sleep(1)
            elif system == "Darwin":
                subprocess.run(["afplay", "/System/Library/Sounds/Glass.aiff"], check=False)
            else:
                print("\a", end="", flush=True)
                time.sleep(0.8)
        except Exception as e:  # 소리가 안 날 때 원인을 볼 수 있게 남긴다
            log(f"알람 소리 재생 실패: {e!r}")
            print("\a", end="", flush=True)
        time.sleep(0.3)


def parse_args():
    p = argparse.ArgumentParser(description="CGV 회차 오픈 알림 (예매는 직접)")
    p.add_argument("--test-alert", action="store_true",
                   help="회차를 찾았을 때 나오는 알림을 CGV 확인 없이 미리 보고 종료")
    p.add_argument("--url", help="영화(와 날짜)를 고른 상태의 CGV 예매 페이지 URL")
    p.add_argument("--theater", action="append",
                   help="확인할 극장 버튼 이름 (화면에 보이는 그대로). 여러 번 지정")
    p.add_argument("--movie", help="화면에 이 글자가 있는지 확인 (선택이 풀렸는지 점검용)")
    p.add_argument("--date", action="append",
                   help="확인할 날짜 버튼 (예: 30). 여러 번 지정하면 날짜마다 번갈아 확인")
    p.add_argument("--refresh-date",
                   help="매 바퀴 먼저 눌렀다가 --date 로 돌아올 날짜 버튼 (시간표 새로고침용, 결과는 보지 않음)")
    p.add_argument("--from", dest="start_s", default="00:00", help="회차 시작 시각 하한 (예: 06:00)")
    p.add_argument("--to", dest="end_s", default="23:59", help="회차 시작 시각 상한 (예: 12:00)")
    p.add_argument("--interval", type=float, default=120, help="한 바퀴 끝난 뒤 쉬는 시간(초). 0이면 바로 다음 바퀴")
    p.add_argument("--settle", type=float, default=1.5, help="극장 버튼을 누른 뒤 화면을 읽기 전 대기(초)")
    p.add_argument("--headed", action="store_true", help="브라우저 창을 띄워서 확인 (권장)")
    p.add_argument("--no-reload", dest="reload", action="store_false",
                   help="새로고침 없이 극장 버튼만 다시 눌러 확인")
    p.add_argument("--setup", action="store_true",
                   help="창이 열리면 직접 영화/날짜/극장을 고른 뒤 Enter. 이후 새로고침 없이 극장 버튼만 눌러 확인")
    p.add_argument("--new-only", action="store_true",
                   help="시작할 때 이미 있던 회차는 무시하고, 새로 생긴 회차만 알림 (계속 감시)")
    p.add_argument("--earlier-only", action="store_true",
                   help="--new-only와 함께: 극장별 기존 첫 회차보다 이른 새 회차만 알림")
    p.add_argument("--open-seat", action="store_true",
                   help="새 회차를 찾으면 감시 중인 창에서 그 회차의 좌석 선택 화면까지 열어 둠 (좌석은 직접 선택)")
    p.add_argument("--test-open", action="store_true",
                   help="지금 있는 가장 빠른 회차로 알림 + 좌석 선택 화면 열기를 시험")
    p.add_argument("--seat", action="append", default=[],
                   help="매진 풀림 감시: '극장=시각,시각' (예: 용산아이파크몰=08:20,11:10). 여러 번 지정")
    p.add_argument("--ntfy", help="휴대폰 ntfy 앱에서 구독한 주제 이름. 알림을 휴대폰/스마트워치로도 보냄")
    p.add_argument("--keep", action="store_true", help="발견 후에도 계속 감시 (새로 생긴 회차만 알림)")
    p.add_argument("--no-open", action="store_true", help="발견 시 기본 브라우저로 페이지를 열지 않음")
    p.add_argument("--dump", action="store_true", help="한 번만 확인하고 극장별 화면 텍스트를 page_dump.txt로 저장")
    args = p.parse_args()
    if args.test_alert:
        return args
    args.seat_targets = {}
    for spec in args.seat:
        theater, _, times = spec.partition("=")
        if not times:
            p.error(f"--seat 형식이 잘못됐습니다: {spec} (예: 용산아이파크몰=08:20,11:10)")
        args.seat_targets.setdefault(theater.strip(), []).extend(
            f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}" for t in times.split(",") if t.strip())
    if args.seat_targets and not args.theater:
        args.theater = list(args.seat_targets)
    if not args.url or not args.theater:
        p.error("--url 과 --theater 가 필요합니다")
    args.start, args.end = to_minutes(args.start_s), to_minutes(args.end_s)
    args.targets = {}  # 결과 이름 -> (날짜, 극장)
    if args.setup:
        args.headed, args.reload = True, False
    args.interval = max(args.interval, MIN_INTERVAL)
    return args


def main():
    global NTFY_TOPIC
    args = parse_args()
    NTFY_TOPIC = args.ntfy
    if args.test_alert:
        # 실제로 회차를 찾았을 때와 똑같이 알린다 (CGV 확인은 하지 않음)
        msg = "여의도 09:30, 10:50 / 홍대 11:20 (테스트)"
        log(f"회차 발견! {msg}")
        notify("CGV 회차 오픈!", msg)
        if not args.no_open:
            webbrowser.open(args.url or "https://cgv.co.kr/cnm/movieBook/movie")
        beep(5)
        return
    if args.test_open:
        args.setup, args.headed, args.reload = True, True, False
    with sync_playwright() as pw:
        if args.headed:
            # 창 크기를 모니터에 맞춘다 (고정 크기면 화면 아래가 잘린다)
            browser = pw.chromium.launch(headless=False, args=["--start-maximized"])
            page = browser.new_page(locale="ko-KR", no_viewport=True)
        else:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(locale="ko-KR", viewport={"width": 900, "height": 1400})
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=45_000)
            settle(page, args.settle)
            if args.setup:
                print("\n열린 크롬 창에서 영화와 날짜를 고르고, 확인할 극장이 버튼으로 보이게 추가하세요.")
                print("(로그인이 필요하면 그 창에서 로그인하세요.) 준비되면 여기서 Enter를 누르세요.")
                input()

            if args.dump:
                result, dumps = check_once(page, args)
                with open("page_dump.txt", "w", encoding="utf-8") as f:
                    for theater, text in dumps.items():
                        f.write(f"===== {theater} =====\n{text}\n\n")
                for label in args.targets:
                    log(f"{label}: {result.get(label, '버튼 못 찾음')}")
                log("page_dump.txt 저장 완료. 극장별로 상영시각이 제대로 보이는지 확인하세요.")
                return

            if args.seat_targets:
                for date in (args.date or [None]):
                    for theater in args.seat_targets:
                        label = f"{date}일 {theater}" if args.date and len(args.date) > 1 else theater
                        args.targets[label] = (date, theater)
                watch_seats(page, args)
                return

            if args.test_open:
                # 새 회차를 기다리지 않고, 지금 있는 가장 빠른 회차로 알림 + 좌석 화면 열기를 시험한다
                result, _ = check_once(page, args)
                found = [(ts[0], th) for th, ts in result.items() if ts]
                if not found:
                    log("회차를 하나도 찾지 못했습니다. 상영 중인 영화와 날짜를 골랐는지 확인하세요.")
                    return
                t, th = min(found)
                log(f"[테스트] 회차 발견! {th} {t}")
                opened = open_showtime(page, args, th, t)
                notify("CGV 회차 오픈! (테스트)", f"{th} {t}")
                beep(1)
                hold_window(opened)
                return

            window = f"{args.start_s}~{args.end_s}"
            log(f"감시 시작: {', '.join(args.theater)} / 시작시각 {window} / {args.interval:g}초 쉬고 반복 (Ctrl+C로 종료)")
            seen = set()
            based = set()  # --new-only: 처음 확인한 회차를 기준으로 기록한 극장
            first = {}  # --earlier-only: 극장별 기준 첫 회차
            pending = set()  # --new-only: 한 번 보인 새 회차 (다음 바퀴에도 보이면 알림)
            while True:
                try:
                    result, _ = check_once(page, args)
                    if args.new_only:
                        for th in [th for th in result if th not in based]:
                            based.add(th)
                            seen.update((th, t) for t in result[th])
                            if result[th]:
                                first[th] = min(result[th])
                            log(f"기준 회차 {th}: {', '.join(result[th]) or '없음'}")
                        current = {(th, t) for th, ts in result.items() for t in ts}
                        # 화면 전환이 덜 된 순간을 새 회차로 착각하지 않도록 두 바퀴 연속 보여야 알린다
                        fresh = current - seen
                        confirmed, pending = fresh & pending, fresh
                        new = {}
                        for th, t in sorted(confirmed):
                            if args.earlier_only and th in first and t >= first[th]:
                                continue  # 기존 첫 회차보다 늦은 회차는 알리지 않는다
                            new.setdefault(th, []).append(t)
                    else:
                        new = {th: [t for t in ts if (th, t) not in seen] for th, ts in result.items()}
                        new = {th: ts for th, ts in new.items() if ts}
                    if new:
                        msg = " / ".join(f"{th} {', '.join(ts)}" for th, ts in new.items())
                        log(f"{'새 회차 오픈!' if args.new_only else '회차 발견!'} {msg}")
                        opened = None
                        if args.open_seat:
                            t, th = min((ts[0], th) for th, ts in new.items())
                            opened = open_showtime(page, args, th, t)
                        notify("CGV 회차 오픈!", msg)
                        if not args.no_open and not args.open_seat:
                            webbrowser.open(args.url)
                        beep(5)
                        if opened is not None:
                            hold_window(opened)
                            return
                        seen.update((th, t) for th, ts in new.items() for t in ts)
                        pending -= seen
                        if not (args.keep or args.new_only):
                            return
                    else:
                        log("아직 없음 (" + ", ".join(f"{th} {len(ts)}" for th, ts in result.items()) + ")")
                except PlaywrightTimeout:
                    log("페이지 로딩 시간 초과, 다음 회차에 재시도")
                except Exception as e:  # 네트워크 오류 등으로 감시가 멈추지 않게
                    log(f"오류: {e!r}, 다음 회차에 재시도")
                if args.interval > 0:
                    time.sleep(args.interval + random.uniform(0, args.interval * 0.2))
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("종료")
        sys.exit(0)

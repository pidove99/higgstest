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
import webbrowser
from datetime import datetime

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

MIN_INTERVAL = 10  # 사이트에 부담을 주지 않도록 최소 확인 간격(초)
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


def click_text(page, label):
    """버튼/칩을 보이는 글자 그대로 찾아 누른다."""
    for locator in (
        page.get_by_role("button", name=label, exact=True),
        page.get_by_role("tab", name=label, exact=True),
        page.get_by_text(label, exact=True),
    ):
        try:
            if locator.count() > 0:
                locator.first.click(timeout=5_000)
                return True
        except Exception:
            continue
    return False


def settle(page, seconds):
    try:
        page.wait_for_load_state("networkidle", timeout=10_000)
    except PlaywrightTimeout:
        pass
    page.wait_for_timeout(seconds * 1000)


def check_once(page, args):
    """새로고침 후 극장별로 눌러보고 {극장: [시작시각...]}(시간대 안쪽만)을 돌려준다."""
    if args.reload:
        page.reload(wait_until="domcontentloaded", timeout=45_000)
        settle(page, args.settle)
    body = page.inner_text("body")
    if args.movie and args.movie not in body:
        log(f"화면에서 '{args.movie}'를 찾지 못했습니다. 새로고침하면 영화 선택이 풀리는지 확인하세요.")
    if args.date and not click_text(page, args.date):
        log(f"날짜 '{args.date}' 버튼을 찾지 못했습니다.")
    settle(page, 1)

    result, dumps = {}, {}
    for theater in args.theater:
        if not click_text(page, theater):
            log(f"극장 '{theater}' 버튼을 찾지 못했습니다. 화면에 극장 즐겨찾기가 되어 있는지 확인하세요.")
            continue
        settle(page, args.settle)
        text = page.inner_text("body")
        dumps[theater] = text
        times = start_times(text)
        result[theater] = [t for t in times if args.start <= to_minutes(t) <= args.end]
    return result, dumps


def notify(title, message):
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
                import winsound

                winsound.Beep(1200, 400)
                winsound.Beep(900, 400)
            elif system == "Darwin":
                subprocess.run(["afplay", "/System/Library/Sounds/Glass.aiff"], check=False)
            else:
                print("\a", end="", flush=True)
                time.sleep(0.8)
        except Exception:
            print("\a", end="", flush=True)
        time.sleep(0.3)


def parse_args():
    p = argparse.ArgumentParser(description="CGV 회차 오픈 알림 (예매는 직접)")
    p.add_argument("--url", required=True, help="영화(와 날짜)를 고른 상태의 CGV 예매 페이지 URL")
    p.add_argument("--theater", action="append", required=True,
                   help="확인할 극장 버튼 이름 (화면에 보이는 그대로). 여러 번 지정")
    p.add_argument("--movie", help="화면에 이 글자가 있는지 확인 (선택이 풀렸는지 점검용)")
    p.add_argument("--date", help="매번 누를 날짜 버튼의 숫자 (예: 30)")
    p.add_argument("--from", dest="start_s", default="00:00", help="회차 시작 시각 하한 (예: 06:00)")
    p.add_argument("--to", dest="end_s", default="23:59", help="회차 시작 시각 상한 (예: 12:00)")
    p.add_argument("--interval", type=int, default=120, help=f"확인 간격(초), 최소 {MIN_INTERVAL}")
    p.add_argument("--settle", type=int, default=2, help="클릭/로딩 후 추가 대기(초)")
    p.add_argument("--headed", action="store_true", help="브라우저 창을 띄워서 확인 (권장)")
    p.add_argument("--no-reload", dest="reload", action="store_false",
                   help="새로고침 없이 극장 버튼만 다시 눌러 확인")
    p.add_argument("--setup", action="store_true",
                   help="창이 열리면 직접 영화/날짜/극장을 고른 뒤 Enter. 이후 새로고침 없이 극장 버튼만 눌러 확인")
    p.add_argument("--keep", action="store_true", help="발견 후에도 계속 감시 (새로 생긴 회차만 알림)")
    p.add_argument("--no-open", action="store_true", help="발견 시 기본 브라우저로 페이지를 열지 않음")
    p.add_argument("--dump", action="store_true", help="한 번만 확인하고 극장별 화면 텍스트를 page_dump.txt로 저장")
    args = p.parse_args()
    args.start, args.end = to_minutes(args.start_s), to_minutes(args.end_s)
    if args.setup:
        args.headed, args.reload = True, False
    if args.interval < MIN_INTERVAL:
        log(f"간격이 너무 짧아 {MIN_INTERVAL}초로 조정합니다.")
        args.interval = MIN_INTERVAL
    return args


def main():
    args = parse_args()
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
                for theater in args.theater:
                    log(f"{theater}: {result.get(theater, '버튼 못 찾음')}")
                log("page_dump.txt 저장 완료. 극장별로 상영시각이 제대로 보이는지 확인하세요.")
                return

            window = f"{args.start_s}~{args.end_s}"
            log(f"감시 시작: {', '.join(args.theater)} / 시작시각 {window} / {args.interval}초 간격 (Ctrl+C로 종료)")
            seen = set()
            while True:
                try:
                    result, _ = check_once(page, args)
                    new = {th: [t for t in ts if (th, t) not in seen] for th, ts in result.items()}
                    new = {th: ts for th, ts in new.items() if ts}
                    if new:
                        msg = " / ".join(f"{th} {', '.join(ts)}" for th, ts in new.items())
                        log(f"회차 발견! {msg}")
                        notify("CGV 회차 오픈!", msg)
                        if not args.no_open:
                            webbrowser.open(args.url)
                        beep(5)
                        seen.update((th, t) for th, ts in new.items() for t in ts)
                        if not args.keep:
                            return
                    else:
                        log("아직 없음 (" + ", ".join(f"{th} {len(ts)}" for th, ts in result.items()) + ")")
                except PlaywrightTimeout:
                    log("페이지 로딩 시간 초과, 다음 회차에 재시도")
                except Exception as e:  # 네트워크 오류 등으로 감시가 멈추지 않게
                    log(f"오류: {e!r}, 다음 회차에 재시도")
                time.sleep(args.interval + random.uniform(0, args.interval * 0.2))
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("종료")
        sys.exit(0)

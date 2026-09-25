"""CGV 회차 오픈 알림 스크립트.

지정한 CGV 상영시간표 페이지를 일정 간격으로 열어보고, 원하는 영화(와 추가 키워드)가
페이지에 나타나면 PC 알림 + 소리로 알려준다. 예매/결제는 하지 않는다.

사용 예:
    python cgv_watch.py --url "<CGV 상영시간표 URL>" --movie "영화제목" --must "IMAX"
    python cgv_watch.py --url "<URL>" --dump        # 페이지에서 읽힌 텍스트 확인용
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

MIN_INTERVAL = 60  # 사이트에 부담을 주지 않도록 최소 확인 간격(초)
TIME_PATTERN = re.compile(r"\b([01]?\d|2[0-3]):[0-5]\d\b")


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def fetch_page_text(browser, url, settle_seconds):
    """페이지를 열고 JS 렌더링이 끝난 뒤의 화면 텍스트를 돌려준다."""
    page = browser.new_page(locale="ko-KR")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        try:
            page.wait_for_load_state("networkidle", timeout=15_000)
        except PlaywrightTimeout:
            pass
        page.wait_for_timeout(settle_seconds * 1000)
        return page.inner_text("body")
    finally:
        page.close()


def find_match(text, movie, must, need_time):
    """조건을 만족하면 영화 제목 주변 텍스트를 돌려주고, 아니면 None."""
    norm = re.sub(r"\s+", " ", text)
    if any(word not in norm for word in must):
        return None
    # 배너 등에 제목만 있는 경우를 걸러내려고, 제목 바로 뒤에 상영시각이 있는 위치를 찾는다
    for m in re.finditer(re.escape(movie), norm):
        after = norm[m.start(): m.start() + 400]
        if not need_time or TIME_PATTERN.search(after):
            return norm[max(0, m.start() - 40): m.start() + 300]
    return None


def notify(title, message):
    system = platform.system()
    try:
        from plyer import notification

        notification.notify(title=title, message=message[:250], timeout=30)
    except Exception:
        try:
            if system == "Darwin":
                subprocess.run(
                    ["osascript", "-e", f'display notification "{message[:200]}" with title "{title}"'],
                    check=False,
                )
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
    p.add_argument("--url", required=True, help="확인할 CGV 상영시간표/예매 페이지 URL")
    p.add_argument("--movie", help="찾을 영화 제목(페이지에 표시되는 그대로의 일부)")
    p.add_argument("--must", action="append", default=[],
                   help="함께 있어야 하는 키워드 (예: IMAX, 4DX, 무대인사). 여러 번 지정 가능")
    p.add_argument("--no-time-check", action="store_true",
                   help="영화 제목 뒤에 상영시각(HH:MM)이 있는지 확인하지 않음")
    p.add_argument("--interval", type=int, default=180, help=f"확인 간격(초), 최소 {MIN_INTERVAL}")
    p.add_argument("--settle", type=int, default=3, help="페이지 로딩 후 추가 대기(초)")
    p.add_argument("--headed", action="store_true", help="브라우저 창을 띄워서 확인 (차단될 때 시도)")
    p.add_argument("--keep", action="store_true", help="발견 후에도 계속 확인")
    p.add_argument("--no-open", action="store_true", help="발견 시 기본 브라우저로 페이지를 열지 않음")
    p.add_argument("--dump", action="store_true", help="한 번만 읽고 페이지 텍스트를 page_dump.txt로 저장")
    args = p.parse_args()
    if not args.dump and not args.movie:
        p.error("--movie 가 필요합니다 (텍스트 확인만 하려면 --dump)")
    if args.interval < MIN_INTERVAL:
        log(f"간격이 너무 짧아 {MIN_INTERVAL}초로 조정합니다.")
        args.interval = MIN_INTERVAL
    return args


def main():
    args = parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        try:
            if args.dump:
                text = fetch_page_text(browser, args.url, args.settle)
                with open("page_dump.txt", "w", encoding="utf-8") as f:
                    f.write(text)
                log(f"page_dump.txt 저장 완료 ({len(text)}자). 영화 제목이 어떻게 보이는지 확인하세요.")
                return

            cond = f"'{args.movie}'" + "".join(f" + '{w}'" for w in args.must)
            log(f"감시 시작: {cond} / {args.interval}초 간격 (Ctrl+C로 종료)")
            while True:
                try:
                    text = fetch_page_text(browser, args.url, args.settle)
                    snippet = find_match(text, args.movie, args.must, not args.no_time_check)
                    if snippet:
                        log("회차 발견!")
                        log(snippet)
                        notify("CGV 회차 오픈!", snippet)
                        if not args.no_open:
                            webbrowser.open(args.url)
                        beep(5)
                        if not args.keep:
                            return
                    else:
                        log("아직 없음")
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

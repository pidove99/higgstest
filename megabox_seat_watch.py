"""
메가박스 빠른예매 잔여석 감시 → 조건 충족 시 알람 + 좌석선택 화면 자동 진입

사용법
  pip install playwright
  python -m playwright install chromium
  python megabox_seat_watch.py
  python megabox_seat_watch.py --test   # 테스트: 1석만 남아도 바로 좌석창 진입
  python megabox_seat_watch.py --test --time 10:30   # 다른 회차로 테스트

1) 브라우저가 뜨면 로그인 → 빠른예매에서 날짜/영화/극장을 평소처럼 선택해 두기
   (스크린샷처럼 시간표에 대상 회차가 보이는 상태)
2) 터미널에서 Enter
3) 스크립트가 주기적으로 날짜를 다시 눌러 시간표를 새로고침하며 잔여석 확인
4) 잔여석 >= MIN_SEATS 이면 알람 + 해당 회차 클릭 + '알림' 팝업 '확인' 클릭
   → 좌석선택 화면에서 직접 좌석 고르고 결제하면 됨
"""

import random
import re
import sys
import time

from playwright.sync_api import sync_playwright

# ===== 설정 =====
TARGET_TIME = "09:40"          # 상영 시작 시간
TARGET_BRANCH = "인천논현"      # 극장명 (시간표 오른쪽에 표시되는 이름)
TARGET_DATE_DAY = "30"         # 날짜 탭의 일(day) 숫자
OTHER_DATE_DAY = "1"           # 새로고침용으로 잠깐 눌렀다 돌아올 다른 날짜
MIN_SEATS = 3                  # 이 이상 남으면 알람
INTERVAL_SEC = (20, 35)        # 새로고침 간격(랜덤) - 너무 짧게 하지 말 것
PROFILE_DIR = "./megabox_profile"  # 로그인 유지용
URL = "https://www.megabox.co.kr/booking"
# ================

SEAT_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def alarm(msg: str):
    print("\n" + "=" * 50 + f"\n🔔 {msg}\n" + "=" * 50, flush=True)
    try:
        import winsound  # Windows
        for _ in range(5):
            winsound.Beep(1500, 300)
            time.sleep(0.1)
    except Exception:
        for _ in range(5):
            sys.stdout.write("\a")
            sys.stdout.flush()
            time.sleep(0.3)


def all_frames(page):
    """현재 살아있는(detach 안 된) 프레임 전부. 메가박스 예매창은 iframe이 새로 로드되므로 매번 다시 구한다."""
    return [f for f in page.frames if not f.is_detached()]


def find_target(page):
    """시간표에서 대상 회차 요소와 잔여석 수를 찾는다. (locator, 잔여석 / 0=매진 / None=숫자 못 읽음)"""
    for frame in all_frames(page):
        try:
            items = frame.locator("li, button, a").filter(has_text=TARGET_TIME).filter(
                has_text=TARGET_BRANCH
            )
            n = items.count()
            # 가장 안쪽(텍스트가 짧은) 요소를 고른다
            best, best_len = None, 10**9
            for i in range(n):
                el = items.nth(i)
                try:
                    txt = el.inner_text(timeout=1000)
                except Exception:
                    continue
                if len(txt) < best_len:
                    best, best_len = (el, txt), len(txt)
        except Exception:
            continue  # 프레임이 중간에 새로 로드됨 → 다음 프레임
        if best:
            el, txt = best
            if "매진" in txt:
                return el, 0
            m = SEAT_RE.search(txt.split(TARGET_BRANCH, 1)[-1]) or SEAT_RE.search(txt)
            return el, int(m.group(1)) if m else None
    return None, None


def click_date(page, day: str):
    """상단 날짜 탭 클릭 ('30·수' 같은 버튼)"""
    pat = re.compile(rf"^\s*{day}\s*[·•\.]?\s*[월화수목금토일]")
    for frame in all_frames(page):
        try:
            btn = frame.locator("button, a").filter(has_text=pat)
            if btn.count():
                btn.first.click(timeout=3000)
                return True
        except Exception:
            continue
    return False


def settle(page, ms):
    page.wait_for_timeout(ms)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass


def refresh(page):
    if click_date(page, OTHER_DATE_DAY):
        settle(page, 1500)
    click_date(page, TARGET_DATE_DAY)
    settle(page, 2500)


def confirm_popups(page, tries=5):
    """'알림' 팝업(프리미어시네마EX 안내 등)의 확인 버튼 누르기"""
    for _ in range(tries):
        clicked = False
        for frame in all_frames(page):
            try:
                btn = frame.locator("button:visible", has_text=re.compile(r"^\s*확인\s*$"))
                if btn.count():
                    btn.first.click(timeout=3000)
                    clicked = True
                    page.wait_for_timeout(800)
            except Exception:
                continue
        if not clicked:
            break


def enter_seat_page(page, retries=3):
    """대상 회차 클릭 → 팝업 확인. 프레임이 바뀌어도 다시 찾아서 재시도."""
    for _ in range(retries):
        el, _ = find_target(page)
        if el is None:
            page.wait_for_timeout(1000)
            continue
        try:
            el.click(timeout=3000)
            page.wait_for_timeout(1000)
            confirm_popups(page)
            return True
        except Exception as e:
            print("클릭 재시도:", e)
            page.wait_for_timeout(1000)
    return False


def parse_args():
    global TARGET_TIME, TARGET_BRANCH, MIN_SEATS
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true",
                    help="테스트 모드: 잔여 1석 이상이면 바로 좌석창 진입")
    ap.add_argument("--time", help="상영 시작 시간 (예: 10:30)")
    ap.add_argument("--branch", help="극장명 (예: 인천논현)")
    ap.add_argument("--min", type=int, help="최소 잔여석 수")
    a = ap.parse_args()
    if a.test:
        MIN_SEATS = 1
    if a.time:
        TARGET_TIME = a.time
    if a.branch:
        TARGET_BRANCH = a.branch
    if a.min is not None:
        MIN_SEATS = a.min
    mode = "[테스트 모드] " if a.test else ""
    print(f"{mode}감시 대상: {TARGET_TIME} {TARGET_BRANCH} / {MIN_SEATS}석 이상")


def main():
    parse_args()
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE_DIR, headless=False, viewport={"width": 1400, "height": 900}
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(URL)
        input("로그인 후 빠른예매에서 날짜/영화/극장 선택을 마치고 Enter ▶ ")

        while True:
            try:
                page = ctx.pages[-1]  # 사용자가 새 탭에서 예매창을 열었을 수도 있음
                refresh(page)
                el, seats = find_target(page)
                now = time.strftime("%H:%M:%S")
                if el is None:
                    print(f"[{now}] {TARGET_TIME} {TARGET_BRANCH} 회차를 못 찾음 (선택 상태 확인)")
                else:
                    print(f"[{now}] {TARGET_TIME} {TARGET_BRANCH} 잔여석: "
                          f"{'매진' if seats == 0 else seats}")
                    if seats is not None and seats >= MIN_SEATS:
                        page.bring_to_front()
                        enter_seat_page(page)
                        alarm(f"잔여 {seats}석! 좌석선택 화면으로 이동했습니다. 빨리 고르세요!")
                        input("완료되면 Enter로 종료 ▶ ")
                        break
            except Exception as e:
                print("오류:", e)
            time.sleep(random.uniform(*INTERVAL_SEC))
        ctx.close()


if __name__ == "__main__":
    main()

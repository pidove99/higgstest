"""
메가박스 빠른예매 잔여석 감시 → 조건 충족 시 알람 + 좌석선택 화면 자동 진입

사용법
  pip install playwright
  python -m playwright install chromium
  python megabox_seat_watch.py
  python megabox_seat_watch.py --test   # 테스트: 1석만 남아도 바로 좌석창 진입
  python megabox_seat_watch.py --target 09:40 인천논현 3 --target 10:00 송도 1
      # 감시 대상 직접 지정 (시간 극장 최소좌석), 여러 개 가능

1) 브라우저가 뜨면 로그인 → 빠른예매에서 날짜/영화/극장을 평소처럼 선택해 두기
   (스크린샷처럼 시간표에 대상 회차가 보이는 상태)
2) 터미널에서 Enter
3) 스크립트가 주기적으로 날짜를 다시 눌러 시간표를 새로고침하며 잔여석 확인
4) 대상 중 하나라도 잔여석이 기준 이상이면 알람 + 해당 회차 클릭 + '알림' 팝업 '확인' 클릭
   → 좌석선택 화면에서 직접 좌석 고르고 결제하면 됨
"""

import random
import re
import sys
import time

from playwright.sync_api import sync_playwright

# ===== 설정 =====
# 감시 대상: (상영시작시간, 극장명 일부, 최소 잔여석) - 여러 개 동시에 감시
# 극장명은 시간표 오른쪽에 보이는 이름의 일부면 됨 (예: "송도" → 송도(트리플스트리트))
TARGETS = [
    ("09:40", "인천논현", 3),
    ("10:00", "송도", 1),   # 지금 매진 → 한 자리라도 풀리면
]
TARGET_DATE_DAY = "30"         # 날짜 탭의 일(day) 숫자
OTHER_DATE_DAYS = ["1", "2", "3"]  # 새로고침용으로 잠깐 눌렀다 돌아올 날짜 후보(앞에서부터 시도)
INTERVAL_SEC = (20, 35)        # 새로고침 간격(랜덤) - 너무 짧게 하지 말 것
PROFILE_DIR = "./megabox_profile"  # 로그인 유지용
URL = "https://www.megabox.co.kr/booking"
# ================

VERSION = "v6 (여러 회차 동시 감시)"
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


def find_target(page, t_time, t_branch):
    """시간표에서 대상 회차 요소와 잔여석 수를 찾는다. (locator, 잔여석 / 0=매진 / None=숫자 못 읽음)"""
    for frame in all_frames(page):
        try:
            items = frame.locator("li, button, a").filter(has_text=t_time).filter(
                has_text=t_branch
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
            m = SEAT_RE.search(txt.split(t_branch, 1)[-1]) or SEAT_RE.search(txt)
            return el, int(m.group(1)) if m else None
    return None, None


def _try_click(el):
    """일반 클릭 → 실패 시 JS 클릭 (위에 '2026.10' 같은 글자가 겹쳐 있어도 버튼 자체를 누르도록)"""
    for how in ("normal", "js"):
        try:
            if how == "normal":
                el.click(timeout=2000)
            else:
                el.evaluate("e => e.click()")
            return True
        except Exception:
            pass
    return False


DATE_SEP = r"\s*[·•∙・ㆍ\.]?\s*[월화수목금토일]"


def click_date(page, day: str):
    """상단 날짜 탭 클릭 ('30·수', '1·목' 같은 버튼)"""
    loose = re.compile(rf"{day}{DATE_SEP}")
    strict = re.compile(rf"(?<!\d){day}{DATE_SEP}")
    for frame in all_frames(page):
        try:
            btns = frame.locator("button, a").filter(has_text=loose)
            n = btns.count()
        except Exception:
            continue
        cands = []
        for i in range(n):
            el = btns.nth(i)
            try:
                txt = el.inner_text(timeout=1000)
                vis = el.is_visible()
            except Exception:
                continue
            # '2026.09' 같은 월 표시는 빼고 날짜 숫자만 비교 (30 vs 3 구분)
            core = re.sub(r"\d{4}\.\d{1,2}", " ", txt)
            if len(txt) > 20 or not strict.search(core):
                continue
            cands.append((not vis, len(txt), i))
        # 화면에 보이는 것, 텍스트 짧은(=날짜 버튼 자체) 것부터
        for _, _, i in sorted(cands):
            if _try_click(btns.nth(i)):
                return True
    return False


def settle(page, ms):
    page.wait_for_timeout(ms)
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass


def refresh(page):
    """다른 날짜(목) 눌렀다가 원래 날짜(수)로 돌아와서 시간표 새로 불러오기"""
    ok1 = False
    for d in OTHER_DATE_DAYS:
        if click_date(page, d):
            ok1 = d
            break
    if ok1:
        settle(page, 1500)
    ok2 = click_date(page, TARGET_DATE_DAY)
    settle(page, 2500)
    if not (ok1 and ok2):
        print(f"  ⚠ 날짜 버튼 클릭 실패 (다른 날짜:{ok1 + '일 O' if ok1 else 'X'}, "
              f"{TARGET_DATE_DAY}일:{'O' if ok2 else 'X'}) → 시간표가 갱신 안 됐을 수 있음")


def confirm_popups(page, tries=5):
    """'알림' 팝업(프리미어시네마EX 안내 등)의 확인 버튼 누르기"""
    for _ in range(tries):
        clicked = False
        for frame in all_frames(page):
            try:
                btn = frame.locator("button:visible", has_text=re.compile(r"^\s*확인\s*$"))
                if btn.count() and _try_click(btn.first):
                    clicked = True
                    page.wait_for_timeout(800)
            except Exception:
                continue
        if not clicked:
            break


def enter_seat_page(page, t_time, t_branch, retries=3):
    """대상 회차 클릭 → 팝업 확인. 프레임이 바뀌어도 다시 찾아서 재시도."""
    for _ in range(retries):
        el, _ = find_target(page, t_time, t_branch)
        if el is None:
            page.wait_for_timeout(1000)
            continue
        try:
            # li를 잡았으면 그 안의 실제 버튼/링크를 누른다
            inner = el.locator("button, a").filter(has_text=t_time)
            if inner.count():
                el = inner.first
            if not _try_click(el):
                raise RuntimeError("회차 클릭 실패")
            page.wait_for_timeout(1000)
            confirm_popups(page)
            return True
        except Exception as e:
            print("클릭 재시도:", e)
            page.wait_for_timeout(1000)
    return False


def parse_args():
    global TARGETS
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true",
                    help="테스트 모드: 모든 대상 최소좌석을 1로 (잔여 1석 이상이면 바로 좌석창 진입)")
    ap.add_argument("--target", nargs=3, action="append", metavar=("시간", "극장", "최소좌석"),
                    help="감시 대상 (예: --target 10:00 송도 1). 여러 번 쓸 수 있음")
    a = ap.parse_args()
    if a.target:
        TARGETS = [(t, b, int(n)) for t, b, n in a.target]
    if a.test:
        TARGETS = [(t, b, 1) for t, b, _ in TARGETS]
    print(("[테스트 모드] " if a.test else "") + "감시 대상:")
    for t, b, n in TARGETS:
        print(f"  - {t} {b} : {n}석 이상이면 알림")


def main():
    print("메가박스 좌석 감시", VERSION)
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
                now = time.strftime("%H:%M:%S")
                hit = None
                status = []
                for t_time, t_branch, t_min in TARGETS:
                    el, seats = find_target(page, t_time, t_branch)
                    if el is None:
                        status.append(f"{t_time} {t_branch}: 못 찾음")
                        continue
                    status.append(f"{t_time} {t_branch}: {'매진' if seats == 0 else seats}")
                    if hit is None and seats is not None and seats >= t_min:
                        hit = (t_time, t_branch, seats)
                print(f"[{now}] " + " | ".join(status))
                if hit:
                    t_time, t_branch, seats = hit
                    page.bring_to_front()
                    enter_seat_page(page, t_time, t_branch)
                    alarm(f"{t_time} {t_branch} 잔여 {seats}석! 좌석선택 화면으로 이동했습니다. 빨리 고르세요!")
                    input("완료되면 Enter로 종료 ▶ ")
                    break
            except Exception as e:
                print("오류:", e)
            time.sleep(random.uniform(*INTERVAL_SEC))
        ctx.close()


if __name__ == "__main__":
    main()

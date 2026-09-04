# Pidove — clawd-on-desk 테마

픽셀 비둘기가 데스크톱에 앉아서 **Claude Code 가 지금 뭘 하고 있는지** 보여준다.
[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 의 커스텀 테마라
플로팅 창·훅 연동·멀티모니터는 그쪽이 다 해준다. 여기서 만드는 건 **캐릭터**뿐이다.

캐릭터 시트 **한 장**만 있으면 14개 상태 애니메이션과 `theme.json` 이 나온다.

## 쓰는 법

```bash
# 1. 캐릭터 시트를 source/ 에 넣는다
cp ~/pidove-sheet.png themes/pidove/source/

# 2. 빌드
./themes/pidove/build.sh source/pidove-sheet.png

# 3. clawd-on-desk 에서 Settings → Theme → 폴더 선택 → build/
```

Windows 라면 `build.sh` 대신:

```bat
python slice.py source\pidove-sheet.png -o sprites --debug
python animate.py sprites -o build
```

## 시트 요구사항

- 배경은 **한 가지 단색** (시트 네 귀퉁이 색을 배경으로 자동 인식)
- 그림들이 서로 떨어져 있을 것 — 패널 테두리에 닿아도 된다 (알아서 끊어낸다)
- 읽는 순서(위→아래, 왼→오른쪽)대로 이름이 붙는다:

  `front` · `three_quarter` · `side` · `back` · `expr_neutral` · `expr_happy` · `expr_excited`

  개수가 다르면 `--names` 로 직접 지정. 일부만 있어도 동작한다 (없는 뷰는 대체된다).

## 만들어지는 상태

| 상태 | 언제 | 연출 |
|---|---|---|
| `idle` | 놀고 있을 때 | 숨쉬기 |
| `thinking` | 프롬프트 제출 | 고개 갸웃 + 점 세 개 |
| `working` | 툴 실행 중 | 옆모습으로 빠르게 상하 + 속도선 |
| `juggling` | 서브에이전트 2개 | 좌우로 부산하게 |
| `building` | 서브에이전트 3개+ | 등 돌리고 몰두 |
| `yawning` → `dozing` → `collapsing` → `sleeping` | 자리 비움 | 하품 → 꾸벅 → 주저앉기 → zZ |
| `waking` | 돌아옴 | 기지개 |
| `attention` / `happy` | 작업 완료 | 신나서 통통 |
| `notification` | 권한 요청 | 느낌표 깜빡 |
| `error` | 실패 | 부르르 + 붉은 기 |

`workingTiers` 로 세션 수에 따라 `working` → `juggling` → `building` 이 자동 전환된다.

## 파이프라인

```
시트.png ──slice.py──> sprites/*.png ──animate.py──> build/{theme.json, assets/*.png}
```

**slice.py** — 배경색 추정 → 배경 아닌 픽셀 마스크 → 형태학적 열기로 패널 테두리·라벨
같은 가는 선을 끊음 → 연결요소 라벨링 → 크기·채움비율로 그림만 선별 → 원본 마스크
안에서 실루엣 복원 → 디더링 그림자 제거 → 투명 PNG.

**animate.py** — 정지 그림을 이동·스쿼시·회전·색조로 움직이고 글리프(점·느낌표·zZ·속도선)를
얹어 상태별 APNG 를 만든다. 모든 상태가 같은 캔버스·같은 바닥선을 쓰므로 상태가 바뀌어도
캐릭터가 튀지 않는다.

### 유용한 옵션

```bash
python3 slice.py 시트.png -o sprites \
  --debug            # 검출 결과 미리보기 (_debug.png: 초록=채택, 빨강=버림)
  --open 7           # 이보다 가는 선은 무시 (패널 테두리 두께보다 크게)
  --keep-shadow      # 디더링 그림자를 지우지 않음
  --tol 16           # 배경으로 볼 색 허용 오차

python3 animate.py sprites -o build \
  --body 104         # 캐릭터 키(px). viewBox 는 여기서 자동 계산
  --module auto      # 업스케일된 픽셀아트의 격자 배율 (auto|off|정수)
  --expr-ratio 0.92  # 표정 컷을 전신 대비 몇 배로 (발이 없어 기본 0.92)
```

## 검증

clawd-on-desk 의 공식 검증기를 그대로 쓸 수 있다:

```bash
git clone --depth 1 https://github.com/rullerzhou-afk/clawd-on-desk
node clawd-on-desk/scripts/validate-theme.js themes/pidove/build
```

현재 파이프라인 출력은 `All checks passed!` 를 받는다.

## 알아둘 것

- **`source/_test-sheet.png` 는 합성 시트다.** 진짜 캐릭터가 아니라 파이프라인을
  검증하려고 `make_test_sheet.py` 로 그린 것. 진짜 시트가 들어오면 지워도 된다.
- APNG 저장은 `disposal=1, blend=0` 이어야 한다. `disposal=2` 를 쓰면 Pillow 의
  프레임 최적화와 맞물려 앞 프레임과 같은 부분이 통째로 지워진 채 복원된다.
- 스프라이트가 이미지 테두리에 닿으면 축소할 때 그 하드 엣지가 사각 테두리로
  번진다. `ensure_margin()` 이 투명 여백을 보장한다.

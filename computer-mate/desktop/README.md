# Computer Mate — 데스크톱 앱 (.exe) 빌드

`index.html`(웹 버전)을 **Electron**으로 감싼 진짜 바탕화면 마스코트입니다.
배경 투명 · 테두리 없음 · 항상 위에 표시 · 트레이 상주.

## 개발 실행

```bash
cd computer-mate/desktop
npm install
npm start
```

## 배포 빌드 (설치 파일 만들기)

> Windows `.exe`는 **Windows에서 빌드**하는 것이 가장 확실합니다.
> (macOS/Linux에서 Windows 타겟을 크로스 빌드하려면 Wine 등이 필요)

```bash
npm run dist        # 현재 OS용 설치 파일
npm run dist:win    # Windows: NSIS 설치본(.exe) + 포터블(.exe)
npm run dist:mac    # macOS: .dmg
npm run dist:linux  # Linux: .AppImage
```

결과물은 `computer-mate/desktop/release/` 에 생성됩니다.
- `ComputerMate Setup 1.0.0.exe` — 설치형
- `ComputerMate 1.0.0.exe` — 무설치 포터블

## 조작

| 동작 | 방법 |
|------|------|
| 말 걸기 | 비둘기 **클릭** |
| 이동 | 비둘기 **드래그** (창 전체가 따라 이동) |
| 대화 / 집중 타이머 / 상태 | **트레이 아이콘** 우클릭 메뉴 |
| 종료 | 트레이 메뉴 → 종료 |

## 아이콘 (선택)

`build/` 폴더에 아이콘을 넣으면 앱/트레이에 반영됩니다.
- `build/icon.ico` (Windows, 256×256 권장)
- `build/icon.icns` (macOS)
- `build/icon.png` (Linux, 512×512)
- `build/tray.png` (트레이용, 16–32px)

없어도 빌드는 되며 기본 아이콘이 사용됩니다.

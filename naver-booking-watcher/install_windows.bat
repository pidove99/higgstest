@echo off
chcp 65001 >nul
cd /d %~dp0
echo [1/3] 파이썬 찾는 중...
set PY=
py --version >nul 2>nul && set PY=py
if not defined PY python --version >nul 2>nul && set PY=python
if not defined PY (
  echo.
  echo 파이썬이 설치되어 있지 않습니다.
  echo 열리는 페이지에서 Python 을 받아 설치하세요.
  echo 설치 첫 화면에서 "Add python.exe to PATH" 를 꼭 체크하세요.
  echo 설치가 끝나면 이 파일을 다시 실행하세요.
  start https://www.python.org/downloads/
  pause
  exit /b 1
)
%PY% --version
echo [2/3] playwright 설치 중...
%PY% -m pip install --upgrade pip
%PY% -m pip install playwright
if errorlevel 1 (
  echo.
  echo 설치 실패. 위의 빨간 오류 메시지를 캡처해서 보내주세요.
  pause
  exit /b 1
)
echo [3/3] 브라우저 준비 중... (크롬이 있으면 건너뛰어도 됩니다)
%PY% -m playwright install chromium
echo.
echo 설치 완료! 이제 run_windows.bat 을 더블클릭하세요.
pause

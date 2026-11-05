@echo off
chcp 65001 >nul
cd /d %~dp0
set PY=python
py --version >nul 2>nul && set PY=py
REM 아래 옵션은 자유롭게 바꾸세요. (README.md 참고)
%PY% watcher.py --days 목금토일 --interval 15 %*
pause

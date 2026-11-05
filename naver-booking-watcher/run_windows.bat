@echo off
chcp 65001 >nul
cd /d %~dp0
REM 아래 옵션은 자유롭게 바꾸세요. (README.md 참고)
python watcher.py --days 목금토일 --interval 15 %*
pause

@echo off
chcp 65001 >nul
title 山体CT · 本地预览
cd /d "%~dp0app"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Python。
  echo 请先安装 Python 3（安装时勾选 Add to PATH），或使用任意静态服务器打开 app 目录。
  echo.
  pause
  exit /b 1
)

start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8765/"
echo.
echo 服务已启动： http://127.0.0.1:8765/
echo 浏览器会自动打开；若未打开，请手动访问上面的地址。
echo 关闭本窗口即停止服务。
echo.
python -m http.server 8765 --bind 127.0.0.1
pause

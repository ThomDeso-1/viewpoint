@echo off
cd /d "%~dp0"

docker --version >nul 2>&1
if errorlevel 1 (
  echo Docker isn't installed yet.
  echo Install Docker Desktop first: https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

if not exist .env (
  type nul > .env
)
if not exist data (
  mkdir data
)

echo Starting Viewpoint Receipts...
docker compose up -d --build

echo.
echo Started! Open this address in a browser on this computer:
echo   http://localhost:3000
echo.
echo To use it from your iPhone, connect to the same Wi-Fi network and use
echo this computer's network address instead of "localhost" — see GETTING-STARTED.md.
pause

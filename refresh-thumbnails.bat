@echo off
setlocal
cd /d "%~dp0"

echo Refreshing gallery thumbnails and index...
echo A full refresh may take several minutes. Progress will be shown below.
node tools\generate-gallery-thumbnails.mjs --clean

if errorlevel 1 (
  echo.
  echo Refresh failed. Existing thumbnails were kept if cleanup had not started.
  pause
  exit /b 1
)

echo.
echo Thumbnail refresh completed successfully.
pause

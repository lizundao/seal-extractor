@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\seal-extractor.exe" (
  start "" "src-tauri\target\release\seal-extractor.exe"
) else (
  echo Desktop build not found.
  echo Run: npm install ^&^& npx tauri build --no-bundle
  pause
)

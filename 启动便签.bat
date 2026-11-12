@echo off
rem Keep this file pure ASCII: cmd parses .bat in the OEM codepage (936 here),
rem and switching codepages mid-file misaligns the parser.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed yet.
  echo Run: npm ci
  echo Then: node node_modules\electron\install.js
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .

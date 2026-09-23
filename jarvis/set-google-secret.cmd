@echo off
rem Double-click this file to store your Google OAuth client secret on Cloudflare.
rem It reads the client_secret_*.json file you downloaded from Google Cloud.
cd /d "%~dp0api"
rem Use the wrangler login for the ovoa.ai account, which api/wrangler.jsonc pins.
set "XDG_CONFIG_HOME=%USERPROFILE%\.wrangler-ovoa"
echo.
echo Looking for your Google client_secret JSON file in Downloads...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$f = Get-ChildItem \"$env:USERPROFILE\Downloads\client_secret_*.json\" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1;" ^
  "if (-not $f) { Write-Host 'Could not find client_secret_*.json in Downloads.' -ForegroundColor Red; exit 1 }" ^
  "Write-Host ('Found ' + $f.Name);" ^
  "$secret = (Get-Content $f.FullName -Raw | ConvertFrom-Json).web.client_secret;" ^
  "if (-not $secret) { Write-Host 'That file has no client_secret.' -ForegroundColor Red; exit 1 }" ^
  "Write-Host 'Saving it to Cloudflare (this takes a few seconds)...';" ^
  "$secret | npx wrangler secret put GOOGLE_CLIENT_SECRET;" ^
  "if ($LASTEXITCODE -eq 0) { Write-Host ''; Write-Host 'Done! You can now delete that JSON file from Downloads.' -ForegroundColor Green } else { Write-Host 'Saving failed. Send a screenshot of this window.' -ForegroundColor Red }"
echo.
pause

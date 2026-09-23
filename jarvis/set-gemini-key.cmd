@echo off
rem Double-click this file to store your Gemini API key on Cloudflare.
cd /d "%~dp0api"
rem Use the wrangler login for the ovoa.ai account, which api/wrangler.jsonc pins.
set "XDG_CONFIG_HOME=%USERPROFILE%\.wrangler-ovoa"
echo.
echo When you see "Enter a secret value", paste your Gemini key and press Enter.
echo (The key stays invisible while you paste. That is normal.)
echo.
call npx wrangler secret put GEMINI_API_KEY
echo.
pause

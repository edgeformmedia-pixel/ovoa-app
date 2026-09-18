@echo off
rem Double-click this file to store your Gemini API key on Cloudflare.
cd /d "%~dp0api"
echo.
echo When you see "Enter a secret value", paste your Gemini key and press Enter.
echo (The key stays invisible while you paste. That is normal.)
echo.
call npx wrangler secret put GEMINI_API_KEY
echo.
pause

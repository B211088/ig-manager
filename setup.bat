@echo off
echo ========================================
echo  IG 2FA Manager - Setup
echo ========================================
echo.

echo [1/3] Installing Node.js dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Playwright Chromium...
call npx playwright install chromium
if errorlevel 1 (
    echo WARNING: Playwright install may have issues
    echo You can set Chrome path manually in Global Config
)

echo.
echo [3/3] Creating data directories...
if not exist "data\thread1" mkdir "data\thread1"
if not exist "data\thread1\screenshots" mkdir "data\thread1\screenshots"

echo.
echo ========================================
echo  Setup complete!
echo  Run: node manager.js
echo ========================================
pause

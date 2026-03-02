@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title IG 2FA Manager - Setup

echo ========================================
echo  IG 2FA Manager - Setup
echo ========================================
echo.

:: ── KIỂM TRA VÀ CÀI NODE.JS ─────────────────────────────────────────────────
echo [1/4] Kiem tra Node.js...

where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
    echo [OK] Da co Node.js !NODE_VER!
    goto :npm_install
)

echo [!] Chua co Node.js. Dang thu cai tu dong...
echo.

:: Thu winget truoc (Windows 10/11)
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Dung winget de cai Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if !errorlevel! equ 0 (
        echo [OK] Cai Node.js thanh cong qua winget!
        :: Reload PATH de nhan dien node vua cai
        call refreshenv >nul 2>&1
        :: Thu reload thu cong
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
        goto :check_node_again
    )
    echo [WARN] winget that bai, thu cach khac...
)

:: Fallback: tai installer bang PowerShell
echo [INFO] Dang tai Node.js LTS installer bang PowerShell...
echo       (Can ket noi internet)
echo.

set NODE_INSTALLER=%TEMP%\node_installer.msi
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $url = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt' -UseBasicParsing).Content; $lines = $url -split \"`n\"; $msi = ($lines | Where-Object { $_ -match 'node-v.*-x64.msi' }) -replace '.*  ',''; $ver = ($msi -split '-')[1]; $dlUrl = \"https://nodejs.org/dist/latest-v20.x/$msi\"; Write-Host \"Downloading $msi...\"; Invoke-WebRequest $dlUrl -OutFile '%NODE_INSTALLER%' -UseBasicParsing; Write-Host 'Download OK' } catch { Write-Host \"ERROR: $($_.Exception.Message)\"; exit 1 }"

if %errorlevel% neq 0 (
    echo.
    echo [LOI] Khong the tai Node.js tu dong.
    echo.
    echo Vui long cai thu cong tai: https://nodejs.org/en/download
    echo Chon: Windows Installer ^(.msi^) - LTS version
    echo Sau khi cai xong, chay lai file setup.bat nay.
    echo.
    pause
    exit /b 1
)

echo [INFO] Dang cai Node.js (co the mat 1-2 phut)...
msiexec /i "%NODE_INSTALLER%" /quiet /norestart
if %errorlevel% neq 0 (
    echo [LOI] Cai dat Node.js that bai!
    echo Thu chay: %NODE_INSTALLER%
    echo Hoac cai thu cong tai: https://nodejs.org
    pause
    exit /b 1
)

del "%NODE_INSTALLER%" >nul 2>&1
echo [OK] Cai Node.js thanh cong!

:: Reload PATH
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

:check_node_again
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [!] Node.js da duoc cai nhung chua nhan dien duoc trong session nay.
    echo     Day la binh thuong sau khi cai moi.
    echo.
    echo     Vui long DONG cua so nay va CHAY LAI setup.bat
    echo.
    pause
    exit /b 0
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js !NODE_VER! san sang!

:: ── NPM INSTALL ──────────────────────────────────────────────────────────────
:npm_install
echo.
echo [2/4] Cai dat thu vien Node (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo [LOI] npm install that bai!
    echo Thu xoa thu muc node_modules va chay lai.
    pause
    exit /b 1
)
echo [OK] npm install thanh cong!

:: ── PLAYWRIGHT ───────────────────────────────────────────────────────────────
echo.
echo [3/4] Cai Playwright Chromium...
echo       (Co the mat 3-5 phut, vui long cho...)
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo [WARN] Playwright cai that bai hoac bi bo qua.
    echo        Ban co the set duong dan Chrome thu cong trong Global Config ^(phim G^).
) else (
    echo [OK] Playwright Chromium san sang!
)

:: ── TAO THU MUC DATA ─────────────────────────────────────────────────────────
echo.
echo [4/4] Tao cau truc thu muc data...
if not exist "data" mkdir "data"
if not exist "data\thread1" mkdir "data\thread1"
if not exist "data\thread1\screenshots" mkdir "data\thread1\screenshots"

:: Tao file input.txt, success.txt, failed.txt, hotmail.txt neu chua co
for %%f in (input.txt success.txt failed.txt hotmail.txt) do (
    if not exist "data\thread1\%%f" type nul > "data\thread1\%%f"
)
echo [OK] Thu muc data\thread1\ da tao!

:: ── XONG ─────────────────────────────────────────────────────────────────────
echo.
echo ========================================
echo  Setup hoan tat!
echo.
echo  Them tai khoan vao: data\thread1\input.txt
echo  Dinh dang: username:password:email:emailpass:secret2fa
echo.
echo  Chay chuong trinh: node manager.js
echo  Hoac double-click: start.vbs
echo ========================================
echo.
pause
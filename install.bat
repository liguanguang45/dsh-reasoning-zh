@echo off
rem NOTE: keep this file ASCII-only. cmd parses the .bat bytes with the current
rem code page, so UTF-8 Chinese text here breaks the line structure ("chcp 65001"
rem only affects output, not parsing). All Chinese messages come from install.mjs.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================
echo   dsh-reasoning-zh  --  install to your DSH
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] "node" not found.
  echo.
  echo     Option 1: install Node.js LTS from https://nodejs.org
  echo     Option 2: use the node bundled with DSH, usually under
  echo               %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\
  echo.
  goto :done
)

rem Pass through arguments, e.g. install.bat --home D:\my-dsh --profile desktop
node install.mjs %*
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" (
  echo [ok] Installed.
  echo      Next: FULLY QUIT and restart DSH ^(quit the process, not just the window^),
  echo      then type /reasoning-zh in the chat to verify.
) else (
  echo [x] Install failed with exit code %CODE%.
  echo     Please send the output above to whoever shared this with you.
)

:done
echo.
pause
endlocal

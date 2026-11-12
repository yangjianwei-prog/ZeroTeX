@echo off
rem YangTex fallback launcher for Windows (a console flashes briefly, then closes).
rem Prefer "YangTex.vbs" for a completely windowless start.
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe" (
  start "" /B "%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe" "%~dp0YangTex.py" --restart
  exit /b 0
)
start "" /B pythonw.exe "%~dp0YangTex.py" --restart
if errorlevel 1 start "" /B python.exe "%~dp0YangTex.py" --restart
exit /b 0

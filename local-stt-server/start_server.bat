@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  YouTube Live Local STT Server
echo ============================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python was not found in PATH.
  echo Install Python 3.10+ and retry.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :error
)

call ".venv\Scripts\activate.bat"

if not exist ".venv\.ytlt_dependencies_installed" (
  echo [2/3] Installing STT dependencies...
  python -m pip install --upgrade pip
  if errorlevel 1 goto :error
  python -m pip install -r requirements.txt
  if errorlevel 1 goto :error
  echo installed> ".venv\.ytlt_dependencies_installed"
) else (
  echo [2/3] Dependencies already installed.
)

python -c "from importlib.metadata import version; version('nvidia-cublas-cu12'); version('nvidia-cudnn-cu12')" >nul 2>&1
if errorlevel 1 (
  echo [INFO] GPU runtime not installed. Run setup_gpu.bat to enable NVIDIA GPU inference.
) else (
  echo [INFO] Optional NVIDIA GPU runtime detected in .venv.
)

echo [3/3] Starting server...
echo.
python server.py
goto :eof

:error
echo.
echo [ERROR] Setup failed.
pause
exit /b 1

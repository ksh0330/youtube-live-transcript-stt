@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo  YouTube Live Local STT - Optional GPU Runtime Setup
echo ============================================================
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] The local virtual environment does not exist.
  echo Run start_server.bat once, then run setup_gpu.bat again.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"

echo [1/3] Installing NVIDIA CUDA runtime wheels into .venv only...
python -m pip install --no-cache-dir -r requirements-gpu.txt
if errorlevel 1 goto :error

echo.
echo [2/3] Locating and loading CUDA runtime DLLs...
echo [3/3] Running real GPU inference preflight...
python gpu_preflight.py
if errorlevel 1 goto :error

echo.
echo [OK] GPU setup completed.
pause
exit /b 0

:error
echo.
echo [ERROR] GPU setup or preflight failed.
echo CPU fallback remains available when sufficient system memory is free.
pause
exit /b 1

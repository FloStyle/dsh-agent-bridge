@echo off
rem dsh-bridge launcher for Windows. Runtime order: DSH_NODE, the Node that
rem DeepSeek Harness ships (its executable with ELECTRON_RUN_AS_NODE=1), then
rem node on PATH.
setlocal DisableDelayedExpansion
if defined DSH_NODE (
  set "DSH_BRIDGE_RUNTIME=env"
  "%DSH_NODE%" "%~dp0dsh-bridge.mjs" %*
  exit /b %errorlevel%
)
set "DSH_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if exist "%DSH_EXE%" (
  set "DSH_BRIDGE_RUNTIME=dsh-electron"
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_EXE%" "%~dp0dsh-bridge.mjs" %*
  exit /b %errorlevel%
)
set "DSH_BRIDGE_RUNTIME=path"
node "%~dp0dsh-bridge.mjs" %*
exit /b %errorlevel%

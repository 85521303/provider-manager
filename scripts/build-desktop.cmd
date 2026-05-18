@echo off
setlocal

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "DIST=%ROOT%\dist"
set "SIDECAR_OUT=%DIST%\sidecar"
set "CARGO_TARGET_DIR=%DIST%\tauri-target"
set "CPM_EXE_OUT_DIR=%SIDECAR_OUT%"

set "RUSTUP_HOME=D:\CodeTools\rust\rustup"
set "CARGO_HOME=D:\CodeTools\rust\cargo"
set "PATH=D:\CodeTools\rust\cargo\bin;%PATH%"
set "PATH=D:\CodeTools\nsis-3.11\Bin;%PATH%"
set "VSCMD_SKIP_SENDTELEMETRY=1"

if exist "E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" (
  call "E:\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
) else if exist "E:\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" (
  call "E:\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
) else (
  echo Visual Studio build tools were not found.
  exit /b 1
)

if errorlevel 1 exit /b 1

if not exist "%DIST%" mkdir "%DIST%"
attrib -h -s -r "%DIST%\*.exe" >nul 2>nul
attrib -h -s -r "%DIST%\*.msi" >nul 2>nul
del /f /q /a "%DIST%\*.exe" >nul 2>nul
del /f /q /a "%DIST%\*.msi" >nul 2>nul

call npm run cargo:mirror
if errorlevel 1 exit /b 1

call npm run tauri:icons
if errorlevel 1 exit /b 1

call npm run tauri:prepare
if errorlevel 1 exit /b 1

call npx tauri build --bundles nsis
if errorlevel 1 exit /b 1

if exist "%CARGO_TARGET_DIR%\release\bundle\nsis\*.exe" (
  copy /Y "%CARGO_TARGET_DIR%\release\bundle\nsis\*.exe" "%DIST%\" >nul
  if errorlevel 1 exit /b 1
)
if exist "%CARGO_TARGET_DIR%\release\bundle\nsis\*.msi" (
  copy /Y "%CARGO_TARGET_DIR%\release\bundle\nsis\*.msi" "%DIST%\" >nul
  if errorlevel 1 exit /b 1
)
if exist "%CARGO_TARGET_DIR%\release\provider-manager.exe" (
  copy /Y "%CARGO_TARGET_DIR%\release\provider-manager.exe" "%DIST%\provider-manager.exe" >nul
  if errorlevel 1 exit /b 1
  attrib +h +s "%DIST%\provider-manager.exe" >nul 2>nul
)
if exist "%CARGO_TARGET_DIR%\release\provider-manager-desktop.exe" (
  copy /Y "%CARGO_TARGET_DIR%\release\provider-manager-desktop.exe" "%DIST%\ProviderManager.exe" >nul
  if errorlevel 1 exit /b 1
)

echo Desktop build artifacts collected in "%DIST%"

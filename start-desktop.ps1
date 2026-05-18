$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

function Test-FreePort {
  param([int]$Port)
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Find-Edge {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command "msedge.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

$port = if ($env:PORT) { [int]$env:PORT } else { 3767 }
while (-not (Test-FreePort -Port $port)) {
  $port += 1
}

$env:PORT = [string]$port
$stdout = Join-Path $PSScriptRoot "server.out.log"
$stderr = Join-Path $PSScriptRoot "server.err.log"
$server = Start-Process -FilePath "node" `
  -ArgumentList @("server.js") `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

try {
  $url = "http://127.0.0.1:$port"
  $ready = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    if ($server.HasExited) {
      throw "Server exited early. See $stderr"
    }

    try {
      Invoke-WebRequest -Uri "$url/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  if (-not $ready) {
    throw "Server did not become ready at $url"
  }

  $edge = Find-Edge
  if ($edge) {
    $profileDir = Join-Path $env:TEMP "provider-manager-edge-profile"
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    $edgeProcess = Start-Process -FilePath $edge `
      -ArgumentList @("--app=$url", "--window-size=1280,860", "--user-data-dir=$profileDir") `
      -PassThru
    Wait-Process -Id $edgeProcess.Id
  } else {
    Start-Process $url
    Write-Host "Microsoft Edge was not found. Opened the default browser instead: $url"
    Write-Host "Close this window to stop the local manager service."
    Read-Host | Out-Null
  }
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}

[CmdletBinding()]
param()

# Synthetic test: no Next server launched, no processes terminated.
$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "prebuild-next-guard.ps1"
$global:fakeOccupied = $false

function global:Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State)
  if ($global:fakeOccupied) {
    [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 3001; OwningProcess = 987653 }
  }
}
function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  [pscustomobject]@{
    Name = "node.exe"
    ExecutablePath = "C:\tools\node.exe"
    CommandLine = "next dev -p 3001"
  }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("amon-prebuild-guard-test-" + [Guid]::NewGuid().ToString("N") + ".json")
try {
  $clear = (& $target -ProjectRoot (Get-Location).Path | ConvertFrom-Json)
  if ($clear.status -ne "clear") { throw "Expected clear with no listeners." }

  $global:fakeOccupied = $true
  $caught = $false
  try {
    & $target -ProjectRoot (Get-Location).Path -OutputPath $temp | Out-Null
  } catch {
    $caught = $_.Exception.Message -like "*Prebuild Next.js guard: blocked*"
    if (-not $caught) { throw }
  }
  if (-not $caught) { throw "Expected blocked build to fail closed." }
  if (-not (Test-Path -LiteralPath $temp)) { throw "Expected JSON report when blocked." }
  $blocked = Get-Content -LiteralPath $temp -Raw | ConvertFrom-Json
  if ($blocked.status -ne "blocked") { throw "Expected blocked state." }
  if (@($blocked.listeners).Count -ne 1) { throw "Expected listener details in blocked report." }
  Write-Output "PASS: guard refuses an occupied Next port and does not clean it."
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  Remove-Item Function:\Get-NetTCPConnection -ErrorAction SilentlyContinue
  Remove-Item Function:\Get-CimInstance -ErrorAction SilentlyContinue
}

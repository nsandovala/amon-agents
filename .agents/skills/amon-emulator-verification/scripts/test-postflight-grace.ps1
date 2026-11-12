[CmdletBinding()]
param()

# Synthetic safety tests only. No Firebase emulator or process cleanup.
$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "postflight-emulators.ps1"
$global:mockRoot = (Get-Location).Path
$global:mockMode = "pending"
$global:mockCalls = 0

function global:Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State)
  $global:mockCalls++
  if ($global:mockMode -eq "pending" -and $global:mockCalls -ge 2) { return }
  [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 8080; OwningProcess = 987654 }
}
function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  [pscustomobject]@{
    Name = "java.exe"
    ExecutablePath = "C:\tools\java.exe"
    CommandLine = "cloud-firestore-emulator.jar --project_id demo-amon-ci --rules $global:mockRoot\firestore.rules"
  }
}
try {
  $clean = (& $target -ProjectRoot $global:mockRoot -GraceSeconds 2 -PollSeconds 1 | ConvertFrom-Json)
  if ($clean.status -ne "clean") { throw "Expected clean after delayed shutdown." }
  if ($clean.observations.Count -lt 2 -or $clean.observations[0].status -ne "shutdown_pending") {
    throw "Expected shutdown_pending before clean."
  }
  $global:mockMode = "persist"
  $global:mockCalls = 0
  $residual = (& $target -ProjectRoot $global:mockRoot -GraceSeconds 0 | ConvertFrom-Json)
  if ($residual.status -ne "residual") { throw "Expected residual after grace elapsed." }

  function global:Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    [pscustomobject]@{
      Name = "java.exe"
      ExecutablePath = "C:\tools\java.exe"
      CommandLine = "cloud-firestore-emulator.jar --project_id unrelated-project"
    }
  }
  $ambiguous = (& $target -ProjectRoot $global:mockRoot -GraceSeconds 0 | ConvertFrom-Json)
  if ($ambiguous.status -ne "ambiguous") { throw "Expected ambiguous foreign owner." }
  Write-Output "PASS: delayed shutdown, residual and ambiguous owner; no cleanup."
} finally {
  Remove-Item Function:\Get-NetTCPConnection -ErrorAction SilentlyContinue
  Remove-Item Function:\Get-CimInstance -ErrorAction SilentlyContinue
}

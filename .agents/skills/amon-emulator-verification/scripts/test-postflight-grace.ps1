[CmdletBinding()]
param()

# Synthetic safety tests only. No Firebase emulator or process cleanup.
$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "postflight-emulators.ps1"
$global:mockRoot = (Get-Location).Path
$global:mockMode = "pending"
$global:mockCalls = 0
$matchingCommand = "cloud-firestore-emulator.jar --project_id demo-amon-ci --rules $global:mockRoot\firestore.rules"
$global:mockCommandLines = @($matchingCommand)
$global:mockStopCalls = 0

function global:Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State)
  $global:mockCalls++
  if ($global:mockMode -eq "pending" -and $global:mockCalls -ge 2) { return }
  for ($i = 0; $i -lt $global:mockCommandLines.Count; $i++) {
    [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 8080 + $i; OwningProcess = 987654 + $i }
  }
}
function global:Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  $index = [int]($Filter -replace 'ProcessId = ', '') - 987654
  [pscustomobject]@{
    Name = "java.exe"
    ExecutablePath = "C:\tools\java.exe"
    CommandLine = $global:mockCommandLines[$index]
  }
}
function global:Stop-Process {
  [CmdletBinding()]
  param([int[]]$Id)
  $global:mockStopCalls++
  throw "Postflight must never stop a process."
}
try {
  $clean = (& $target -ProjectRoot $global:mockRoot -GraceSeconds 2 -PollSeconds 1 | ConvertFrom-Json)
  if ($clean.status -ne "clean") { throw "Expected clean after delayed shutdown." }
  if ($clean.observations.Count -lt 2 -or $clean.observations[0].status -ne "shutdown_pending") {
    throw "Expected shutdown_pending before clean."
  }
  $global:mockMode = "persist"
  $cases = @(
    @{ Name = "both identifiers"; Commands = @($matchingCommand); Status = "residual"; Sample = "shutdown_pending" },
    @{ Name = "root only"; Commands = @("cloud-firestore-emulator.jar --project_id unrelated-project --rules $global:mockRoot\firestore.rules"); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "project ID only, foreign worktree"; Commands = @("cloud-firestore-emulator.jar --project_id demo-amon-ci --rules C:\unrelated-worktree\firestore.rules"); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "neither identifier"; Commands = @("cloud-firestore-emulator.jar --project_id unrelated-project"); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "empty command line"; Commands = @(''); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "null command line"; Commands = @($null); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "matching and partial owners"; Commands = @($matchingCommand, "cloud-firestore-emulator.jar --project_id demo-amon-ci"); Status = "ambiguous"; Sample = "ambiguous" },
    @{ Name = "no listeners"; Commands = @(); Status = "clean"; Sample = "clean" }
  )
  foreach ($case in $cases) {
    $global:mockCalls = 0
    $global:mockCommandLines = $case.Commands
    $report = (& $target -ProjectRoot $global:mockRoot -Ports @("8080", "8081") -GraceSeconds 0 | ConvertFrom-Json)
    if ($report.status -ne $case.Status) { throw "$($case.Name): expected $($case.Status), got $($report.status)." }
    if ($report.observations.Count -ne 1 -or $report.observations[0].status -ne $case.Sample) {
      throw "$($case.Name): incorrect intermediate classification."
    }
    if ($report.listeners.Count -ne $case.Commands.Count) { throw "$($case.Name): listener evidence lost." }
    if ($report.schema -ne "amon-emulator-verification/postflight-v2") { throw "Report schema changed." }
    if ($report.action -ne "read-only; no processes stopped" -or $report.note -notlike '*not a confirmed orphan*') {
      throw "Read-only/non-orphan contract changed."
    }
    Write-Output "PASS: $($case.Name) -> $($case.Sample) / $($case.Status)."
  }
  if ($global:mockStopCalls -ne 0) { throw "Unexpected cleanup invocation." }
  Write-Output "PASS: 9 synthetic scenarios, including delayed shutdown; no cleanup."
} finally {
  Remove-Item Function:\Get-NetTCPConnection -ErrorAction SilentlyContinue
  Remove-Item Function:\Get-CimInstance -ErrorAction SilentlyContinue
  Remove-Item Function:\Stop-Process -ErrorAction SilentlyContinue
}

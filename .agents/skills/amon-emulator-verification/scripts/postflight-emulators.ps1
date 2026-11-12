[CmdletBinding()]
param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$ExpectedProjectId = "demo-amon-ci",
  [string[]]$Ports = @("4000", "4400", "5001", "8080", "9099", "9150"),
  [ValidateRange(0, 600)][int]$GraceSeconds = 90,
  [ValidateRange(1, 60)][int]$PollSeconds = 10,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$preflight = Join-Path $PSScriptRoot "preflight-emulators.ps1"
$start = Get-Date
$deadline = $start.AddSeconds($GraceSeconds)
$observations = @()
$latest = $null
$inspectionError = $null
$latestListeners = @()

# Postflight is always read-only. A delayed emulator shutdown is not proof of an orphan.
do {
  try {
    $raw = @(& $preflight -ProjectRoot $ProjectRoot -ExpectedProjectId $ExpectedProjectId -Ports $Ports)
    $latest = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
    if ($latest.status -eq "error") { throw "Preflight reported an inspection error." }
  } catch {
    $inspectionError = $_.Exception.Message
    break
  }

  $latestListeners = @($latest.listeners | Where-Object { $null -ne $_ })
  $ambiguous = @($latestListeners | Where-Object { -not ($_.ProjectRootMatch -or $_.ExpectedProjectIdMatch) })
  $sampleStatus = if ($latest.status -eq "clean") {
    "clean"
  } elseif ($ambiguous.Count -gt 0) {
    "ambiguous"
  } else {
    "shutdown_pending"
  }
  $observations += [pscustomobject]@{
    timestampUtc = [DateTime]::UtcNow.ToString("o")
    status = $sampleStatus
    pids = @($latestListeners | Select-Object -ExpandProperty OwningProcess -Unique)
    ports = @($latestListeners | Select-Object -ExpandProperty LocalPort -Unique)
  }

  if ($sampleStatus -in @("clean", "ambiguous")) { break }
  $remaining = [math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
  if ($remaining -le 0) { break }
  Start-Sleep -Seconds ([int][math]::Min($PollSeconds, $remaining))
} while ($true)

$unmatched = @($latestListeners | Where-Object { -not ($_.ProjectRootMatch -or $_.ExpectedProjectIdMatch) })
$status = if ($inspectionError) {
  "error"
} elseif ($latest -and $latest.status -eq "clean") {
  "clean"
} elseif ($unmatched.Count -gt 0) {
  "ambiguous"
} else {
  "residual"
}

$report = [pscustomobject]@{
  schema = "amon-emulator-verification/postflight-v2"
  timestampUtc = [DateTime]::UtcNow.ToString("o")
  projectRoot = $ProjectRoot
  expectedProjectId = $ExpectedProjectId
  inspectedPorts = @($Ports)
  graceSeconds = $GraceSeconds
  pollSeconds = $PollSeconds
  elapsedSeconds = [math]::Round(((Get-Date) - $start).TotalSeconds, 2)
  status = $status
  observations = @($observations)
  listeners = @($latestListeners)
  inspectionErrors = if ($inspectionError) { @($inspectionError) } else { @() }
  note = "Residual means occupied after grace, not a confirmed orphan. Verify PID and obtain human approval before any cleanup."
  action = "read-only; no processes stopped"
}
$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}
$json
if ($inspectionError) { throw "Postflight inspection failed closed; no clean shutdown was certified." }

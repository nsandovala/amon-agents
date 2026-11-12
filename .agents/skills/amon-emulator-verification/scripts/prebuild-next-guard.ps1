[CmdletBinding()]
param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string[]]$Ports = @("3000", "3001"),
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$preflight = Join-Path $PSScriptRoot "preflight-emulators.ps1"
$inspection = $null
$errorText = $null
try {
  $raw = @(& $preflight -ProjectRoot $ProjectRoot -Ports $Ports)
  $inspection = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
  if ($inspection.status -eq "error") { throw "Port inspection returned error." }
} catch {
  $errorText = $_.Exception.Message
}

$listeners = if ($inspection) { @($inspection.listeners | Where-Object { $null -ne $_ }) } else { @() }
$status = if ($errorText) { "error" } elseif ($listeners.Count -gt 0) { "blocked" } else { "clear" }
$result = [pscustomobject]@{
  schema = "amon-emulator-verification/prebuild-next-v1"
  timestampUtc = [DateTime]::UtcNow.ToString("o")
  projectRoot = $ProjectRoot
  inspectedPorts = @($Ports)
  status = $status
  listeners = @($listeners)
  inspectionErrors = if ($errorText) { @($errorText) } else { @() }
  note = "Any listener on 3000/3001 blocks next build conservatively. Inspect custom ports manually."
  action = "read-only; no processes stopped"
}
$json = $result | ConvertTo-Json -Depth 7
if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}
$json
if ($status -ne "clear") { throw "Prebuild Next.js guard: $status. Review listener PIDs before running next build." }

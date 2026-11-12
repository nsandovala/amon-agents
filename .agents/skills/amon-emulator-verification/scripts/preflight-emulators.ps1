[CmdletBinding()]
param(
  [string]$ProjectRoot = (Get-Location).Path,
  [string]$ExpectedProjectId = "demo-amon-ci",
  [string[]]$Ports = @("4000", "4400", "5001", "8080", "9099", "9150"),
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$inspectionErrors = @()
$resolvedRoot = $null
$portNumbers = @()
$listeners = @()
$rows = @()

try {
  $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
  $portNumbers = @($Ports | ForEach-Object { [int]$_ })
  # Inspection must fail closed. SilentlyContinue would turn an enumeration
  # failure into an indistinguishable empty listener set.
  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -in $portNumbers } |
      Sort-Object LocalPort, OwningProcess
  )
} catch {
  $inspectionErrors += "listener enumeration: $($_.Exception.Message)"
}

if ($inspectionErrors.Count -eq 0) {
  $rows = foreach ($listener in $listeners) {
    $proc = $null
    $identityError = $null
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
      if (-not $proc) { throw "PID $($listener.OwningProcess) could not be resolved" }
    } catch {
      $identityError = $_.Exception.Message
      $inspectionErrors += "PID $($listener.OwningProcess) identity: $identityError"
    }

    [pscustomobject]@{
      LocalAddress = $listener.LocalAddress
      LocalPort = $listener.LocalPort
      OwningProcess = $listener.OwningProcess
      IdentityInspectionStatus = if ($proc) { "ok" } else { "error" }
      IdentityInspectionError = $identityError
      ProcessName = if ($proc) { $proc.Name } else { $null }
      ExecutablePath = if ($proc) { $proc.ExecutablePath } else { $null }
      CommandLine = if ($proc) { $proc.CommandLine } else { $null }
      ProjectRootMatch = if ($proc -and $proc.CommandLine) { $proc.CommandLine -like "*$resolvedRoot*" } else { $false }
      ExpectedProjectIdMatch = if ($proc -and $proc.CommandLine) { $proc.CommandLine -like "*$ExpectedProjectId*" } else { $false }
    }
  }
}

$result = [pscustomobject]@{
  schema = "amon-emulator-verification/preflight-v1"
  timestampUtc = [DateTime]::UtcNow.ToString("o")
  projectRoot = $resolvedRoot
  expectedProjectId = $ExpectedProjectId
  inspectedPorts = $portNumbers
  listeners = @($rows)
  status = if ($inspectionErrors.Count -gt 0) { "error" } elseif ($rows.Count -eq 0) { "clean" } else { "occupied" }
  inspectionErrors = @($inspectionErrors)
  action = "read-only; no processes stopped"
}
$json = $result | ConvertTo-Json -Depth 6
if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}
$json
if ($inspectionErrors.Count -gt 0) {
  throw "Preflight inspection failed; status is '$($result.status)' and cleanup is not authorized."
}

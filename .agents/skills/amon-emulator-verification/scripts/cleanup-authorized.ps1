[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ExpectedProjectRoot,
  [Parameter(Mandatory=$true)][string]$ExpectedProcessPattern,
  [switch]$ConfirmAuthorized
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmAuthorized) { throw "Refusing cleanup: pass -ConfirmAuthorized only after human approval for this exact PID." }
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction SilentlyContinue
if (-not $proc) { throw "PID $TargetPid is not running; nothing was stopped." }
$cmd = [string]$proc.CommandLine
if ($cmd -notlike "*$ExpectedProjectRoot*" -or $cmd -notlike "*$ExpectedProcessPattern*") {
  throw "Refusing cleanup: PID $TargetPid command line does not match both the expected project root and process pattern."
}
if ($PSCmdlet.ShouldProcess("PID $TargetPid ($($proc.Name))", "Stop exactly this authorized orphan process")) {
  Stop-Process -Id $TargetPid -ErrorAction Stop
  [pscustomobject]@{ stoppedPid = $TargetPid; processName = $proc.Name; commandLine = $cmd; authorized = $true; timestampUtc = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Depth 5
}

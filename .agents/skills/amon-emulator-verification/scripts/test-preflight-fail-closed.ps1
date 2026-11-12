[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$preflight = Join-Path $PSScriptRoot "preflight-emulators.ps1"

function global:Get-NetTCPConnection {
  throw "synthetic listener enumeration failure"
}

$scriptPath = (Resolve-Path -LiteralPath $preflight).Path.Replace("'", "''")
$projectRoot = (Get-Location).Path.Replace("'", "''")
$command = "function global:Get-NetTCPConnection { throw 'synthetic listener enumeration failure' }; & '$scriptPath' -ProjectRoot '$projectRoot' -ExpectedProjectId 'demo-amon-ci'"
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $command 2>&1
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($exitCode -eq 0) { throw "Expected preflight to fail when listener enumeration fails." }
$text = ($output | ForEach-Object { [string]$_ }) -join "`n"
$start = $text.IndexOf("{")
$end = $text.LastIndexOf("}")
if ($start -lt 0 -or $end -lt $start) { throw "Preflight failure did not emit a JSON report." }
$report = $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
if ($report.status -notin @("error", "unknown")) { throw "Expected error/unknown status, got '$($report.status)'." }
if ($report.status -eq "clean") { throw "Inspection failure was incorrectly reported as clean." }

$postflight = Join-Path $PSScriptRoot "postflight-emulators.ps1"
$postflightPath = (Resolve-Path -LiteralPath $postflight).Path.Replace("'", "''")
$postCommand = "function global:Get-NetTCPConnection { throw 'synthetic listener enumeration failure' }; & '$postflightPath' -ProjectRoot '$projectRoot' -ExpectedProjectId 'demo-amon-ci'"
$ErrorActionPreference = "Continue"
$postOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $postCommand 2>&1
$postExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($postExitCode -eq 0) { throw "Expected postflight to propagate the inspection failure." }
$postText = ($postOutput | ForEach-Object { [string]$_ }) -join "`n"
if ($postText -notmatch "no clean shutdown was certified") { throw "Postflight did not report the inspection failure." }
Write-Output "PASS: enumeration failure is not certified as clean."

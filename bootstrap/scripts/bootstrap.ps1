
---

## `bootstrap/scripts/bootstrap.ps1`

```powershell
param(
    [Parameter(Mandatory = $true)]
    [string]$Profile,

    [Parameter(Mandatory = $false)]
    [string]$TargetDir = "."
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir "..")

function Copy-Common {
    $source = Join-Path $RootDir "common"
    Copy-Item -Path (Join-Path $source "*") -Destination $TargetDir -Recurse -Force
}

function Copy-GitHub {
    $githubDir = Join-Path $TargetDir ".github"
    $workflowsDir = Join-Path $githubDir "workflows"

    New-Item -ItemType Directory -Force -Path $githubDir | Out-Null
    New-Item -ItemType Directory -Force -Path $workflowsDir | Out-Null

    $dependabotSource = Join-Path $RootDir "github\dependabot.yml"
    $dependabotTarget = Join-Path $githubDir "dependabot.yml"

    if (Test-Path $dependabotSource) {
        Copy-Item -Path $dependabotSource -Destination $dependabotTarget -Force
    }
}

function Copy-Workflow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkflowName
    )

    $source = Join-Path $RootDir "github\workflows\$WorkflowName"
    $destination = Join-Path $TargetDir ".github\workflows\$WorkflowName"

    if (-not (Test-Path $source)) {
        throw "Workflow no encontrado: $WorkflowName"
    }

    Copy-Item -Path $source -Destination $destination -Force
}

Copy-Common
Copy-GitHub

switch ($Profile) {
    "node-next" {
        Copy-Workflow -WorkflowName "node-ci.yml"
        Copy-Workflow -WorkflowName "codeql.yml"
    }
    "python-radar" {
        Copy-Workflow -WorkflowName "python-ci.yml"
        Copy-Workflow -WorkflowName "codeql.yml"
    }
    "mixed" {
        Copy-Workflow -WorkflowName "node-ci.yml"
        Copy-Workflow -WorkflowName "python-ci.yml"
        Copy-Workflow -WorkflowName "codeql.yml"
    }
    default {
        throw "Profile desconocido: $Profile. Usa: node-next | python-radar | mixed"
    }
}

Write-Host "✅ Bootstrap aplicado ($Profile) en: $TargetDir"
Write-Host "Siguiente paso: revisar README, variables y hacer commit inicial."
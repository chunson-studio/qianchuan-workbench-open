$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path "$scriptDir\.."
$launcher = Join-Path $projectRoot "scripts\start-workbench.js"

try {
    $connections = Get-NetTCPConnection -LocalPort 18991 -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        if ($conn.OwningProcess -and $conn.OwningProcess -gt 0) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}

Start-Sleep -Milliseconds 500

& node.exe "$launcher"
exit $LASTEXITCODE

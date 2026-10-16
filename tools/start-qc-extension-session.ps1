param(
    [Parameter(Mandatory = $true)][string]$ConfigFile,
    [string]$LogPrefix = 'extension-owner'
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathFullyQualified($ConfigFile) -or -not (Test-Path -LiteralPath $ConfigFile -PathType Leaf) -or $LogPrefix -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') { throw 'extension_launcher_input_invalid' }
$qcConfig = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $qcConfig.runtimeFile -PathType Leaf) {
    $qcPrevious = Get-Content -LiteralPath $qcConfig.runtimeFile -Raw | ConvertFrom-Json
    if ($qcPrevious.status -eq 'running' -and (Get-Process -Id $qcPrevious.pid -ErrorAction SilentlyContinue)) { throw 'extension_host_already_running' }
}
$qcNode = (Get-Command node -ErrorAction Stop).Source
$qcScript = Join-Path $PSScriptRoot 'start-qc-extension-session.cjs'
$qcDirectory = Split-Path -Parent $ConfigFile
$qcStarted = Start-Process -FilePath $qcNode -ArgumentList @(('"' + $qcScript + '"'),('"' + $ConfigFile + '"')) -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $qcDirectory ($LogPrefix + '.stdout.log')) -RedirectStandardError (Join-Path $qcDirectory ($LogPrefix + '.stderr.log')) -PassThru
[pscustomobject]@{ pid = $qcStarted.Id; window_style = 'hidden' } | ConvertTo-Json -Compress

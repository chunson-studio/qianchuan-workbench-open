param(
    [Parameter(Mandatory=$true)][string]$ConfigFile,
    [Parameter(Mandatory=$true)][string]$Room,
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
    [ValidateRange(1,3)][int]$Rounds=1
)
$ErrorActionPreference='Stop'
# Explicit maintenance only. Caller must finish all in-flight operations first.
if(-not [IO.Path]::IsPathFullyQualified($ConfigFile) -or -not [IO.Path]::IsPathFullyQualified($EvidenceDirectory) -or -not (Test-Path -LiteralPath $EvidenceDirectory -PathType Container)){throw 'extension_fault_paths_invalid'}
$qcConfig=Get-Content -LiteralPath $ConfigFile -Raw|ConvertFrom-Json
$qcSelected=@($qcConfig.bindings|Where-Object{$_.room -ceq $Room})
if($qcSelected.Count -ne 1){throw 'extension_fault_room_ambiguous'}
$qcNode=(Get-Command node -ErrorAction Stop).Source
$qcCheck=Join-Path $PSScriptRoot 'check-qc-extension-session.cjs'
$qcOwnerScript=Join-Path $PSScriptRoot 'start-qc-extension-session.cjs'
$qcMcpScript=Join-Path $qcConfig.depsRoot 'node_modules/@playwright/mcp/cli.js'
$qcResults=@()
for($qcRound=1;$qcRound -le $Rounds;$qcRound++){
    $qcBefore=Get-Content -LiteralPath $qcConfig.statusFile -Raw|ConvertFrom-Json
    $qcBinding=@($qcBefore.bindings|Where-Object{$_.room -ceq $Room})
    if($qcBefore.status -cne 'running' -or $qcBinding.Count -ne 1 -or $qcBinding[0].tab_id -ne $qcSelected[0].tab_id){throw 'extension_fault_status_mismatch'}
    $qcOwner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$qcBefore.pid)
    $qcChild=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$qcBinding[0].mcp_pid)
    if(-not $qcOwner -or $qcOwner.Name -cne 'node.exe' -or -not $qcOwner.CommandLine.Contains($qcOwnerScript) -or -not $qcOwner.CommandLine.Contains($ConfigFile)){throw 'extension_fault_owner_mismatch'}
    if(-not $qcChild -or $qcChild.Name -cne 'node.exe' -or $qcChild.ParentProcessId -ne $qcBefore.pid -or -not $qcChild.CommandLine.Replace('\','/').Contains($qcMcpScript.Replace('\','/'))){throw 'extension_fault_child_mismatch'}
    Stop-Process -Id $qcChild.ProcessId -ErrorAction Stop
    $qcReadEvidence=Join-Path $EvidenceDirectory ('transport-final-read-'+$qcRound+'.json')
    & $qcNode $qcCheck $ConfigFile $qcReadEvidence 'read_control' '3'
    if($LASTEXITCODE -ne 0){throw 'extension_fault_read_failed'}
    $qcAfter=Get-Content -LiteralPath $qcConfig.statusFile -Raw|ConvertFrom-Json
    $qcRecovered=@($qcAfter.bindings|Where-Object{$_.room -ceq $Room})[0]
    if($qcAfter.pid -ne $qcBefore.pid -or $qcAfter.host_id -cne $qcBefore.host_id -or $qcRecovered.tab_id -ne $qcBinding[0].tab_id -or $qcRecovered.mcp_pid -eq $qcBinding[0].mcp_pid -or $qcRecovered.transport_recovery_blocked){throw 'extension_fault_recovery_unverified'}
    $qcRead=Get-Content -LiteralPath $qcReadEvidence -Raw|ConvertFrom-Json
    $qcResults+= [pscustomobject]@{round=$qcRound;ok=$true;owner_pid=$qcAfter.pid;host_id=$qcAfter.host_id;tab_id=$qcRecovered.tab_id;stopped_mcp_pid=$qcChild.ProcessId;replacement_mcp_pid=$qcRecovered.mcp_pid;read_rounds_ms=@($qcRead.rounds|ForEach-Object{$_.elapsed_ms});chrome_stopped=$false;advertising_writes=0}
    [IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'transport-faults-final.json'),($qcResults|ConvertTo-Json -Depth 10 -AsArray))
}
$qcResults|ConvertTo-Json -Depth 10 -AsArray

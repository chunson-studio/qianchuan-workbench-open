param(
    [Parameter(Mandatory=$true)][string]$RootPath,
    [Parameter(Mandatory=$true)][int]$OwnerPid,
    [Parameter(Mandatory=$true)][string]$RunId,
    [switch]$Finished
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath($RootPath).TrimEnd('\')
$taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($taskRoot) -ne $taskTemp -or [IO.Path]::GetFileName($taskRoot) -notmatch '^qianchuan-tests-[A-Za-z0-9]{6}$') { exit 2 }
if (-not (Test-Path -LiteralPath $taskRoot -PathType Container)) { exit 0 }
if (((Get-Item -LiteralPath $taskRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
$taskMarker = Join-Path $taskRoot '.qc-test-owner.json'
try {
    $owner = Get-Content -LiteralPath $taskMarker -Raw | ConvertFrom-Json
    if ($owner.root -ne $taskRoot -or $owner.run_id -ne $RunId -or $owner.owner_pid -ne $OwnerPid -or $owner.purpose -ne 'synthetic_test_output') { exit 2 }
    if (-not $Finished -and (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) {
        try { Wait-Process -Id $OwnerPid -Timeout 60 -ErrorAction Stop }
        catch { if (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) { throw } }
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($taskRoot)
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                foreach ($target in @($item.Target)) {
                    if (-not $target) { throw 'Unknown link target' }
                    if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path ([IO.Path]::GetDirectoryName($item.FullName)) $target }
                    $resolved = [IO.Path]::GetFullPath($target)
                    if (-not $resolved.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Link leaves owned test directory' }
                }
            } elseif ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
    $current = Get-Content -LiteralPath $taskMarker -Raw | ConvertFrom-Json
    if ($current.run_id -ne $RunId -or $current.owner_pid -ne $OwnerPid) { throw 'Owner changed' }
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($taskRoot,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
} catch {
    if (Test-Path -LiteralPath $taskRoot -PathType Container) {
        'Test output retained because cleanup could not verify ownership, links, process exit or recycling.' |
            Set-Content -LiteralPath (Join-Path $taskRoot '.cleanup-pending.txt') -Encoding UTF8
    }
    exit 1
}

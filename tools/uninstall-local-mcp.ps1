param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$ServerName,
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$InstallationRoot,
    [string[]]$Artifacts = @(),
    [Parameter(Mandatory=$true)][string]$ReceiptPath,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath($InstallationRoot).TrimEnd('\')
$exePath = [IO.Path]::GetFullPath($Executable)
if (-not $exePath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Executable must be inside the named installation root' }
if ($installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\') -or $installRoot -eq $taskRoot) { throw 'Installation root is too broad' }
$configPath = Join-Path $taskRoot '.codex\config.toml'
$receipt = [IO.Path]::GetFullPath($ReceiptPath)
if (-not $receipt.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Receipt must be inside the project' }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($receipt)) -PathType Container)) { throw 'Receipt parent missing' }

function Inspect-Target([string]$Target) {
    $probe = Get-Item -LiteralPath $Target -Force
    $item = $probe
    while ($probe) {
        if (($probe.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Linked target rejected: $Target" }
        $parent = [IO.Path]::GetDirectoryName($probe.FullName.TrimEnd('\'))
        if (-not $parent) { break }
        $probe = Get-Item -LiteralPath $parent -Force
    }
    $files = @($item)
    if ($item.PSIsContainer) {
        $children = @(Get-ChildItem -LiteralPath $Target -Recurse -Force)
        if (@($children | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count) { throw "Linked child rejected: $Target" }
        $files = @($children | Where-Object {-not $_.PSIsContainer})
    }
    return [pscustomobject]@{path=$Target; directory=$item.PSIsContainer; files=$files.Count; bytes=($files | Measure-Object Length -Sum).Sum; status='reviewed'}
}

$paths = @()
foreach ($relative in $Artifacts) {
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[/\\])\.\.([/\\]|$)|:') { throw 'Artifact must be a project-relative path' }
    $target = [IO.Path]::GetFullPath((Join-Path $taskRoot $relative)).TrimEnd('\')
    if (-not $target.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact leaves project' }
    if ($target -eq $configPath -or $receipt -eq $target -or $receipt.StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact overlaps configuration or receipt' }
    $paths += $target
}
$paths += $installRoot
for ($i=0; $i -lt $paths.Count; $i++) {
    for ($j=0; $j -lt $paths.Count; $j++) {
        if ($i -ne $j -and ($paths[$i] -eq $paths[$j] -or $paths[$i].StartsWith($paths[$j] + '\',[StringComparison]::OrdinalIgnoreCase))) { throw 'Overlapping cleanup targets' }
    }
}
$targets = @($paths | ForEach-Object { if (Test-Path -LiteralPath $_) { Inspect-Target $_ } })
$processes = @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exePath})
foreach ($process in $processes) {
    if ($process.CommandLine -notmatch '--repo\s+(?:"([^"]+)"|(\S+))') { throw 'Executable has an unbound running process; inspect ownership first' }
    $repo = if ($Matches[1]) {$Matches[1]} else {$Matches[2]}
    if ([IO.Path]::GetFullPath($repo).TrimEnd('\') -ne $taskRoot) { throw 'Executable is in use by a different project' }
}
$before = [IO.File]::ReadAllText($configPath)
$beforeHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
$escaped = [regex]::Escape($ServerName)
$skip = $false
$afterLines = foreach ($line in ($before -split '\r?\n')) {
    if ($line -match '^\s*\[') { $skip = $line -match ('^\s*\[mcp_servers\.' + $escaped + '(?:\.|\])') }
    if (-not $skip -and $line -notmatch ('^#\s*' + $escaped + '\s+MCP\b')) { $line }
}
$newline = if ($before.Contains("`r`n")) { "`r`n" } else { "`n" }
$after = $afterLines -join $newline
$report = [ordered]@{server=$ServerName; project=$taskRoot; started_at=[DateTime]::UtcNow.ToString('o'); config_changed=($before -ne $after); process_ids=@($processes | ForEach-Object {$_.ProcessId}); targets=$targets; completed=$false}
if (-not $Apply) { $report | ConvertTo-Json -Depth 5; exit 0 }
if (Test-Path -LiteralPath $receipt) { throw 'Receipt already exists; inspect partial execution before retrying' }
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Configuration changed during review' }
[IO.File]::WriteAllText($configPath, $after, [Text.UTF8Encoding]::new($false))
foreach ($process in $processes) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)"
    if ($current -and $current.ExecutablePath -eq $process.ExecutablePath -and $current.CreationDate -eq $process.CreationDate) {
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
        Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
}
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($target in $targets) {
    $verified = Inspect-Target $target.path
    if ($verified.directory) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    }
    if (Test-Path -LiteralPath $target.path) { throw 'Recycle readback failed' }
    $target.status = 'recycled'
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
}
$report.completed = $true
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
[pscustomobject]@{completed=$true; stopped=$processes.Count; recycled=$targets.Count; bytes=($targets | Measure-Object bytes -Sum).Sum; receipt=$receipt} | ConvertTo-Json

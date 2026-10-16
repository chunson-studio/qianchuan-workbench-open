param(
    [Parameter(Mandatory=$true)][string]$RootPath,
    [Parameter(Mandatory=$true)][string]$ManifestPath,
    [string]$ReceiptPath,
    [string[]]$ReviewPaths = @(),
    [string]$Purpose,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
# Explicit reviewed paths only; directory manifests fingerprint every child before recycling.
$taskRoot = (Resolve-Path -LiteralPath $RootPath).Path.TrimEnd('\')
function Resolve-ReviewedPath([string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[/\\])\.\.([/\\]|$)|:') { throw 'Invalid relative path' }
    $target = [IO.Path]::GetFullPath((Join-Path $taskRoot $Relative)).TrimEnd('\')
    if (-not $target.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target leaves reviewed root' }
    $probe = Get-Item -LiteralPath $target -Force
    while ($probe) {
        if (($probe.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked target is not allowed' }
        $parent = [IO.Path]::GetDirectoryName($probe.FullName.TrimEnd('\'))
        if (-not $parent) { break }
        $probe = Get-Item -LiteralPath $parent -Force
    }
    return $target
}
function Get-ReviewedSnapshot([string]$Target) {
    $item = Get-Item -LiteralPath $Target -Force
    if (-not $item.PSIsContainer) {
        return [pscustomobject]@{kind='file'; sha256=(Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant(); files=1; bytes=$item.Length}
    }
    $lines = [Collections.Generic.List[string]]::new()
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($Target)
    [long]$bytes = 0; $count = 0
    while ($stack.Count) {
        foreach ($child in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked child is not allowed' }
            $name = $child.FullName.Substring($Target.Length + 1).Replace('\','/')
            if ($child.PSIsContainer) { $lines.Add('D ' + $name); $stack.Push($child.FullName) }
            else {
                $hash = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                $lines.Add('F ' + $name + ' ' + $child.Length + ' ' + $hash)
                $bytes += $child.Length; $count++
            }
        }
    }
    $lines.Sort([StringComparer]::Ordinal)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    return [pscustomobject]@{kind='directory'; sha256=$digest; files=$count; bytes=$bytes}
}
function Assert-NoRunningUse($Targets) {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine})
    foreach ($target in $Targets) {
        $absolute = $target.absolute.Replace('\','/').ToLowerInvariant()
        $relative = $target.path.Replace('\','/').ToLowerInvariant()
        foreach ($process in $processes) {
            $command = $process.CommandLine.Replace('\','/').ToLowerInvariant()
            if ($command.Contains($absolute) -or $command.Contains($relative)) { throw "Target is referenced by running PID $($process.ProcessId): $relative" }
        }
    }
}
if ($ReviewPaths.Count) {
    if ($Apply -or -not $Purpose) { throw 'ReviewPaths requires Purpose and cannot Apply' }
    $reviewed = @($ReviewPaths | ForEach-Object {
        $target = Resolve-ReviewedPath $_
        $snapshot = Get-ReviewedSnapshot $target
        [pscustomobject]@{path=$_; kind=$snapshot.kind; sha256=$snapshot.sha256; files=$snapshot.files; bytes=$snapshot.bytes}
    })
    [ordered]@{schema_version=2; purpose=$Purpose; files=$reviewed} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
    [pscustomobject]@{reviewed=$reviewed.Count; files=($reviewed | Measure-Object files -Sum).Sum; bytes=($reviewed | Measure-Object bytes -Sum).Sum; manifest=$ManifestPath} | ConvertTo-Json
    exit 0
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema_version -notin 1,2 -or -not $manifest.files -or -not $manifest.purpose) { throw 'Invalid reviewed manifest' }
if ($Apply -and -not $ReceiptPath) { throw 'Apply requires a receipt path' }
$targets = @()
$seen = @{}
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[/\\])\.\.([/\\]|$)|:') { throw 'Invalid relative path' }
    $target = [IO.Path]::GetFullPath((Join-Path $taskRoot $relative))
    if (-not $target.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target leaves reviewed root' }
    if ($seen.ContainsKey($target)) { throw 'Duplicate target' }
    $seen[$target] = $true
    $item = Get-Item -LiteralPath $target -Force
    if ($item.PSIsContainer -and ($manifest.schema_version -ne 2 -or $entry.kind -ne 'directory')) { throw 'Directories require a version 2 reviewed snapshot' }
    $probe = $item
    while ($probe.FullName.TrimEnd('\') -ne $taskRoot) {
        if (($probe.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked target is not allowed' }
        $probe = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($probe.FullName)) -Force
    }
    $snapshot = Get-ReviewedSnapshot (Resolve-ReviewedPath $relative)
    $digest = $snapshot.sha256
    if ($digest -ne $entry.sha256) { throw "File changed since review: $relative" }
    $targets += [pscustomobject]@{path=$relative; absolute=$target; sha256=$digest; kind=$snapshot.kind; files=$snapshot.files; bytes=$snapshot.bytes; status='reviewed'}
}
foreach ($target in $targets) {
    foreach ($other in $targets) {
        if ($target.absolute.StartsWith($other.absolute + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Overlapping cleanup targets' }
    }
}
Assert-NoRunningUse $targets
if (-not $Apply) { [pscustomobject]@{reviewed=$targets.Count; files=($targets | Measure-Object files -Sum).Sum; bytes=($targets | Measure-Object bytes -Sum).Sum} | ConvertTo-Json; exit 0 }
$receipt = [IO.Path]::GetFullPath($ReceiptPath)
if (-not $receipt.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($receipt)) { throw 'Receipt must be a separate file inside root' }
if (Test-Path -LiteralPath $receipt) { throw 'Receipt already exists; inspect it before a resumed operation' }
foreach ($target in $targets) {
    foreach ($protected in @($receipt, [IO.Path]::GetFullPath($ManifestPath))) {
        if ($protected -eq $target.absolute -or $protected.StartsWith($target.absolute + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Target overlaps manifest or receipt' }
    }
}
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($receipt)) -PathType Container)) { throw 'Receipt parent missing' }
Add-Type -AssemblyName Microsoft.VisualBasic
$report = [ordered]@{purpose=$manifest.purpose; started_at=[DateTime]::UtcNow.ToString('o'); root=$taskRoot; files=$targets}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
foreach ($target in $targets) {
    Assert-NoRunningUse @($target)
    if ((Get-ReviewedSnapshot (Resolve-ReviewedPath $target.path)).sha256 -ne $target.sha256) { throw 'File changed before recycling' }
    if ($target.kind -eq 'directory') {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target.absolute,
            [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
            [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
            [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target.absolute,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
        [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException) }
    if (Test-Path -LiteralPath $target.absolute) { throw 'Recycle readback failed' }
    $target.status = 'recycled'
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
}
[pscustomobject]@{recycled=$targets.Count; files=($targets | Measure-Object files -Sum).Sum; bytes=($targets | Measure-Object bytes -Sum).Sum; receipt=$receipt} | ConvertTo-Json

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TargetPath,
  [string]$SourcePath = (Join-Path $PSScriptRoot '../skills/qianchuan-ops'),
  [string]$BackupRoot = (Join-Path $PSScriptRoot '../work/skill-sync'),
  [string]$ExpectedDigest,
  [switch]$Apply
)

# Only explicit same-name skill directories are moved; no deletion occurs.
# Review the check output and merge unique content before applying its digest.
$ErrorActionPreference = 'Stop'
function FullPath([string]$Value) {
  return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]'\/')
}
function IsUnder([string]$Child, [string]$Parent) {
  return $Child.StartsWith($Parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function HashText([string]$Value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Inventory([string]$Directory) {
  $files = [ordered]@{}
  function Visit([string]$Current, [string]$Prefix) {
    foreach ($entry in (Get-ChildItem -LiteralPath $Current -Force | Sort-Object Name)) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "nested_link_requires_review:$($entry.FullName)" }
      $name = $Prefix + $entry.Name
      if ($entry.PSIsContainer) { Visit $entry.FullName ($name + '/') }
      else { $files[$name] = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
  }
  Visit $Directory ''
  return ,$files
}
function SaveJson([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
}

$source = FullPath $SourcePath
$target = FullPath $TargetPath
$backupBase = FullPath $BackupRoot
$targetParent = FullPath (Split-Path -Parent $target)
if ((Split-Path -Leaf $source) -ne 'qianchuan-ops' -or (Split-Path -Leaf $target) -ne 'qianchuan-ops') { throw 'same_name_skill_required' }
if ($source -eq $target -or (IsUnder $target $source) -or (IsUnder $source $target)) { throw 'source_target_overlap' }
if (-not (IsUnder $target $targetParent)) { throw 'target_outside_explicit_parent' }
if ($backupBase -eq $source -or $backupBase -eq $target -or (IsUnder $backupBase $source) -or (IsUnder $backupBase $target)) { throw 'backup_inside_skill' }
$sourceItem = Get-Item -LiteralPath $source -Force
if (-not $sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'source_must_be_canonical_directory' }
$sourceFiles = Inventory $source
if (-not $sourceFiles.Contains('SKILL.md')) { throw 'source_skill_missing' }
$targetItem = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
$targetFiles = [ordered]@{}
if ($targetItem) {
  if (-not $targetItem.PSIsContainer) { throw 'target_is_not_directory' }
  if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    $destination = FullPath ([string](@($targetItem.Target)[0]))
    if ($destination -ne $source) { throw 'existing_link_points_elsewhere' }
    $linkedFiles = Inventory $target
    if (($linkedFiles | ConvertTo-Json -Compress) -ne ($sourceFiles | ConvertTo-Json -Compress)) { throw 'existing_link_content_mismatch' }
    [pscustomobject]@{status='already_linked';verified=$true;source=$source;target=$target;link_type=$targetItem.LinkType;files=$sourceFiles.Count} | ConvertTo-Json -Depth 5
    return
  }
  $targetFiles = Inventory $target
}
$differences = @()
foreach ($name in $sourceFiles.Keys) {
  if (-not $targetFiles.Contains($name) -or $sourceFiles[$name] -ne $targetFiles[$name]) {
    $differences += [pscustomobject]@{file=$name;before=$targetFiles[$name];after=$sourceFiles[$name]}
  }
}
$extras = @($targetFiles.Keys | Where-Object { -not $sourceFiles.Contains($_) })
$fingerprint = [ordered]@{source=$source;target=$target;source_files=$sourceFiles;target_files=$targetFiles}
$digest = HashText ($fingerprint | ConvertTo-Json -Compress -Depth 6)
$plan = [ordered]@{status='review_required';source=$source;target=$target;target_parent=$targetParent;target_exists=[bool]$targetItem;files=$sourceFiles.Count;changes=$differences;extras=$extras;digest=$digest}
if (-not $Apply) { $plan | ConvertTo-Json -Depth 8; return }
if ($ExpectedDigest -ne $digest) { throw 'reviewed_plan_changed' }
if ($extras.Count) { throw 'target_extra_files_require_merge' }

New-Item -ItemType Directory -Path $backupBase -Force | Out-Null
$backupDirectory = FullPath (Join-Path $backupBase ('link-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))
if (-not (IsUnder $backupDirectory $backupBase)) { throw 'backup_outside_checked_root' }
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
SaveJson (Join-Path $backupDirectory 'plan.json') $plan
$backup = FullPath (Join-Path $backupDirectory 'before-qianchuan-ops')
if (-not (IsUnder $backup $backupDirectory)) { throw 'backup_move_target_invalid' }
if ((HashText ((Inventory $source) | ConvertTo-Json -Compress)) -ne (HashText ($sourceFiles | ConvertTo-Json -Compress))) { throw 'source_changed_before_move' }
if ($targetItem) {
  if ((HashText ((Inventory $target) | ConvertTo-Json -Compress)) -ne (HashText ($targetFiles | ConvertTo-Json -Compress))) { throw 'target_changed_before_move' }
  # Both absolute endpoints were checked against the explicit target parent and backup root.
  Move-Item -LiteralPath $target -Destination $backup
  if ((HashText ((Inventory $backup) | ConvertTo-Json -Compress)) -ne (HashText ($targetFiles | ConvertTo-Json -Compress))) { throw 'backup_verification_failed' }
}
New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
try {
  try { New-Item -ItemType SymbolicLink -Path $target -Target $source | Out-Null }
  catch {
    if (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue) { throw }
    # Junctions preserve shared directory writes when symbolic-link privilege is unavailable.
    New-Item -ItemType Junction -Path $target -Target $source | Out-Null
  }
} catch {
  if ($targetItem -and -not (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
    Move-Item -LiteralPath $backup -Destination $target
  }
  throw
}
$link = Get-Item -LiteralPath $target -Force
if ((FullPath ([string](@($link.Target)[0]))) -ne $source) { throw 'new_link_target_mismatch' }
if ((HashText ((Inventory $target) | ConvertTo-Json -Compress)) -ne (HashText ($sourceFiles | ConvertTo-Json -Compress))) { throw 'linked_inventory_mismatch' }
$receipt = [ordered]@{status='linked';verified=$true;source=$source;target=$target;link_type=$link.LinkType;files=$sourceFiles.Count;backup= $(if ($targetItem) {$backup} else {$null});reviewed_digest=$digest;verified_at=(Get-Date).ToUniversalTime().ToString('o')}
SaveJson (Join-Path $backupDirectory 'receipt.json') $receipt
$receipt | ConvertTo-Json -Depth 6

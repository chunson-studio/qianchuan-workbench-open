param(
    [Parameter(Mandatory = $true)][string]$ProfileDirectory,
    [string]$ChromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [string]$Url
)
$ErrorActionPreference = 'Stop'
if ($ProfileDirectory -notmatch '^Profile \d+$|^Default$') { throw 'profile_directory_invalid' }
$profileRoot = Join-Path $env:LOCALAPPDATA 'Google/Chrome/User Data'
$profilePath = Join-Path $profileRoot $ProfileDirectory
if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw 'chrome_not_found' }
if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw 'profile_not_found' }
$localState = Get-Content -LiteralPath (Join-Path $profileRoot 'Local State') -Raw | ConvertFrom-Json
$profileName = $localState.profile.info_cache.$ProfileDirectory.name
if (-not $profileName) { throw 'profile_registration_missing' }
if ($Url) {
    $qcUri = $null
    if ($Url -match '["\r\n]' -or -not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$qcUri) -or $qcUri.Scheme -ne 'https' -or $qcUri.Host -ne 'qianchuan.jinritemai.com' -or $qcUri.UserInfo) { throw 'qianchuan_url_invalid' }
    Start-Process -FilePath $ChromePath -ArgumentList @("--profile-directory=`"$ProfileDirectory`"", "`"$Url`"")
} else {
    Start-Process -FilePath $ChromePath -ArgumentList @("--profile-directory=`"$ProfileDirectory`"", '--restore-last-session')
}
[pscustomobject]@{ profile_directory = $ProfileDirectory; profile_name = $profileName; launch_requested = $true; browser_verified = $false }

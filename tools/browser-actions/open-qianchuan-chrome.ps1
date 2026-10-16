[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProfileName,
    [Parameter(Mandatory)][ValidatePattern('^\d+$')][string]$AdvertiserId,
    [Parameter(Mandatory)][string]$EntryUrl,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$browserEntryUri = [uri]$EntryUrl
if ($browserEntryUri.Scheme -ne 'https' -or $browserEntryUri.Host -ne 'qianchuan.jinritemai.com' -or $browserEntryUri.AbsolutePath -ne '/home' -or -not $browserEntryUri.IsDefaultPort -or $browserEntryUri.UserInfo) {
    throw '只能打开已验证的千川首页地址。'
}
$accountPairs = @(
    foreach ($queryPart in $browserEntryUri.Query.TrimStart('?').Split('&')) {
        $queryPair = $queryPart.Split('=', 2)
        $queryKey = [uri]::UnescapeDataString($queryPair[0])
        if ($queryKey -ieq 'aavid') {
            [pscustomobject]@{ Key = $queryKey; Value = if ($queryPair.Count -eq 2) { [uri]::UnescapeDataString($queryPair[1]) } else { '' } }
        }
    }
)
if ($accountPairs.Count -ne 1 -or $accountPairs[0].Key -cne 'aavid' -or $accountPairs[0].Value -cne $AdvertiserId) {
    throw '入口地址与显式广告主 ID 不符。'
}

# 只读取 Chrome 配置的名称和目录映射；不读取 Cookie 或修改配置。
$browserStatePath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
$browserState = Get-Content -LiteralPath $browserStatePath -Raw | ConvertFrom-Json
$profileMatches = @($browserState.profile.info_cache.PSObject.Properties | Where-Object { $_.Value.name -ceq $ProfileName })
if ($profileMatches.Count -ne 1) { throw 'Chrome 配置名称不存在或不唯一，停止；不使用其他配置。' }
$profileDirectory = $profileMatches[0].Name
if ($profileDirectory -notmatch '^(Default|Profile \d+)$') { throw 'Chrome 配置目录格式不符。' }
$chromeExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chromeExecutable -PathType Leaf)) { throw '已验证的 Chrome 程序路径不存在。' }

$openedAt = $null
if (-not $CheckOnly) {
    Start-Process -FilePath $chromeExecutable -WindowStyle Normal -ArgumentList @(
        ('--profile-directory="{0}"' -f $profileDirectory),
        '--new-window',
        ('"{0}"' -f $browserEntryUri.AbsoluteUri)
    )
    $openedAt = [DateTimeOffset]::UtcNow.ToString('o')
}
[pscustomobject]@{
    profile_name = $ProfileName
    profile_directory = $profileDirectory
    advertiser_id = $AdvertiserId
    entry_url = $browserEntryUri.AbsoluteUri
    check_only = [bool]$CheckOnly
    launch_requested_at = $openedAt
    next_step = 'CUA 连接相同 Chrome 配置，并核对可见广告主身份；进程启动不代表页面加载成功。'
} | ConvertTo-Json

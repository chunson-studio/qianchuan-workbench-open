param(
    [Parameter(Mandatory = $true)][string]$AutomationRoot,
    [string[]]$Ids = @(),
    [string]$ExpectedPath,
    [switch]$IncludePrompt
)
$ErrorActionPreference = 'Stop'
$expected = if ($ExpectedPath) { @(Get-Content -LiteralPath $ExpectedPath -Raw | ConvertFrom-Json) } else { @() }
$results = @(Get-ChildItem -LiteralPath $AutomationRoot -Filter automation.toml -Recurse | ForEach-Object {
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath $_.FullName)) {
        if ($line -match '^([a-z_]+) = (".*")$') { $values[$Matches[1]] = $Matches[2] | ConvertFrom-Json }
    }
    if ($Ids.Count -and $values.id -notin $Ids) { return }
    if ($values.prompt -notmatch '千川|直播间.*调控|素材调控') { return }
    $item = [ordered]@{ id=$values.id; name=$values.name; status=$values.status; rrule=$values.rrule; target_thread_id=$values.target_thread_id; notification_policy=$values.notification_policy }
    $item.legacy_clause = $values.prompt -match '不自动接下一场|不接下一场|只暂停本绑定调度|下播.{0,25}暂停.{0,20}调度'
    $item.continuous = $values.prompt.Contains('无需用户每场重复通知') -and $values.prompt.Contains('保留广告和原调度') -and $values.prompt.Contains('仅用户明确停止持续调控时暂停对应调度并回读')
    $item.scope_conflict = $values.prompt.Contains('无需用户每场重复通知') -and $values.prompt -match '自动暂停调度|用户要求恢复后'
    $item.prompt_sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($values.prompt))).ToLowerInvariant()
    $baseline = @($expected | Where-Object { $_.id -eq $values.id })
    if ($ExpectedPath) {
        if ($baseline.Count -ne 1) { throw "expected_schedule_missing_or_duplicate: $($values.id)" }
        foreach ($field in @('name','status','rrule','target_thread_id','notification_policy')) {
            if ([string]$values[$field] -cne [string]$baseline[0].$field) { throw "schedule_field_changed: $($values.id) $field" }
        }
        if ($baseline[0].PSObject.Properties.Name -contains 'prompt' -and $values.prompt -cne $baseline[0].prompt) { throw "schedule_prompt_mismatch: $($values.id)" }
        if ($baseline[0].PSObject.Properties.Name -contains 'prompt_sha256' -and $item.prompt_sha256 -cne $baseline[0].prompt_sha256) { throw "schedule_prompt_hash_mismatch: $($values.id)" }
    }
    if ($IncludePrompt) { $item.prompt = $values.prompt }
    [pscustomobject]$item
})
foreach ($id in $Ids) { if ($id -notin $results.id) { throw "schedule_not_found: $id" } }
$results | ConvertTo-Json -Depth 5

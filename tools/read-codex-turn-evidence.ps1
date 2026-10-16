param(
    [Parameter(Mandatory = $true)][string]$RolloutPath,
    [string[]]$TurnId = @(),
    [string[]]$CallId = @()
)
$ErrorActionPreference = 'Stop'
$activeTurn = $null
Get-Content -LiteralPath $RolloutPath -Encoding utf8 | ForEach-Object {
    $event = $_ | ConvertFrom-Json
    $payload = $event.payload
    if ($event.type -eq 'event_msg' -and $payload.type -eq 'task_started') {
        $activeTurn = $payload.turn_id
    }
    $turnSelected = $TurnId.Count -eq 0 -or $activeTurn -in $TurnId
    if ($event.type -eq 'event_msg' -and $payload.type -eq 'task_complete' -and $turnSelected) {
        [pscustomobject]@{timestamp=$event.timestamp; turn_id=$payload.turn_id; duration_ms=$payload.duration_ms; final=$payload.last_agent_message} | ConvertTo-Json -Depth 5 -Compress
    }
    if ($event.type -eq 'response_item' -and $payload.type -eq 'function_call_output' -and $payload.call_id -in $CallId -and $turnSelected) {
        $blocks = @($payload.output | Where-Object { $_.type -in @('input_text','text') } | ForEach-Object { $_.text })
        if ($payload.output -is [string]) { $blocks = @($payload.output) }
        [pscustomobject]@{timestamp=$event.timestamp; turn_id=$activeTurn; call_id=$payload.call_id; text=$blocks} | ConvertTo-Json -Depth 6 -Compress
    }
}

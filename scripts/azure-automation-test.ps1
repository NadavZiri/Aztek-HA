$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$global:aztekTestCalls = [Collections.Generic.List[string]]::new()
$global:aztekTestScenario = ''
$global:aztekTestDbChecks = 0
$global:aztekTestParameterFile = ''
function global:az {
  $a = @($args)
  $line = $a -join ' '
  $global:aztekTestCalls.Add($line)
  $global:LASTEXITCODE = 0
  if ($line -like 'group show*weatherWriterState*') {
    if ($global:aztekTestScenario -eq 'recovered') { return 'backup' }
    return 'primary'
  }
  if ($line -like 'provider show*') { return 'Registered' }
  if ($line -like 'network list-service-tags*') { return '{"values":[{"name":"AzureFrontDoor.Backend","properties":{"addressPrefixes":["203.0.113.0/24","2001:db8::/32"]}}]}' }
  if ($line -like 'deployment group validate*') {
    $fileIndex = [Array]::IndexOf($a, '--parameters') + 1
    $global:aztekTestParameterFile = $a[$fileIndex].Substring(1)
    $parameters = Get-Content -Raw $global:aztekTestParameterFile | ConvertFrom-Json
    if ($parameters.parameters.frontDoorPrefixes.value.Count -ne 1) { throw 'Preview must filter IPv6 ingress ranges.' }
  }
  if ($line -like 'deployment group show*') {
    return '{"primaryApp":{"value":"test-se-app"},"backupApp":{"value":"test-ie-app"},"primaryDatabase":{"value":"test-se-db"},"backupDatabase":{"value":"test-ie-db"},"profileName":{"value":"test-fd"},"endpointName":{"value":"test-edge"},"publicOrigin":{"value":"https://example.test"},"primaryMigrationJob":{"value":"test-se-migrate"}}'
  }
  if ($line -like 'postgres flexible-server show*test-se-db*') {
    $global:aztekTestDbChecks++
    if ($global:aztekTestScenario -eq 'unfenced') { return 'Ready' }
    if ($global:aztekTestDbChecks -gt 1) { return 'Stopped' }
    return 'Ready'
  }
  if ($line -like 'postgres flexible-server show*replicationRole*') { return 'Replica' }
  if ($line -like 'postgres flexible-server show*--query id*') { return '/subscriptions/test/replica' }
  if ($line -like 'monitor metrics list*') { return '{"value":[]}' }
  if ($line -like 'containerapp job start*') { return 'test-execution' }
  if ($line -like 'containerapp job execution show*') { return 'Succeeded' }
  if ($line -like 'afd origin update*primary*' -and $global:aztekTestScenario -eq 'ingress-failure') { $global:LASTEXITCODE = 1 }
}
function global:Start-Sleep {}
function global:Invoke-RestMethod { return @{ status = 'ready' } }
function global:Invoke-WebRequest { return @{ StatusCode = 200; Headers = @{ 'Cache-Control' = 'public, s-maxage=60, no-store' } } }
function Expect-Failure([scriptblock]$Action, [string]$Message) {
  $failed = $false
  try { & $Action | Out-Null } catch { $failed = $true }
  if (!$failed) { throw $Message }
}
$previousRegion = $env:ACTIVE_REGION
$previousSecrets = @{}
foreach ($name in @('AZURE_DATABASE_PASSWORD','AZURE_APP_DATABASE_PASSWORD','AZURE_JWT_SECRET','AZURE_OPENWEATHER_KEY','AZURE_ORIGIN_SECRET')) {
  $previousSecrets[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
  $env:ACTIVE_REGION = 'primary'
  Expect-Failure { & "$root\scripts\azure-provision.ps1" -SubscriptionId test -ResourceGroup test -Apply } 'Provisioning must require cost approval.'
  if ($global:aztekTestCalls.Count -ne 0) { throw 'Cost gate must run before Azure calls.' }
  Expect-Failure { & "$root\scripts\azure-recover.ps1" -ResourceGroup test -Incident incident } 'Recovery must require data-loss acknowledgment.'
  if ($global:aztekTestCalls.Count -ne 0) { throw 'Recovery approval must precede Azure calls.' }
  foreach ($name in $previousSecrets.Keys) { [Environment]::SetEnvironmentVariable($name, 'isolated-mock-secret-at-least-32-characters') }
  & "$root\scripts\azure-provision.ps1" -SubscriptionId test -ResourceGroup test | Out-Null
  if ($global:aztekTestCalls | Where-Object { $_ -like 'deployment group create*' -or $_ -like 'group update*' }) { throw 'Preview must not create/mutate resources.' }
  if (Test-Path -LiteralPath $global:aztekTestParameterFile) { throw 'Temporary secret parameter file was not removed.' }
  foreach ($scenario in @('ingress-failure','unfenced')) {
    $global:aztekTestScenario = $scenario
    $global:aztekTestCalls.Clear()
    $global:aztekTestDbChecks = 0
    Expect-Failure { & "$root\scripts\azure-recover.ps1" -ResourceGroup test -Incident incident -AcceptDataLoss } 'Failed fencing must abort.'
    if ($global:aztekTestCalls | Where-Object { $_ -like '*replica promote*' }) { throw 'Replica promoted without fencing.' }
  }
  $global:aztekTestScenario = 'success'
  $global:aztekTestCalls.Clear()
  $global:aztekTestDbChecks = 0
  & "$root\scripts\azure-recover.ps1" -ResourceGroup test -Incident incident -AcceptDataLoss | Out-Null
  $joined = $global:aztekTestCalls -join "`n"
  if ($joined -notmatch 'replica promote -g test -n test-ie-db --promote-mode standalone --promote-option forced --yes') { throw 'Promotion command arguments missing.' }
  $stop = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like 'postgres flexible-server stop*' })
  $promote = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like '*replica promote*' })
  $reset = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like '*RECOVERY_RESET_SESSIONS=true*' })
  $activate = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like 'afd origin update*backup*Enabled*' })
  if (!($stop -ge 0 -and $stop -lt $promote -and $promote -lt $reset -and $reset -lt $activate)) { throw 'Unsafe recovery sequence.' }
  if ($joined -notmatch 'tags.weatherWriterState=recovering' -or $joined -notmatch 'tags.weatherWriterState=backup') { throw 'Recovery must persist Azure writer state.' }
  $global:aztekTestCalls.Clear()
  & "$root\scripts\azure-release.ps1" -ResourceGroup test -Image ("registry/weather@sha256:" + ('a' * 64)) -BackupImage ("backup/weather@sha256:" + ('a' * 64)) | Out-Null
  $migration = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like 'containerapp job start*' })
  $release = $global:aztekTestCalls.FindIndex([Predicate[string]]{ param($line) $line -like 'containerapp update*test-se-app*' })
  if ($migration -lt 0 -or $release -le $migration) { throw 'Release must migrate before updating apps.' }
  $env:ACTIVE_REGION = 'backup'
  $global:aztekTestCalls.Clear()
  Expect-Failure { & "$root\scripts\azure-release.ps1" -ResourceGroup test -Image ("registry/weather@sha256:" + ('a' * 64)) -BackupImage ("backup/weather@sha256:" + ('a' * 64)) } 'Original releases must be blocked after recovery.'
  if ($global:aztekTestCalls.Count -ne 0) { throw 'Post-recovery release guard must precede Azure calls.' }
  $env:ACTIVE_REGION = 'primary'
  $global:aztekTestScenario = 'recovered'
  $global:aztekTestCalls.Clear()
  Expect-Failure { & "$root\scripts\azure-release.ps1" -ResourceGroup test -Image ("registry/weather@sha256:" + ('a' * 64)) -BackupImage ("backup/weather@sha256:" + ('a' * 64)) } 'Azure marker must block releases even if GitHub state is stale.'
  if ($global:aztekTestCalls | Where-Object { $_ -like 'containerapp *' }) { throw 'Cloud recovery marker did not block app mutation.' }
  Write-Host 'Automation tests passed: approval gates, CLI argument forwarding, failed fencing, recovery ordering, migration ordering and post-recovery deployment guard. Azure calls were mocked.'
} finally {
  $env:ACTIVE_REGION = $previousRegion
  foreach ($name in $previousSecrets.Keys) { [Environment]::SetEnvironmentVariable($name, $previousSecrets[$name]) }
  foreach ($name in @('az','Start-Sleep','Invoke-RestMethod','Invoke-WebRequest')) { Remove-Item "Function:\$name" }
  Remove-Variable aztekTestCalls,aztekTestScenario,aztekTestDbChecks,aztekTestParameterFile -Scope Global
}

param(
  [Parameter(Mandatory)][string]$SubscriptionId,
  [Parameter(Mandatory)][string]$ResourceGroup,
  [ValidatePattern('^[a-z][a-z0-9]{2,9}$')][string]$Prefix = 'aztek',
  [switch]$Apply,
  [switch]$CostApproved,
  [switch]$ZoneHa
)
$ErrorActionPreference = 'Stop'
function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $result = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0]) $($Arguments[1])" }
  return $result
}
if ($Apply -and !$CostApproved) { throw 'Apply requires explicit approval of the complete monthly cost.' }
if ($Apply -and !$env:GITHUB_SHA) { throw 'GITHUB_SHA is required before creating paid resources.' }
if ($env:ACTIVE_REGION -ne 'primary') { throw 'Provisioning requires ACTIVE_REGION=primary; rebuild topology after recovery.' }
Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
$writerState = Invoke-Az @('group','show','-n',$ResourceGroup,'--query','tags.weatherWriterState','-o','tsv')
if ($writerState -and $writerState -ne 'primary') { throw 'Azure writer-state marker blocks original-topology provisioning.' }
foreach ($provider in @('Microsoft.App','Microsoft.Network','Microsoft.DBforPostgreSQL','Microsoft.ContainerRegistry','Microsoft.Cdn','Microsoft.KeyVault','Microsoft.ManagedIdentity','Microsoft.OperationalInsights')) {
  $state = Invoke-Az @('provider','show','--namespace',$provider,'--query','registrationState','-o','tsv')
  if ($state -ne 'Registered') { throw "Register $provider before running the preview." }
}
$tags = (Invoke-Az @('network','list-service-tags','--location','swedencentral','-o','json') | Out-String | ConvertFrom-Json)
$prefixes = @($tags.values | Where-Object name -eq 'AzureFrontDoor.Backend' | ForEach-Object { $_.properties.addressPrefixes } | Where-Object { $_ -notmatch ':' })
if ($prefixes.Count -eq 0) { throw 'No current Front Door IPv4 ranges found; refusing unrestricted origins.' }
$values = @{
  prefix = $Prefix
  databaseZoneHa = [bool]$ZoneHa
  frontDoorPrefixes = $prefixes
}
foreach ($pair in @{
  databasePassword = 'AZURE_DATABASE_PASSWORD'
  appDatabasePassword = 'AZURE_APP_DATABASE_PASSWORD'
  jwtSecret = 'AZURE_JWT_SECRET'
  openWeatherKey = 'AZURE_OPENWEATHER_KEY'
  originSecret = 'AZURE_ORIGIN_SECRET'
}.GetEnumerator()) {
  $value = [Environment]::GetEnvironmentVariable($pair.Value)
  if (!$value) { throw "Missing environment secret $($pair.Value)" }
  $values[$pair.Key] = $value
}
$file = Join-Path ([IO.Path]::GetTempPath()) "aztek-$([guid]::NewGuid()).parameters.json"
function Write-Parameters {
  $parameters = @{}
  foreach ($key in $values.Keys) { $parameters[$key] = @{ value = $values[$key] } }
  @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } |
    ConvertTo-Json -Depth 12 | Set-Content -Path $file
}
try {
  Write-Parameters
  $argsBase = @('--resource-group',$ResourceGroup,'--template-file','infra/main.bicep','--parameters',"@$file")
  Invoke-Az -Arguments (@('deployment','group','validate') + $argsBase) | Out-Null
  Invoke-Az -Arguments (@('deployment','group','what-if') + $argsBase + @('--exclude-change-types','NoChange'))
  if (!$Apply) { return }
  Invoke-Az @('group','update','-n',$ResourceGroup,'--set','tags.weatherWriterState=primary') | Out-Null
  Invoke-Az -Arguments (@('deployment','group','create','--name','weather-foundation') + $argsBase + @('--only-show-errors')) | Out-Null
  $outputs = Invoke-Az @('deployment','group','show','-g',$ResourceGroup,'-n','weather-foundation','--query','properties.outputs','-o','json') | Out-String | ConvertFrom-Json
  $registry = $outputs.registryName.value
  Invoke-Az @('acr','login','--name',$registry) | Out-Null
  $tag = "$($outputs.registryHost.value)/weather:$env:GITHUB_SHA"
  & docker build --tag $tag .
  if ($LASTEXITCODE -ne 0) { throw 'Container build failed' }
  & docker push $tag
  if ($LASTEXITCODE -ne 0) { throw 'Container push failed' }
  Invoke-Az @('acr','login','--name',$outputs.backupRegistryName.value) | Out-Null
  $backupTag = "$($outputs.backupRegistryHost.value)/weather:$env:GITHUB_SHA"
  & docker tag $tag $backupTag
  if ($LASTEXITCODE -ne 0) { throw 'Backup container tag failed' }
  & docker push $backupTag
  if ($LASTEXITCODE -ne 0) { throw 'Backup container push failed' }
  $digest = Invoke-Az @('acr','repository','show','--name',$registry,'--image',"weather:$env:GITHUB_SHA",'--query','digest','-o','tsv')
  $backupDigest = Invoke-Az @('acr','repository','show','--name',$outputs.backupRegistryName.value,'--image',"weather:$env:GITHUB_SHA",'--query','digest','-o','tsv')
  if ($digest -ne $backupDigest) { throw 'Regional image digests differ.' }
  $values.image = "$($outputs.registryHost.value)/weather@$digest"
  $values.backupImage = "$($outputs.backupRegistryHost.value)/weather@$digest"
  $values.deployApp = $true
  Write-Parameters
  Invoke-Az -Arguments (@('deployment','group','create','--name','weather-apps') + $argsBase + @('--only-show-errors')) | Out-Null
  & "$PSScriptRoot\azure-release.ps1" -ResourceGroup $ResourceGroup -Image $values.image -BackupImage $values.backupImage
} finally {
  Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
}

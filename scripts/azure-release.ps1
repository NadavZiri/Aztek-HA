param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][ValidatePattern('@sha256:[a-f0-9]{64}$')][string]$Image,
  [Parameter(Mandatory)][ValidatePattern('@sha256:[a-f0-9]{64}$')][string]$BackupImage
)
$ErrorActionPreference = 'Stop'
function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $result = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0]) $($Arguments[1])" }
  return $result
}
if ($env:ACTIVE_REGION -ne 'primary') { throw 'Release requires ACTIVE_REGION=primary; post-recovery deployment needs a rebuilt topology.' }
if (($Image -split '@')[1] -ne ($BackupImage -split '@')[1]) { throw 'Regional release digests must match.' }
$writerState = Invoke-Az @('group','show','-n',$ResourceGroup,'--query','tags.weatherWriterState','-o','tsv')
if ($writerState -ne 'primary') { throw 'Azure writer-state marker blocks release during/after recovery.' }
$o = Invoke-Az @('deployment','group','show','-g',$ResourceGroup,'-n','weather-apps','--query','properties.outputs','-o','json') | Out-String | ConvertFrom-Json
$primary = $o.primaryApp.value
$backup = $o.backupApp.value
if (!$primary -or !$backup) { throw 'Deployment outputs missing.' }
# Migrations must be backward compatible with the still-running old revision.
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',$o.primaryMigrationJob.value,'--image',$Image) | Out-Null
$execution = Invoke-Az @('containerapp','job','start','-g',$ResourceGroup,'-n',$o.primaryMigrationJob.value,'--query','name','-o','tsv')
$deadline = (Get-Date).AddMinutes(12)
do {
  Start-Sleep -Seconds 10
  $status = Invoke-Az @('containerapp','job','execution','show','-g',$ResourceGroup,'-n',$o.primaryMigrationJob.value,'--job-execution-name',$execution,'--query','properties.status','-o','tsv')
  if ($status -in @('Failed','Stopped','Degraded')) { throw "Migration execution $execution failed: $status" }
} until ($status -eq 'Succeeded' -or (Get-Date) -gt $deadline)
if ($status -ne 'Succeeded') { throw 'Migration execution timed out.' }
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',($backup -replace '-app$', '-migrate'),'--image',$BackupImage) | Out-Null
Invoke-Az @('containerapp','update','-g',$ResourceGroup,'-n',$backup,'--image',$BackupImage,'--set-env-vars','DEPLOYMENT_ROLE=standby') | Out-Null
Invoke-Az @('containerapp','update','-g',$ResourceGroup,'-n',$primary,'--image',$Image,'--set-env-vars','DEPLOYMENT_ROLE=active') | Out-Null
foreach ($app in @($primary,$backup)) {
  $job = $app -replace '-app$', '-cleanup'
  $regionalImage = if ($app -eq $primary) { $Image } else { $BackupImage }
  $role = if ($app -eq $primary) { 'active' } else { 'standby' }
  Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',$job,'--image',$regionalImage,'--set-env-vars',"DEPLOYMENT_ROLE=$role") | Out-Null
}
$deadline = (Get-Date).AddMinutes(12)
do {
  Start-Sleep -Seconds 20
  try {
    $health = Invoke-RestMethod -Uri "$($o.publicOrigin.value)/health/ready" -TimeoutSec 15
    $ready = $health.status -eq 'ready'
  } catch {
    Write-Warning "Public readiness not available yet: $($_.Exception.Message)"
    $ready = $false
  }
} until ($ready -or (Get-Date) -gt $deadline)
if (!$ready) { throw 'Public write readiness failed after release; inspect revision and Front Door probes.' }
$frontend = Invoke-WebRequest -Uri $o.publicOrigin.value -TimeoutSec 30
if ($frontend.StatusCode -ne 200 -or $frontend.Headers.'Cache-Control' -notmatch 's-maxage=60') { throw 'Frontend cache smoke test failed.' }
$csrf = Invoke-WebRequest -Uri "$($o.publicOrigin.value)/api/auth/csrf" -TimeoutSec 30
if ($csrf.Headers.'Cache-Control' -notmatch 'no-store') { throw 'Private API cache smoke test failed.' }
Invoke-Az @('afd','endpoint','purge','-g',$ResourceGroup,'--profile-name',$o.profileName.value,'--endpoint-name',$o.endpointName.value,'--content-paths','/','/index.html') | Out-Null
Write-Host 'Immutable release and public smoke checks succeeded.'

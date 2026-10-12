param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Incident,
  [switch]$AcceptDataLoss
)
$ErrorActionPreference = 'Stop'
function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $result = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure command failed: $($Arguments[0]) $($Arguments[1])" }
  return $result
}
if (!$AcceptDataLoss) { throw 'Forced recovery requires explicit acknowledgment of asynchronous data loss.' }
if ($env:ACTIVE_REGION -ne 'primary') { throw 'Expected primary topology; repeated recovery is not safe.' }
if ($Incident.Length -lt 5) { throw 'Record a meaningful incident reference.' }
$writerState = Invoke-Az @('group','show','-n',$ResourceGroup,'--query','tags.weatherWriterState','-o','tsv')
if ($writerState -ne 'primary') { throw 'Azure writer-state marker requires incident review before another recovery.' }
$o = Invoke-Az @('deployment','group','show','-g',$ResourceGroup,'-n','weather-apps','--query','properties.outputs','-o','json') | Out-String | ConvertFrom-Json
$backupApp = $o.backupApp.value
$backupJob = $backupApp -replace '-app$', '-migrate'
$primaryState = Invoke-Az @('postgres','flexible-server','show','-g',$ResourceGroup,'-n',$o.primaryDatabase.value,'--query','state','-o','tsv')
$replicaRole = Invoke-Az @('postgres','flexible-server','show','-g',$ResourceGroup,'-n',$o.backupDatabase.value,'--query','replicationRole','-o','tsv')
if ($replicaRole -ne 'Replica') { throw 'Backup is not a replica; inspect prior recovery before continuing.' }
$replicaId = Invoke-Az @('postgres','flexible-server','show','-g',$ResourceGroup,'-n',$o.backupDatabase.value,'--query','id','-o','tsv')
$lag = Invoke-Az @('monitor','metrics','list','--resource',$replicaId,'--metric','physical_replication_delay_in_seconds','--interval','PT1M','--aggregation','Maximum','-o','json')
Write-Host "Incident: $Incident. Review replication lag (missing samples do not mean zero):"
Write-Output $lag
Invoke-Az @('group','update','-n',$ResourceGroup,'--set','tags.weatherWriterState=recovering') | Out-Null
# Fence ingress before touching either writer; failures abort without promotion.
Invoke-Az @('afd','origin','update','-g',$ResourceGroup,'--profile-name',$o.profileName.value,'--origin-group-name','weather','--origin-name','primary','--enabled-state','Disabled') | Out-Null
Invoke-Az @('containerapp','update','-g',$ResourceGroup,'-n',$o.primaryApp.value,'--set-env-vars','DEPLOYMENT_ROLE=standby') | Out-Null
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',($o.primaryApp.value -replace '-app$', '-cleanup'),'--set-env-vars','DEPLOYMENT_ROLE=standby') | Out-Null
if ($primaryState -ne 'Stopped') {
  Invoke-Az @('postgres','flexible-server','stop','-g',$ResourceGroup,'-n',$o.primaryDatabase.value) | Out-Null
}
$state = Invoke-Az @('postgres','flexible-server','show','-g',$ResourceGroup,'-n',$o.primaryDatabase.value,'--query','state','-o','tsv')
if ($state -ne 'Stopped') { throw 'Old database is not verifiably fenced. Promotion is prohibited.' }
Invoke-Az @('postgres','flexible-server','replica','promote','-g',$ResourceGroup,'-n',$o.backupDatabase.value,'--promote-mode','standalone','--promote-option','forced','--yes') | Out-Null
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',$backupJob,'--set-env-vars','RECOVERY_RESET_SESSIONS=true') | Out-Null
$execution = Invoke-Az @('containerapp','job','start','-g',$ResourceGroup,'-n',$backupJob,'--query','name','-o','tsv')
$deadline = (Get-Date).AddMinutes(12)
do {
  Start-Sleep -Seconds 10
  $status = Invoke-Az @('containerapp','job','execution','show','-g',$ResourceGroup,'-n',$backupJob,'--job-execution-name',$execution,'--query','properties.status','-o','tsv')
  if ($status -in @('Failed','Stopped','Degraded')) { throw "Recovery database job failed: $status. Leave origins disabled." }
} until ($status -eq 'Succeeded' -or (Get-Date) -gt $deadline)
if ($status -ne 'Succeeded') { throw 'Session invalidation/migration timed out; leave backup inactive.' }
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',$backupJob,'--set-env-vars','RECOVERY_RESET_SESSIONS=false') | Out-Null
Invoke-Az @('containerapp','update','-g',$ResourceGroup,'-n',$backupApp,'--set-env-vars','DEPLOYMENT_ROLE=active','--min-replicas','2') | Out-Null
Invoke-Az @('containerapp','job','update','-g',$ResourceGroup,'-n',($backupApp -replace '-app$', '-cleanup'),'--set-env-vars','DEPLOYMENT_ROLE=active') | Out-Null
Invoke-Az @('afd','origin','update','-g',$ResourceGroup,'--profile-name',$o.profileName.value,'--origin-group-name','weather','--origin-name','backup','--enabled-state','Enabled','--priority','1') | Out-Null
$deadline = (Get-Date).AddMinutes(12)
do {
  Start-Sleep -Seconds 20
  try {
    $ready = (Invoke-RestMethod -Uri "$($o.publicOrigin.value)/health/ready" -TimeoutSec 15).status -eq 'ready'
  } catch {
    Write-Warning "Recovery readiness pending: $($_.Exception.Message)"
    $ready = $false
  }
} until ($ready -or (Get-Date) -gt $deadline)
if (!$ready) { throw 'Backup write readiness failed. Do not re-enable the old origin.' }
Invoke-Az @('group','update','-n',$ResourceGroup,'--set','tags.weatherWriterState=backup') | Out-Null
Write-Host 'Recovery verified. Set GitHub ACTIVE_REGION=backup immediately. Sessions were revoked. Do not redeploy the original Bicep topology.'

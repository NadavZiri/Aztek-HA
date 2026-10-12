param name string
param location string
param subnetId string
param registryId string
param registryHost string
param image string
param deployApp bool
param active bool
param minReplicas int
param frontDoorId string
param publicOrigin string
@minLength(1)
param frontDoorPrefixes array
@secure()
param databaseUrl string
@secure()
param adminDatabaseUrl string
@secure()
param jwtSecret string
@secure()
param openWeatherKey string
@secure()
param originSecret string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-identity'
  location: location
}
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, identity.id, 'pull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, workspaceCapping: { dailyQuotaGb: 1 } }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${name}-kv'
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
  }
}
resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'secrets')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}
var secretValues = [
  { name: 'database-url', value: databaseUrl }
  { name: 'admin-database-url', value: adminDatabaseUrl }
  { name: 'jwt-secret', value: jwtSecret }
  { name: 'openweather-key', value: openWeatherKey }
  { name: 'origin-secret', value: originSecret }
]
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for secret in secretValues: {
  parent: vault
  name: secret.name
  properties: { value: secret.value }
}]
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${name}-env'
  location: location
  properties: {
    zoneRedundant: true
    vnetConfiguration: { infrastructureSubnetId: subnetId, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}
var appSecrets = [for secret in secretValues: {
  name: secret.name
  keyVaultUrl: 'https://${vault.name}${az.environment().suffixes.keyvaultDns}/secrets/${secret.name}'
  identity: identity.id
}]
var envVars = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'BIND_HOST', value: '0.0.0.0' }
  { name: 'PORT', value: '3001' }
  { name: 'TRUST_PROXY_HOPS', value: '2' }
  { name: 'DEPLOYMENT_ROLE', value: active ? 'active' : 'standby' }
  { name: 'APP_ORIGIN', value: publicOrigin }
  { name: 'FRONT_DOOR_ID', value: frontDoorId }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
  { name: 'OPENWEATHER_API_KEY', secretRef: 'openweather-key' }
  { name: 'FRONT_DOOR_SECRET', secretRef: 'origin-secret' }
]
resource app 'Microsoft.App/containerApps@2025-01-01' = if (deployApp) {
  name: '${name}-app'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: appSecrets
      registries: [{ server: registryHost, identity: identity.id }]
      ingress: {
        external: true
        targetPort: 3001
        transport: 'http'
        allowInsecure: false
        ipSecurityRestrictions: [for (prefix, i) in frontDoorPrefixes: {
          name: 'frontdoor-${i}'
          action: 'Allow'
          ipAddressRange: prefix
          description: 'AzureFrontDoor.Backend IPv4'
        }]
      }
    }
    template: {
      containers: [{
        name: 'weather'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: envVars
        probes: [
          { type: 'Liveness', httpGet: { path: '/health/live', port: 3001 }, initialDelaySeconds: 10, periodSeconds: 10 }
          { type: 'Readiness', httpGet: { path: '/health/live', port: 3001 }, periodSeconds: 10 }
        ]
      }]
      scale: { minReplicas: minReplicas, maxReplicas: 5, rules: [{ name: 'http', http: { metadata: { concurrentRequests: '40' } } }] }
    }
  }
  dependsOn: [pull, secretReader, secrets]
}
resource migrate 'Microsoft.App/jobs@2025-01-01' = if (deployApp) {
  name: '${name}-migrate'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryHost, identity: identity.id }]
      secrets: appSecrets
    }
    template: {
      containers: [{
        name: 'migrate'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        command: ['node', 'scripts/migrate.mjs']
        env: [
          { name: 'DATABASE_URL', secretRef: 'admin-database-url' }
          { name: 'APP_DATABASE_URL', secretRef: 'database-url' }
        ]
      }]
    }
  }
  dependsOn: [pull, secretReader, secrets]
}
resource cleanup 'Microsoft.App/jobs@2025-01-01' = if (deployApp) {
  name: '${name}-cleanup'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 300
      replicaRetryLimit: 0
      scheduleTriggerConfig: { cronExpression: '0 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryHost, identity: identity.id }]
      secrets: appSecrets
    }
    template: {
      containers: [{
        name: 'cleanup'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        command: ['node', 'dist/cleanup.js']
        env: [
          { name: 'DATABASE_URL', secretRef: 'database-url' }
          { name: 'DEPLOYMENT_ROLE', value: active ? 'active' : 'standby' }
        ]
      }]
    }
  }
  dependsOn: [pull, secretReader, secrets]
}
output host string = deployApp ? app!.properties.configuration.ingress.fqdn : ''
output vaultName string = vault.name
output appName string = '${name}-app'
output migrationJob string = '${name}-migrate'

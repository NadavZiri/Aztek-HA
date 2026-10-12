@minLength(3)
@maxLength(10)
param prefix string = 'aztek'
@allowed(['swedencentral'])
param primaryLocation string = 'swedencentral'
@allowed(['northeurope'])
param backupLocation string = 'northeurope'
@allowed(['Standard_D2ds_v5'])
param databaseSku string = 'Standard_D2ds_v5'
param databaseZoneHa bool = false
param deployApp bool = false
param primaryActive bool = false
param image string = ''
param backupImage string = ''
@minLength(1)
param frontDoorPrefixes array
@secure()
param databasePassword string
@secure()
param appDatabasePassword string
@secure()
param jwtSecret string
@secure()
param openWeatherKey string
@secure()
param originSecret string

var suffix = uniqueString(resourceGroup().id)
var name = '${prefix}-${take(suffix, 7)}'
var registryName = '${prefix}${suffix}'
module primaryNet './network.bicep' = {
  name: 'primary-network'
  params: { name: '${name}-se', location: primaryLocation, addressPrefix: '10.20.0.0/16', appSubnetPrefix: '10.20.0.0/23', dbSubnetPrefix: '10.20.2.0/24' }
}
module backupNet './network.bicep' = {
  name: 'backup-network'
  params: { name: '${name}-ie', location: backupLocation, addressPrefix: '10.21.0.0/16', appSubnetPrefix: '10.21.0.0/23', dbSubnetPrefix: '10.21.2.0/24' }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${name}.postgres.database.azure.com'
  location: 'global'
}
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (region, i) in ['se', 'ie']: {
  parent: dns
  name: 'region-${i}'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: resourceId('Microsoft.Network/virtualNetworks', '${name}-${region}-vnet') } }
  dependsOn: [primaryNet, backupNet]
}]
resource primaryDb 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-se-db'
  location: primaryLocation
  sku: { name: databaseSku, tier: 'GeneralPurpose' }
  properties: {
    createMode: 'Default'
    version: '17'
    administratorLogin: 'weather_admin'
    administratorLoginPassword: databasePassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: databaseZoneHa ? 'ZoneRedundant' : 'Disabled' }
    network: { delegatedSubnetResourceId: primaryNet.outputs.dbSubnetId, privateDnsZoneArmResourceId: dns.id, publicNetworkAccess: 'Disabled' }
  }
  dependsOn: [links]
}
resource backupDb 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-ie-db'
  location: backupLocation
  sku: { name: databaseSku, tier: 'GeneralPurpose' }
  properties: {
    createMode: 'Replica'
    sourceServerResourceId: primaryDb.id
    version: '17'
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    network: { delegatedSubnetResourceId: backupNet.outputs.dbSubnetId, privateDnsZoneArmResourceId: dns.id, publicNetworkAccess: 'Disabled' }
  }
  dependsOn: [links]
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: primaryLocation
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}
resource backupRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${registryName}ie'
  location: backupLocation
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}
resource profile 'Microsoft.Cdn/profiles@2025-06-01' = {
  name: '${name}-fd'
  location: 'global'
  sku: { name: 'Standard_AzureFrontDoor' }
  properties: { originResponseTimeoutSeconds: 60 }
}
resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2025-06-01' = {
  parent: profile
  name: '${name}-edge'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}
var publicOrigin = 'https://${endpoint.properties.hostName}'
module primary './region.bicep' = {
  name: 'primary-app'
  params: {
    name: '${name}-se'
    location: primaryLocation
    subnetId: primaryNet.outputs.appSubnetId
    registryId: registry.id
    registryHost: registry.properties.loginServer
    image: image
    deployApp: deployApp
    active: primaryActive
    minReplicas: 2
    frontDoorId: profile.properties.frontDoorId
    publicOrigin: publicOrigin
    frontDoorPrefixes: frontDoorPrefixes
    databaseUrl: 'postgresql://weather_app:${uriComponent(appDatabasePassword)}@${primaryDb.properties.fullyQualifiedDomainName}:5432/weather?sslmode=require&connection_limit=5&pool_timeout=20&connect_timeout=10'
    adminDatabaseUrl: 'postgresql://weather_admin:${uriComponent(databasePassword)}@${primaryDb.properties.fullyQualifiedDomainName}:5432/weather?sslmode=require&connect_timeout=10'
    jwtSecret: jwtSecret
    openWeatherKey: openWeatherKey
    originSecret: originSecret
  }
}
module backup './region.bicep' = {
  name: 'backup-app'
  params: {
    name: '${name}-ie'
    location: backupLocation
    subnetId: backupNet.outputs.appSubnetId
    registryId: backupRegistry.id
    registryHost: backupRegistry.properties.loginServer
    image: backupImage
    deployApp: deployApp
    active: false
    minReplicas: 1
    frontDoorId: profile.properties.frontDoorId
    publicOrigin: publicOrigin
    frontDoorPrefixes: frontDoorPrefixes
    databaseUrl: 'postgresql://weather_app:${uriComponent(appDatabasePassword)}@${backupDb.properties.fullyQualifiedDomainName}:5432/weather?sslmode=require&connection_limit=5&pool_timeout=20&connect_timeout=10'
    adminDatabaseUrl: 'postgresql://weather_admin:${uriComponent(databasePassword)}@${backupDb.properties.fullyQualifiedDomainName}:5432/weather?sslmode=require&connect_timeout=10'
    jwtSecret: jwtSecret
    openWeatherKey: openWeatherKey
    originSecret: originSecret
  }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: primaryDb
  name: 'weather'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
module edge './edge.bicep' = if (deployApp) {
  name: 'edge-routes'
  params: {
    profileName: profile.name
    endpointName: endpoint.name
    primaryHost: primary.outputs.host
    backupHost: backup.outputs.host
    originSecret: originSecret
  }
}
output registryName string = registry.name
output registryHost string = registry.properties.loginServer
output backupRegistryName string = backupRegistry.name
output backupRegistryHost string = backupRegistry.properties.loginServer
output publicOrigin string = publicOrigin
output primaryDatabase string = primaryDb.name
output backupDatabase string = backupDb.name
output primaryApp string = primary.outputs.appName
output backupApp string = backup.outputs.appName
output primaryMigrationJob string = primary.outputs.migrationJob
output primaryVault string = primary.outputs.vaultName
output backupVault string = backup.outputs.vaultName
output profileName string = profile.name
output endpointName string = endpoint.name

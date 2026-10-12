param name string
param location string
param addressPrefix string
param appSubnetPrefix string
param dbSubnetPrefix string

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: appSubnetPrefix
          delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: dbSubnetPrefix
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
    ]
  }
}
output id string = network.id
output appSubnetId string = '${network.id}/subnets/apps'
output dbSubnetId string = '${network.id}/subnets/postgres'

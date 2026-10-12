param profileName string
param endpointName string
param primaryHost string
param backupHost string
@secure()
param originSecret string

resource profile 'Microsoft.Cdn/profiles@2025-06-01' existing = { name: profileName }
resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2025-06-01' existing = { parent: profile, name: endpointName }
resource group 'Microsoft.Cdn/profiles/originGroups@2025-06-01' = {
  parent: profile
  name: 'weather'
  properties: {
    healthProbeSettings: { probePath: '/health/ready', probeRequestType: 'GET', probeProtocol: 'Https', probeIntervalInSeconds: 60 }
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 0 }
    sessionAffinityState: 'Disabled'
  }
}
resource origins 'Microsoft.Cdn/profiles/originGroups/origins@2025-06-01' = [for origin in [
  { name: 'primary', host: primaryHost, state: 'Enabled', priority: 1 }
  { name: 'backup', host: backupHost, state: 'Disabled', priority: 2 }
]: {
  parent: group
  name: origin.name
  properties: {
    hostName: origin.host
    originHostHeader: origin.host
    httpPort: 80
    httpsPort: 443
    priority: origin.priority
    weight: 1000
    enabledState: origin.state
    enforceCertificateNameCheck: true
  }
}]
resource rules 'Microsoft.Cdn/profiles/ruleSets@2025-06-01' = { parent: profile, name: 'originAuth' }
resource header 'Microsoft.Cdn/profiles/ruleSets/rules@2025-06-01' = {
  parent: rules
  name: 'originSecret'
  properties: {
    order: 1
    conditions: []
    actions: [{
      name: 'ModifyRequestHeader'
      parameters: { typeName: 'DeliveryRuleHeaderActionParameters', headerAction: 'Overwrite', headerName: 'X-Origin-Secret', value: originSecret }
    }]
  }
}
resource api 'Microsoft.Cdn/profiles/afdEndpoints/routes@2025-06-01' = {
  parent: endpoint
  name: 'api'
  properties: {
    originGroup: { id: group.id }
    ruleSets: [{ id: rules.id }]
    patternsToMatch: ['/api', '/api/*', '/health/*']
    supportedProtocols: ['Https']
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    enabledState: 'Enabled'
  }
  dependsOn: [origins, header]
}
resource static 'Microsoft.Cdn/profiles/afdEndpoints/routes@2025-06-01' = {
  parent: endpoint
  name: 'frontend'
  properties: {
    originGroup: { id: group.id }
    ruleSets: [{ id: rules.id }]
    patternsToMatch: ['/*']
    supportedProtocols: ['Http', 'Https']
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    enabledState: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'IgnoreSpecifiedQueryStrings'
      queryParameters: 'utm_source,utm_medium,utm_campaign'
      compressionSettings: {
        isCompressionEnabled: true
        contentTypesToCompress: ['text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'image/svg+xml']
      }
    }
  }
  dependsOn: [origins, header]
}

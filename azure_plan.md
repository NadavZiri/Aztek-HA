# Azure deployment decision record

## Confirmed baseline

Sweden Central is the primary region; North Europe (Ireland) is the warm backup. Application servers, databases and backups stay in Europe. Global caching of public frontend assets is allowed.

Use Azure Front Door Standard for public TLS, routing and static caching; Azure Container Apps with two zone-distributed primary replicas and one warm backup replica; PostgreSQL Flexible Server General Purpose with one writable primary and an asynchronous regional replica.

Primary database zone-redundant HA is optional, not mandatory. The baseline is recoverable across regions, but does not provide seamless or zero-loss database failover. Read replicas must be promoted before receiving writes. Controlled recovery must fence the old writer, validate replication lag, promote, check write readiness and switch routing. Failback requires rebuilding replication, not enabling two writers.

## Pricing reasoning

Compared Standard_D2ds_v5, 2 vCPUs, in EUR using Azure Retail Prices. Rates are per vCore-hour; estimates use 730 hours/month:

| Region | EUR/vCore-hour | One 2-vCPU server/month |
| --- | ---: | ---: |
| Sweden Central | 0.1646 | 240.32 |
| North Europe | 0.1742 | 254.33 |
| West Europe | 0.1866 | 272.44 |

Two-region baseline database compute: approximately EUR 494.65/month. Optional Sweden zone-HA standby adds EUR 240.32/month. These are compute subtotals, not a complete quote: storage, replication traffic, backups, app compute, registry, Front Door, networking, secrets, monitoring and taxes are additional.

Sweden was cheapest among these three for this SKU, not proven cheapest across all Azure options. Subscription quota, regional capacity, private-network/replica compatibility and complete cost must be checked before provisioning.

## Front Door cost controls

The user selected static caching/compression first, preserving authenticated weather retrieval.

- Versioned `/assets/*` bundles: origin headers `public, max-age=31536000, immutable`.
- HTML: browsers revalidate; shared caches may retain it for 60 seconds. Do not override this with long forced TTLs.
- Unversioned public files: five-minute cache.
- Enable compression on eligible cached static content. Front Door compression requires caching.
- Ignore only representation-irrelevant tracking query parameters on public asset routes.
- Disable caching on `/api/*`, errors and authentication responses; preserve `no-store` and never cache Set-Cookie responses.
- Do not add another CDN/global routing service for the same purpose.
- Assess custom WAF abuse filtering separately; verify pricing, supported rules and trusted client-IP handling before enabling.

Caching reduces repeated origin work but does not reduce fixed database or minimum-replica costs. Edge requests and transfer remain billable; savings depend on traffic and cache hit ratio.

## API writes and correctness

Keep a single authoritative European writer for accounts, session refresh/revocation, drafts and saved snapshots. Do not authorize users against a lagging replica. Global edges do not eliminate physical latency to Europe for private requests.

Preserve the authenticated POST weather flow and server-owned drafts, ensuring Save stores exactly the displayed forecast. A public cached weather GET endpoint is out of scope.

## Implementation status and prerequisites

Implemented reusable Bicep, GitHub OIDC workflows, non-root container builds, origin cache headers, liveness/write readiness, trusted-proxy configuration, shared PostgreSQL rate limits, private database networking, regional Key Vault identities, migration/cleanup jobs and controlled recovery scripts. Each region has a Basic registry with the same immutable image digest: backup scaling must not depend on a registry in the failed primary region.

No Azure resources, routes or edge compression settings have actually been provisioned. Standalone Bicep compilation, local Docker tests and mocked automation tests are not cloud validation.

Before provisioning, confirm the target subscription, resource group, public hostname and complete cost. Front Door origin-bypass restrictions must be validated; header checks alone are insufficient. Run infrastructure preview, test deployed endpoints and measure failover/data-loss behavior. Keep backup destinations European.

## Infrastructure and operational choices

- PostgreSQL 17, General Purpose `Standard_D2ds_v5`, 32 GiB initial storage with autogrow. Primary backup retention is 14 days; geo-redundant backup is disabled so this configuration does not introduce an unverified paired-region backup destination. The regional replica is not a substitute for historical restore tests. Verify backup policy/retention on promotion.
- Both databases have delegated private subnets and shared private DNS linked to both regional networks; there are no public database firewall exceptions.
- Zone-redundant Container Apps workload-profile environments use Consumption instances: primary minimum two, standby minimum one, maximum five per app. One warm instance is not itself redundant across zones; recovery raises the Irish app minimum to two.
- Regional Key Vaults retain/purge-protect secrets and grant the local user-assigned identity Secrets User. Registry admin accounts are off; local identities get AcrPull. Application DB credentials differ from migration administrator credentials.
- Key Vault and registry public service endpoints remain enabled, protected by Azure authentication/RBAC. This is not a claim of private-only service connectivity.
- Database connection pools are capped at five connections per app instance; connection/pool timeouts are explicit. Prisma reconnects after a temporary outage, as locally tested. Backend does not crash merely because the initial DB connection is unavailable.
- Production rate-limiter updates are atomic in the authoritative PostgreSQL database, not per-process counters. Their traffic adds database work; error handling does not fail open.
- Regional Log Analytics retention is 30 days, capped at 1 GiB/day each. Reaching the cap can interrupt log ingestion; configure notifications/budgets for a real rollout. No on-call alert destination is configured without an operator contact.
- Origin ingress allows the current `AzureFrontDoor.Backend` IPv4 ranges, obtained during preview/provision. Container Apps IP restrictions accept IPv4; validate the regional ingress rule count and behavior in Azure. The app additionally validates `X-Azure-FDID` and a request secret overwritten by Front Door. The secret is defense in depth, not a substitute for source restrictions; control-plane readers may see Front Door rule configuration.
- Refresh the published service-tag ranges regularly. Do not rely on a public-environment subnet NSG for ingress: public workload-profile ingress bypasses that subnet boundary. Confirm direct-origin rejection from an external network before opening the application.
- Front Door API/health routes omit `cacheConfiguration`; frontend routes use origin TTLs and compression. Edge configuration honors only explicitly ignored tracking parameters. Private authorization does not move to the edge.
- Application/migration images intentionally retain Prisma CLI dependencies; this trades some image size for a single locally verified release artifact.

## GitHub/Azure bootstrap

1. Select an Azure subscription and **precreate** the resource group in Sweden Central. Obtain a complete quote for both databases/storage/backups/replication, both Container Apps environments/minimum replicas, two Basic registries, Key Vaults, Front Door base/requests/egress and logging. Review regional SKU availability, PostgreSQL vCore and Container Apps quotas, zone support and private read-replica compatibility. A preview is not a cost quote.
2. Register `Microsoft.App`, `Microsoft.Network`, `Microsoft.DBforPostgreSQL`, `Microsoft.ContainerRegistry`, `Microsoft.Cdn`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`. The provision script checks registration; it does not silently register providers.
3. Create a deployment Entra application/service principal or user-assigned identity. Add federated credentials with issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and subjects `repo:NadavZiri/Aztek-HA:environment:azure-production` and `repo:NadavZiri/Aztek-HA:environment:azure-recovery`. No long-lived Azure client secret is used.
4. Grant the deployment identity resource-group Contributor plus scoped role-assignment administration needed to assign managed identities. Grant AcrPush at the approved resource-group scope for initial image publication (it covers the registries created during bootstrap), then narrow to both registry scopes if desired. Bootstrap administrators must establish these grants; the app identities receive only their local pull/secret roles. Restrict the deployment identity and trusted workflow branches because it can run admin migration jobs.
5. Create GitHub environments `azure-production` and `azure-recovery` with required reviewers and trusted deployment branch rules. The assignment branch is `azure-automation`; production workflows should run only trusted reviewed code. Confirm reviewers are enforced by the repository's GitHub plan.
6. Set repository variables:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | Federated deployment identity client ID |
   | `AZURE_TENANT_ID` | Entra tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Approved subscription ID |
   | `AZURE_RESOURCE_GROUP` | Precreated resource group |
   | `AZURE_PREFIX` | Lowercase alphanumeric prefix, 3-10 characters, starting with a letter |
   | `ACTIVE_REGION` | `primary` initially; `backup` after recovery |

7. Set environment secrets in `azure-production`: `AZURE_DATABASE_PASSWORD`, `AZURE_APP_DATABASE_PASSWORD`, `AZURE_JWT_SECRET`, `AZURE_OPENWEATHER_KEY`, `AZURE_ORIGIN_SECRET`. Use different strong generated database passwords, at least 32-character random JWT/origin secrets, and a real provider key. Do not put secrets in Git, command transcripts, screenshots or uploaded parameter artifacts. Temporary parameter files are deleted in a `finally` block.
8. Run **Preview or provision European Azure environment** with `apply=false`; read validation/what-if output. No paid resources are created in preview mode. The chosen default public hostname is the generated Front Door HTTPS endpoint. A custom domain/certificate/DNS change is a separate optional addition.
9. After full-cost/capacity approval, run with `apply=true` and `cost_approved=true`; zone HA remains optional. The workflow first runs CI, creates foundations, builds/pushes identical images to both registries, deploys inactive apps/jobs, runs the primary migration job once, then activates the primary and verifies public readiness, static headers and API no-store.
10. Check actual Key Vault RBAC propagation, database/private DNS connectivity, direct-origin access denial, correct effective client IP/rate limiting, secure cookies/CSRF, snapshot ownership, edge compression/cache HITs, monitored costs, backup restore and a regional drill. Infrastructure preview or local success does not replace these checks.

The provision workflow deliberately stops rather than bypassing missing providers, empty service-tag ranges, absent secrets, invalid costs or failed migrations. Role propagation/capacity restrictions may require operator remediation and rerun. Azure credentials were unavailable in this session, so none of the live checks above have been performed.

## Releases and maintenance

Run **Release immutable application image** after code review. CI (including isolated container tests) runs first. The workflow pushes the same digest to both regional registries, executes the primary migration job, updates both apps and jobs, verifies readiness/cache headers and purges cached HTML only. Hashed assets keep their long TTLs. Use backward-compatible expand/contract migrations: the old revision can remain serving while migrations run.

An application rollback can deploy a previous known digest **present in both registries**, using `scripts/azure-release.ps1` with `-ResourceGroup`, `-Image` and `-BackupImage`. This never reverses schema migrations. Do not roll back across an incompatible database change. Retain previous digests in both registries for rollback.

Use PowerShell 7 and Azure CLI with the Container Apps extension for local control-plane scripts; GitHub hosted runners provide PowerShell/Azure CLI. CI compiles `infra/main.bicep`, tests mock control-plane behavior and runs `npm run test:container`. Origin source ranges must be refreshed using Container Apps ingress restrictions when Microsoft's service-tag list changes; preview/provision obtains current ranges, but no unattended range-refresh job is enabled.

## Controlled forced recovery

The **Controlled forced regional recovery** workflow requires a protected recovery environment, incident reference and explicit data-loss acknowledgment. This is deliberately conservative, not seamless automatic failover:

1. Inspect health, incident scope and replica lag. The workflow prints `physical_replication_delay_in_seconds` samples; missing samples never mean zero. Acknowledgment accepts uncertain asynchronous loss; no RPO/RTO is promised.
2. Disable the primary Front Door origin, set the old app and cleanup to standby, stop the primary PostgreSQL server and verify its state is `Stopped`. If the control plane cannot prove this fence, **abort without promotion**. Escalate operationally; the script has no unsafe override.
3. Promote the Irish replica as a standalone writer with forced mode. The existing Irish app still rejects private requests.
4. Run its admin deployment job against the promoted database. Apply pending compatible migrations, ensure runtime grants, revoke **all** sessions and delete transient drafts before accepting traffic. This avoids authorizing tokens from potentially rolled-back session revocations; accounts/snapshots that never replicated can still be lost.
5. Activate the Irish app/cleanup, raise its minimum to two, enable only the Irish Front Door origin and verify database-backed write readiness through the public endpoint.
6. The workflow persists the resource-group tag `weatherWriterState=recovering` before fencing and `backup` after verified recovery. Original provisioning/releases check this Azure marker as well as GitHub state, so forgetting a GitHub variable cannot automatically reopen the old writer. Immediately set repository `ACTIVE_REGION=backup` too. Do not reopen the old origin or rerun the original topology against a promoted database. PostgreSQL stopped servers can automatically restart after their service stop window; the disabled origin plus standby app/cleanup must remain fenced even then.

On a partial failure, leave the old origin disabled and preserve the `recovering` marker. Preserve the incident log and inspect the last completed phase rather than rerunning blindly: a promoted database is no longer a replica, and the script rejects that precondition. Local tests cover failed ingress fences, non-stopped databases, ordering and acknowledgment gates; they do not simulate Azure regional control-plane outages.

## Failback runbook

There is no automatic failback to divergent data. Keep North Europe authoritative, reconcile any lost writes with users and verify backups. Preserve the old Swedish database for investigation; do not start serving it. Create a **new** private Swedish replica of the Irish writer, using a new server name, capacity checks and compatible SKU/storage. Wait for healthy replication and validate lag/restore tests.

Update the IaC resource identities/source relationship and both regional Key Vault URLs to that new topology. Plan an approved maintenance window to fence Irish application/cleanup writes. For a loss-minimizing return, use the PostgreSQL planned switchover procedure with the required writer/reader virtual endpoints, wait for write readiness on the Swedish server, update roles/routing and validate auth/snapshots before making Sweden authoritative. Maintain one writer throughout. Only reset `ACTIVE_REGION=primary` and the resource-group `weatherWriterState=primary` tag after the source/replica resources and scripts reflect the rebuilt topology. Original template reapplication is not a failback mechanism.

## Local verification evidence

- TypeScript, ESLint, unit/UI/hosting/static tests and production builds passed.
- The Bicep graph compiled with standalone Bicep CLI; no schema errors remained.
- Linux image built successfully; fixed missing cross-platform native dependency lock entries and aligned esbuild with Vite's peer range.
- Isolated real PostgreSQL tests passed, including concurrent shared-rate-limit counts, JSONB snapshot persistence and session behavior.
- Container validation confirmed repeated migration jobs, non-admin runtime role, non-root UID, origin-header gate, public asset headers, private API no-store, register/login/logout, standby refusal, recovery session reset and DB outage/reconnection. No real OpenWeather requests were used.
- Mocked PowerShell tests validate cost/data-loss approvals, CLI argument forwarding, failed fencing, migration/recovery ordering and rejection of original releases after recovery.

Live deployment, real edge latency/cache effectiveness, regional replica lag/fault behavior, full prices and regional quotas remain **blocked by missing Azure authentication/subscription configuration**, not marked verified. No billable resources were created and no deployment changes were committed or pushed.

## Official references

- [PostgreSQL billing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Retail prices API](https://prices.azure.com/api/retail/prices)
- [PostgreSQL replicas](https://learn.microsoft.com/en-us/azure/postgresql/read-replica/concepts-read-replicas)
- [Container Apps reliability](https://learn.microsoft.com/en-us/azure/reliability/reliability-container-apps)
- [Front Door caching](https://learn.microsoft.com/en-us/azure/frontdoor/front-door-caching)
- [Front Door compression](https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/how-to-compression)
- [Front Door pricing](https://learn.microsoft.com/en-us/azure/frontdoor/understanding-pricing)
- [Container Apps ingress restrictions](https://learn.microsoft.com/en-us/azure/container-apps/ip-restrictions)
- [Container Apps networking/NSG limitations](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration)
- [PostgreSQL replica promotion CLI](https://learn.microsoft.com/en-us/cli/azure/postgres/flexible-server/replica)
- [GitHub OIDC for Azure Login](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)

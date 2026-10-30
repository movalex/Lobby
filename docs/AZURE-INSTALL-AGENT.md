# Lobby on Azure: install runbook for a local agent

**What this is.** Step-by-step instructions for a Claude Code session running on a person's own computer, in a clone of
this repository, with the Azure CLI (`az`) signed in to DBC's tenant. The agent prepares files, runs read-only `az`
commands on its own, and runs everything that creates, changes or costs something only after the person says yes to that
step. The design it builds is the one in [`docs/GO-LIVE-AZURE.md`](GO-LIVE-AZURE.md) §2: two VMs and Azure's managed
Postgres. The one change is that the database goes on DBC's existing Flexible Server **dbcpsql** instead of a new one.

**What this run delivers.** A working Lobby on a **rehearsal** hostname (proposed `lobby-rehearsal.darkburn.com`), built
from a reviewed commit of `main`, on:

- the **main VM**: Caddy (HTTPS) → the web container (nginx, one origin) → api and sync, with board files on a separate
  Premium SSD managed disk;
- the **worker VM**: the preview worker and the Office sidecar, no inbound ports;
- **dbcpsql**: a new `lobby` database and login role, nothing else on that server touched.

**Not in this run** (each follows `docs/GO-LIVE-AZURE.md` §5–7 and needs the owner's approval):

- Okta and Microsoft sign-in (the code does not exist yet);
- the Azure Blob storage driver;
- moving staging's data from Render;
- the production hostname, the cut-over and retiring Render.

**Status.** Written 2026-10-30. Nothing here has been run on Azure. The SQL in `deploy/azure/sql/create-lobby-db.sql` was
tested on PostgreSQL 16.15. The api's migrations were also tested on that version (see
[What is already known about dbcpsql](#what-is-already-known-about-dbcpsql)). Everything else is a plan, and where it
depends on Azure behaviour nobody has tried yet, it says **UNVERIFIED**.

---

## How to start the agent

Clone the repository, then open Claude Code in it. On Windows, use Git Bash (see [Windows notes](#windows-notes)). Then
paste:

> Read `AGENTS.md`, `docs/GO-LIVE-AZURE.md` and `docs/AZURE-INSTALL-AGENT.md`. Follow `docs/AZURE-INSTALL-AGENT.md`
> phase by phase. Start with phase 0 and stop at every gate until I answer yes in chat.

The person needs, before starting:

- the Azure CLI, signed in (`az login`) as someone who may create resources in the chosen subscription;
- an SSH key pair, whose public key goes onto the VMs;
- for phase D: the dbcpsql admin login, or a DBC colleague who has it;
- for phase G: whoever manages darkburn.com's DNS.

---

## 0. Rules for the agent

These come on top of `AGENTS.md`, which still applies in full.

1. **Gates.** Anything that creates, changes or deletes an Azure resource, costs money, changes DNS, or runs on dbcpsql
   is a gate. At a gate:
   - show the exact commands, what they create, and what they cost a month;
   - wait for the person to answer yes in chat, for that gate only.

   A permission prompt in the terminal is not that yes, and a yes does not carry over to the next gate. `AGENTS.md` says
   "do not provision paid resources": a yes at a gate is the only authorization, and at gate 0 the person confirms that
   the owner and DBC IT approved this install.
2. **Read-only commands need no gate.** `show`, `list`, `metrics` and `list-usage` are fine, but only:
   - in the subscription confirmed at gate 0;
   - on the Lobby resource group, on dbcpsql (`show`, `db list`, `parameter show`, metrics), and on the network that
     dbcpsql sits in.

   Do not read other applications' Key Vaults, app settings, connection strings or databases.
3. **dbcpsql is shared by five other applications** (`videoquiz`, `darkshot`, `dbcdraw`, `newsletter_settings`,
   `dbc_ops`). Never run `parameter set`, `update`, `restart`, `stop` or a scale change on it, and never touch another
   database on it. Those decisions belong to DBC IT. The only change to it is phase D, which a person runs.
4. **Secrets never pass through the agent.** Never print a secret, put one in a command-line argument, or put one in chat,
   git, VM custom data, cloud-init, an `az vm run-command` script or this run's log.
   - Generate each one on the machine that stores it (`openssl rand -hex 32 | tr -d '\n'` into a file created with
     `umask 077`).
   - Store it with `az keyvault secret set --file`, and delete the temporary file.
   - On the VMs, a script reads Key Vault with the VM's own identity and writes mode-600 env files. Only that script
     ever holds the values.
5. **Delete only what this run created**, and only after the person types the resource's name in chat. Never run
   `az group delete` on a group this run did not create.
6. **Keep a log.** Write every mutating command (with no secret values), its result and each gate's answer to
   `.data/azure-install/log.md`. `.data/` is gitignored, and the log names subscription and resource ids, so it stays
   off git.
7. **Stop and report, rather than work around**, when:
   - an `az` command fails for a reason other than the agent's own typo;
   - the person lacks a permission;
   - a quota is short;
   - dbcpsql's metrics fail the check in phase A;
   - anything here does not match what Azure shows.
8. **Keep the design.**
   - Exactly one api and one sync.
   - Board files only on the managed data disk, never on Azure Files or any share.
   - No Front Door, Application Gateway, Container Apps or AKS.
   - No access log that records query strings (board tickets travel in `/connect?…`).
   - The page's CSP stays without `unsafe-eval`.
   - `/internal/*`, `/healthz*` and `/api/worker/*` are never published on the public hostname.
9. **Repository changes go through a branch and a pull request**, with the repo's checks run. The VMs only ever run a
   commit that has been reviewed and merged ("do not publish an unreviewed deployment").

---

## What is already known about dbcpsql

From the person's portal screenshots (2026-10-30):

- **Server:** Azure Database for PostgreSQL Flexible Server, PostgreSQL **16**, private access (VNet).
- **Size:** Burstable **B1ms** (1 vCore, 2 GiB, 640 IOPS at most), 64 GiB Premium SSD, performance tier P10 (500 IOPS).
- **Databases:** five applications' databases already, all UTF8 / `en_US.utf8`.

Microsoft's documentation, as quoted by search results (learn.microsoft.com could not be opened from the session that
wrote this, so re-read the pages before relying on them):

- B1ms allows 50 connections, 15 of them reserved, so **35 for all applications together**.
- Burstable servers have **no built-in PgBouncer**.
- Burstable runs on CPU credits. When they run out the server is throttled, and Microsoft warns it may become unreachable.
- High availability is not offered on Burstable.

Sources: [limits](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-limits),
[compute](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute).

**Lobby on PostgreSQL 16** (tested 2026-10-30 against a local PostgreSQL 16.15, as a non-superuser database owner, which
is how Azure works):

- All 39 migrations apply, in about 0.6 s.
- `deploy/azure/sql/create-lobby-db.sql` works when run by a non-superuser admin that has CREATEDB and CREATEROLE.
- The whole api test suite against PostgreSQL 16: see [`docs/PROGRESS.md`](PROGRESS.md), entry 2026-10-30.
- Not tested: restoring a PostgreSQL **18** dump (Render's) into 16. That only matters for the later data move;
  `docs/GO-LIVE-AZURE.md` §6 has the fallback.

**What Lobby asks of dbcpsql:**

- One database. Only the api connects; sync and the worker never do.
- At most 6 connections: `DRAFTROOM_DB_POOL_MAX=5` plus the health probe, with idle ones closed after 10 s. The role's
  `CONNECTION LIMIT 8` caps it whatever happens.
- Light queries. Board content is not in Postgres; it is in SQLite on the main VM's data disk.

---

## Phase 0: confirm the inputs (gate 0)

Ask the person for each of these, record the answers in the log, and do not go on until all are answered:

| Input | Proposed default |
|---|---|
| Owner's and DBC IT's approval for this rehearsal install, its resources and its cost | must be yes |
| Subscription | the one dbcpsql is in |
| Region | **dbcpsql's region** (no cross-region traffic or latency) |
| Resource group | new: `rg-lobby-rehearsal` |
| Hostname | `lobby-rehearsal.darkburn.com` |
| Sign-in for the rehearsal | **A: Clerk, as on staging** (see below), or **B: none yet** (infrastructure checks only) |
| How the VMs reach dbcpsql | see phase A: a new VNet peered to dbcpsql's, or new subnets in dbcpsql's VNet (DBC IT decides) |
| Who may SSH in, and from which public IP addresses | the person's current IP only |
| Who runs phase D (the SQL on dbcpsql) | a holder of dbcpsql's admin login |
| Who adds the DNS record, and does darkburn.com have a CAA record? | DBC IT |
| HTTPS certificate | Let's Encrypt through Caddy (ports 80/443 must then be open to the internet), or a DBC certificate |
| Where images are built | on the VMs from a `git archive` of the reviewed commit (no registry). An Azure Container Registry is for later, with CI. |
| AI features | off (no `OPENAI_API_KEY`) until `docs/GO-LIVE-AZURE.md` question 22 is answered |

**Sign-in option A (Clerk, as on staging)** needs no code. The api runs with `AUTH_PROVIDER=clerk`, the same Clerk keys as
staging and a CSP that names Clerk's hosts (copy them from `render.yaml`'s CSP, minus the `onrender.com` hosts). The
owner copies the keys into Key Vault; the agent never sees them.

**UNVERIFIED:** that staging's Clerk instance (a development instance) accepts sign-ins from a new hostname. Check it in
Clerk's dashboard before phase F. Accounts then match staging's Clerk users, which helps a later data move. This is a
rehearsal choice only: production sign-in is Okta and Microsoft (`docs/GO-LIVE-AZURE.md` §3).

---

## Phase A: discovery (read-only, no gate)

Run these, record the results in the log, and report a summary. Replace `<…>` with values from gate 0.

```bash
az account show -o table
az account set --subscription "<subscription>"

# dbcpsql itself: version, size, network, backups, maintenance window
az postgres flexible-server list --query "[?name=='dbcpsql'].{rg:resourceGroup,id:id}" -o table
az postgres flexible-server show -g <db-rg> -n dbcpsql \
  --query "{version:version,sku:sku,state:state,network:network,storage:storage,backup:backup,ha:highAvailability,maintenance:maintenanceWindow,auth:authConfig}"
az postgres flexible-server db list -g <db-rg> -s dbcpsql -o table
az postgres flexible-server parameter show -g <db-rg> -s dbcpsql -n max_connections --query value
```

From `network`:

- `delegatedSubnetResourceId` gives dbcpsql's VNet and subnet.
- `privateDnsZoneArmResourceId` gives the private DNS zone the VMs must resolve its name through.

Show both of those resources (`az network vnet show`, `az network private-dns zone show`) and note the VNet's address
space, so the new VNet does not overlap it.

**dbcpsql's load over the last 30 days.** List the metric names first (they are Azure's, not ours), then read the
maximum and minimum of each:

```bash
DB_ID=$(az postgres flexible-server show -g <db-rg> -n dbcpsql --query id -o tsv)
az monitor metrics list-definitions --resource "$DB_ID" --query "[].name.value" -o tsv
az monitor metrics list --resource "$DB_ID" --offset 30d --interval PT1H \
  --metric active_connections cpu_percent memory_percent storage_percent cpu_credits_remaining \
  --aggregation Maximum Minimum Average -o json > .data/azure-install/dbcpsql-metrics.json
```

Summarize the result as a table: the peak active connections, the lowest CPU credits remaining, the CPU and memory
percentages (average and peak) and the storage percentage. These thresholds are rules of thumb, not measurements of Lobby
on Azure:

- **Stop and report** if peak active connections + 8 exceeds 30, or CPU credits remaining ever came near 0.
- **Report as a risk, then continue** if CPU or memory sits high for long stretches.

The options to put to the person are:

- DBC IT moves dbcpsql to a larger size, which restarts it for all five applications;
- Lobby gets its own small Flexible Server: PostgreSQL 18, about $16 a month for B1ms with 32 GiB;
- go ahead and watch it.

**Capacity in the region:**

```bash
az vm list-skus --location <region> --size Standard_B2 --resource-type virtualMachines \
  --query "[?name=='Standard_B2s_v2' || name=='Standard_B2als_v2'].{name:name,restrictions:restrictions}" -o json
az vm list-usage --location <region> -o table   # the B-series v2 vCPU quota needs 4 free vCPUs
```

**Network choice (for gate 1).** The VMs must reach dbcpsql's private address and resolve its name through its private
DNS zone. There are two ways; DBC IT picks:

1. **A new VNet for Lobby, peered with dbcpsql's VNet** (recommended): Lobby's address space and NSGs stay its own. It
   needs peering in both directions (which needs rights on dbcpsql's VNet) and a link from dbcpsql's private DNS zone to
   the new VNet.
2. **Two new subnets inside dbcpsql's VNet**: simpler, but it changes DBC's existing network.

---

## Phase B: repository changes (no Azure; a branch and a pull request)

On a branch from `main` (for example `deploy/azure-rehearsal`), add `deploy/azure/`. The theater Lobby
(`deploy/nas/theater/`) is the closest working example of one origin; the NAS worker (`deploy/nas/worker/`) is the example
for the worker VM. Change what is listed and nothing else.

`deploy/azure/main/docker-compose.yml`: start from `deploy/nas/theater/docker-compose.yml`, then:

- **Remove** `db` (dbcpsql replaces it), `worker`, `office` (they go to the worker VM) and `tunnel`.
- **Add `caddy`**, pinned by version and digest:
  - it is the only service with published ports (`80:80`, `443:443`);
  - a named volume for `/data`, which holds the certificates;
  - it depends on `web`.
- **Bind-mount the data disk** in the long syntax, with `bind: create_host_path: false`:
  - sync: `/srv/lobby/rooms` → `/var/data`;
  - api: `/srv/lobby/files` → `/var/data`.

  If the disk is missing, the container then fails to start instead of starting on an empty folder (see phase E).
- **api environment.** Change these from the theater's:
  - `AUTH_PROVIDER=clerk` (option A); remove `DRAFTROOM_OPEN_SIGNIN*`, `DRAFTROOM_SHARED_WORKSPACE_NAME`,
    `DRAFTROOM_GOOGLE_CLIENT_ID` and the partner token;
  - `TRUST_PROXY=2` (Caddy and nginx). **UNVERIFIED** until the "Client IPs" test in `docs/DEPLOY.md` passes;
  - `DRAFTROOM_DB_POOL_MAX=5`, `DRAFTROOM_BLOB_STORE=fs` and `DRAFTROOM_WORKSPACE_QUOTA_MB=5120`;
  - no `OPENAI_*`.

  The secret ones come from env files that phase E writes (`/etc/lobby/shared.env` and `/etc/lobby/api.env`):
  `DATABASE_URL`, `DRAFTROOM_WORKER_TOKEN`, `DRAFTROOM_WEBHOOK_SECRET` and `CLERK_*`.
- **api's port for the worker VM.** Publish the api's port on the main VM's private address only:
  `"<main-private-ip>:5859:5859"`.
- **sync environment.** As the theater's, plus:
  - `DRAFTROOM_OUTBOUND_BUDGET_MB=64` and `DRAFTROOM_BACKUP_KEEP=4`;
  - `DRAFTROOM_BACKUP_STORE=fs`, with `DRAFTROOM_BACKUP_SIGNING_SECRET` in `/etc/lobby/sync.env`.

  These backups are **on the same disk**: acceptable for an empty rehearsal, never for production, which needs offsite
  copies (`docs/GO-LIVE-AZURE.md` §2).
- **Feature switches:** the same values as `render.yaml`, which the theater compose already mirrors.

`deploy/azure/main/Caddyfile`, roughly:

```
{
	email <ops mailbox>
}
<hostname> {
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy web:8080 {
		flush_interval -1
		stream_close_delay 5m
	}
}
```

No `log` directive: Caddy then writes no access log. No `encode`: the api sends `no-transform` for the event stream.

**`deploy/azure/nginx.conf`** is a copy of `deploy/nas/theater/nginx.conf` with three changes:

1. The CSP names Clerk's hosts instead of Google's, for option A. Copy them from `render.yaml`.
2. `connect-src` adds `wss://<hostname>`.
3. A new `location /api/worker/ { return 404; }`, because the worker reaches the api on the private network.

`docker/web.Dockerfile` then takes the config as a build argument whose default stays the theater's file (for example
`ARG NGINX_CONF=deploy/nas/theater/nginx.conf`), so the theater's build does not change. Put the hostname into the CSP at
build time (a build argument and a `sed` in the nginx stage, before `USER nginx`).

`deploy/azure/worker/docker-compose.yml`: start from `deploy/nas/worker/docker-compose.yml` and change only:

- the worker's `cpus: 3` to `2`, and the sidecar's `cpus: 2` to `1`, because Docker refuses a limit above the VM's CPUs;
- the models folder to `/opt/lobby/models:ro`;
- the env file to `/etc/lobby/worker.env`, containing only `DRAFTROOM_API_URL=http://<main-private-ip>:5859`,
  `DRAFTROOM_WORKER_TOKEN` and `WORKER_ID=azure-rehearsal-1`.

`deploy/azure/cloud-init.yaml` contains **no secrets**. It installs Docker Engine with the compose plugin from Docker's
apt repository, the Azure CLI and `postgresql-client-16`. It turns on unattended security upgrades, and turns off
password SSH.

`deploy/azure/bin/fetch-secrets.sh` runs on each VM:

1. `az login --identity`.
2. Read the named secrets from Key Vault with `az keyvault secret show --query value -o tsv`.
3. Write `/etc/lobby/*.env`: owned by root, mode 600, written atomically.

It prints names only, never values. On the worker VM, it refuses any name other than the worker's three (as
`deploy/nas/deploy-worker.sh` does).

`deploy/azure/systemd/lobby.service` is a oneshot unit with `RequiresMountsFor=/srv/lobby` and
`ConditionPathIsMountPoint=/srv/lobby`. It runs `docker compose up -d` in `/opt/lobby/main`.

`deploy/azure/README.md` (the `docs/DEPLOY-AZURE.md` of `docs/GO-LIVE-AZURE.md` §5): how to deploy an update, restart,
read logs, and roll back to the previous commit. Model it on the theater's README.

**Checks before the pull request:**

- `docker compose -f … config` for both compose files;
- the web image built with the Azure config;
- inside that image, `nginx -t`;
- optionally, a local run of the main stack against a local PostgreSQL 16 with `AUTH_PROVIDER=dev`, which needs
  `DRAFTROOM_DEV_AUTH=1` and `NODE_ENV` other than production. A local smoke test only; never use those values on Azure;
- `pnpm lint`.

Record what ran and what did not. The pull request is reviewed and merged before phase F uses it.

---

## Phase C: provision (gates 1 to 3)

Tag every resource `app=lobby env=rehearsal createdBy=<person>`. Prices are the East US 2 list prices read on 2026-10-19
(`docs/GO-LIVE-AZURE.md` "Rough monthly cost"); check them for dbcpsql's region before gate 1.

**Gate 1, the plan.** Present this table, filled in, with the network choice from phase A:

| Resource | Size | About a month |
|---|---|---|
| main VM `vm-lobby-main` | Standard_B2s_v2, Ubuntu 24.04 LTS, 64 GiB Premium SSD OS disk | $60.74 + $9.28 |
| data disk `disk-lobby-data` | 64 GiB Premium SSD (P6), host caching None | $9.28 |
| static public IP `pip-lobby-main` | Standard | $3.65 |
| worker VM `vm-lobby-worker` | Standard_B2als_v2, Ubuntu 24.04 LTS, 32 GiB Standard SSD OS disk | $27.45 + $2.40 |
| outbound public IP `pip-lobby-worker` (no inbound rule) | Standard | $3.65 |
| Key Vault `kv-lobby-<suffix>` | standard, RBAC | about $0–1 |
| VNet, subnets, NSGs, peering | — | peering traffic only, small |
| **Total** | | **about $117–120**, plus disk snapshots later. dbcpsql's cost does not change. |

**Gate 2, the network.** Create in this order:

- the resource group;
- the VNet with `snet-main` and `snet-worker`, in an address range that does not overlap dbcpsql's VNet;
- the NSGs:
  - `nsg-lobby-main`: 443 and 80 from `Internet` (or from DBC's ranges, if the certificate is not from Let's Encrypt),
    22 from the person's IP only, and 5859 from `snet-worker` only;
  - `nsg-lobby-worker`: 22 from `snet-main` only, nothing else inbound;
- peering in both directions, and the private DNS zone link (this step changes DBC's network: DBC IT's yes);
- the two public IPs.

Then check from the person's machine that the zone link exists:
`az network private-dns link vnet list -g <zone-rg> -z <zone> -o table`.

**Gate 3, the VMs and Key Vault.**

```bash
az vm create -g rg-lobby-rehearsal -n vm-lobby-main --image Ubuntu2404 --size Standard_B2s_v2 \
  --admin-username lobbyadmin --ssh-key-values <public-key-file> --authentication-type ssh \
  --vnet-name vnet-lobby --subnet snet-main --nsg "" --public-ip-address pip-lobby-main \
  --os-disk-size-gb 64 --storage-sku Premium_LRS \
  --data-disk-sizes-gb 64 --data-disk-caching None \
  --assign-identity --custom-data deploy/azure/cloud-init.yaml \
  --tags app=lobby env=rehearsal createdBy=<person>
```

- The worker VM is the same, except:
  - `-n vm-lobby-worker`, `--size Standard_B2als_v2` and `--subnet snet-worker`;
  - `--public-ip-address pip-lobby-worker`;
  - `--os-disk-size-gb 32 --storage-sku StandardSSD_LRS`, and no data disk.

  `--nsg ""` because the NSGs are on the subnets.
- Before running these, check each flag against `az vm create --help` on the person's CLI version.
- Key Vault: `az keyvault create -g rg-lobby-rehearsal -n kv-lobby-<suffix> --enable-rbac-authorization true`.
- Roles:
  - the person gets "Key Vault Secrets Officer";
  - the main VM's identity gets "Key Vault Secrets User";
  - the worker VM's identity gets "Key Vault Secrets User" on `lobby-worker-token` only (scope
    `<vault-id>/secrets/lobby-worker-token`): its other two values are not secret.

**Secrets.** The person creates them (rule 4), never the agent's output. All are new values, at least 32 characters, all
different from each other (the api and sync check this at start-up):

| Name in Key Vault | Variable |
|---|---|
| `lobby-ticket-secret` | `DRAFTROOM_TICKET_SECRET` |
| `lobby-internal-secret` | `DRAFTROOM_INTERNAL_SECRET` |
| `lobby-worker-token` | `DRAFTROOM_WORKER_TOKEN` |
| `lobby-webhook-secret` | `DRAFTROOM_WEBHOOK_SECRET` |
| `lobby-backup-signing-secret` | `DRAFTROOM_BACKUP_SIGNING_SECRET` |
| `lobby-db-password` | the `lobby` role's password; letters and digits only, so the `DATABASE_URL` needs no escaping |
| `lobby-clerk-secret-key`, `lobby-clerk-publishable-key` | option A only: copied from staging by the owner |

Never reuse staging's or the theater's values here.

---

## Phase D: the `lobby` database on dbcpsql (gate 4, run by a person)

Only the main VM can reach dbcpsql, so this runs there, over SSH, typed by the dbcpsql admin. First copy
`deploy/azure/sql/create-lobby-db.sql` to the VM (`scp`). cloud-init has already installed `psql` and `az`:

```bash
az login --identity
export LOBBY_DB_PASSWORD="$(az keyvault secret show --vault-name kv-lobby-<suffix> -n lobby-db-password --query value -o tsv)"
psql "host=dbcpsql.postgres.database.azure.com port=5432 dbname=postgres user=<admin> sslmode=verify-full sslrootcert=system" \
  -f create-lobby-db.sql
unset LOBBY_DB_PASSWORD
```

- The admin types their own password at psql's prompt.
- The script creates the role `lobby` (no superuser, `CONNECTION LIMIT 8`) and the database `lobby` (UTF8, owned by
  `lobby`), and removes everyone else's right to connect to it.
- It prints the result. Check it: encoding UTF8, owner `lobby`, `rolsuper` false.
- `sslrootcert=system` needs psql 16 or newer. If psql refuses Azure's certificate chain, see `docs/GO-LIVE-AZURE.md` §5
  (`DATABASE_URL`) for the two root certificates.

The api's `DATABASE_URL` is then
`postgres://lobby:<password>@dbcpsql.postgres.database.azure.com:5432/lobby?sslmode=verify-full`. `fetch-secrets.sh`
assembles it on the VM.

**UNVERIFIED** until the first start: that Node's built-in roots accept Azure's chain. If not, use `NODE_EXTRA_CA_CERTS`,
as in `docs/GO-LIVE-AZURE.md` §5.

---

## Phase E: prepare the VMs (gate 5)

Run over SSH: to the main VM directly, and to the worker VM through the main VM (`ssh -J`).

**The data disk (main VM).** This formats a disk: show `lsblk` and `ls -l /dev/disk/azure/scsi1/` first, and wait for the
person to confirm the device.

1. Find the disk: the 64 GiB disk at LUN 0, normally `/dev/disk/azure/scsi1/lun0`. Check that it has no partitions and
   no filesystem.
2. Prepare the mount point: `mkdir -p /srv/lobby && chattr +i /srv/lobby`. The empty mount point can then never receive
   files.
3. Format and mount:
   - `mkfs.ext4 -L lobbydata <device>`;
   - an `/etc/fstab` line by UUID: `UUID=<uuid> /srv/lobby ext4 defaults,nofail 0 2`;
   - `mount /srv/lobby`, then `mkdir /srv/lobby/rooms /srv/lobby/files`.
4. Install `lobby.service`.

**Secrets onto the VMs.** Run `fetch-secrets.sh` on each VM, then check that `/etc/lobby/*.env` exist with mode 600. Check
names only, with `cut -d= -f1`.

**The model file (worker VM, by the person).**

- Copy `u2netp.onnx` from the NAS (`draftroom-worker/models/u2netp.onnx`) to `/opt/lobby/models/u2netp.onnx`.
- Check its sha256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` (pinned in
  `apps/worker/src/ops/bg-model.ts`).
- Lobby never downloads it (`AGENTS.md`, wave W). Without it, the worker simply does not offer background removal.

---

## Phase F: build and start (gate 6)

1. From the merged commit:
   - `git archive --format=tar <commit> | ssh … 'tar -x -C /opt/lobby/src'` to each VM;
   - copy `deploy/azure/main/*` to `/opt/lobby/main` and `deploy/azure/worker/*` to `/opt/lobby/worker`.

   The compose files' build context is `/opt/lobby/src`. Set `GIT_COMMIT` and the hostname as build arguments.
2. Build the images on the VMs, one at a time: `docker compose build api`, then `sync`, then `web` on the main VM, and
   `docker compose build` on the worker VM. The worker image is about 1.3 GB, and the slowest.
3. Start in this order:
   1. api. On first start it creates the 39 migrations' tables on dbcpsql. Check its log for the migration list and for
      no TLS error.
   2. sync.
   3. web.
   4. caddy. It requests the certificate once DNS points at the VM (phase G).
   5. The worker VM's stack.

---

## Phase G: DNS and HTTPS (gate 7, by DBC IT)

1. DBC IT adds an `A` record for the hostname, pointing at `pip-lobby-main`'s address. If darkburn.com has a CAA record,
   it must allow `letsencrypt.org`, or DBC supplies a certificate instead.
2. Port 80 or 443 must be reachable from the internet while Let's Encrypt validates.
3. Caddy's log shows the certificate obtained. Check it from outside:
   `curl -sI https://<hostname>/version.json` shows the commit and `Cache-Control: no-store`.

---

## Phase H: acceptance checks (no gate; report each result)

Run each check and record pass, fail or not run. Never mark one passed that did not run.

| Check | How | Pass when |
|---|---|---|
| The build is the reviewed one | `GET /version.json` | the merged commit |
| Headers | `curl -sI https://<hostname>/` | the CSP, without `unsafe-eval`, naming `wss://<hostname>`; HSTS; `X-Content-Type-Options` |
| Hard 404s | `/excalidraw-assets/nope.woff2`, `/lobby-assets/nope.svg` | 404, not `index.html` |
| Nothing private published | `/api/worker/claim` (GET and POST) | 404 |
| Health on the inside | `docker compose exec api node -e "fetch('http://127.0.0.1:5859/healthz/deep').then(async r=>console.log(r.status, await r.text()))"`, and the same for sync on 5858 | 200; sync reports its disk and backups healthy |
| The database | as `lobby`: `SELECT count(*) FROM schema_migrations` and the connection count in `pg_stat_activity` for that user | 39; at most 6 |
| The event stream is not buffered | `curl -N https://<hostname>/api/diag/stream` (no sign-in needed; also `scripts/smoke/live-smoke.mjs` check 5b) | the three `tick` lines arrive about one second apart, not all together after 3 s |
| Sign-in (option A) | sign in through Clerk in a browser | the dashboard opens, and no CSP error in the console |
| Live board | two browsers on one board; edit, move, comment, vote | each sees the other within a second |
| Long session | leave both on the board for 30 minutes | still live, without a reload |
| Sync restart | `docker compose restart sync` with both on the board | both reconnect by themselves, and nothing is lost |
| Worker | upload a PDF, a PPTX and a photo | previews appear; `GET /api/auth/config` shows the `formats` values true within minutes; the worker log names `remove-bg:u2netp@1, extract-text@1, render-pages@1` |
| Reboot | `sudo reboot` the main VM | the disk mounts, the stack starts, and the boards are intact |
| Missing disk | **only with the person's yes**: stop the stack, comment out the fstab line, reboot | sync does **not** start, and nothing appears under `/srv/lobby`; then undo and reboot |
| Client IPs | `docs/DEPLOY.md` "Client IPs" | `TRUST_PROXY=2` is right |

Then summarize for the person:

- what passed, what failed, and what did not run;
- the resources created, with their ids;
- what remains on the way to production:
  - sign-in (Okta and Microsoft);
  - file storage and offsite backups (the Blob driver, or a DBC-owned R2);
  - the data move, and whether the PostgreSQL 18 → 16 restore works;
  - monitoring and alerts;
  - snapshots of the data disk;
  - the production hostname.

Record the outcome in `docs/PROGRESS.md` through a pull request, with no ids, IP addresses or secrets.

---

## Windows notes

- Git Bash rewrites arguments that start with `/` into Windows paths, which breaks Azure resource ids
  (`/subscriptions/…`). Prefix such commands with `MSYS_NO_PATHCONV=1`.
- If `node` or `pnpm` are missing from Git Bash's PATH, use the prefix in `AGENTS.md` "Local environment".
- `az` writes `\r\n` line endings in `-o tsv` output on Windows. Strip them (`tr -d '\r'`) before using a value in another
  command.

---

## Undo

Everything this run creates is in `rg-lobby-rehearsal`, except:

- the peering on dbcpsql's VNet side;
- the private DNS zone link;
- the `lobby` database and role on dbcpsql;
- the DNS record.

To remove the rehearsal, each with its own gate:

1. Delete the DNS record (DBC IT).
2. Drop the database and the role on dbcpsql (`DROP DATABASE lobby; DROP ROLE lobby;`, by the admin, after the person
   confirms nothing in it is needed).
3. Remove the peering and the zone link.
4. Delete the resource group (the person types its name).

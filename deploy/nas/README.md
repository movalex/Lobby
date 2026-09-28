# Draftroom preview worker on the NAS

The preview worker makes thumbnails, PDF page images, video posters and (wave 4) the page previews of Office documents. Since milestone 3 it is only an HTTP client of the Draftroom api (`/api/worker/*`, see `docs/M3-STORAGE-CONTRACTS.md` §4–§5). It downloads each original, processes it, uploads the previews and reports back. It needs **no** database, **no** storage credentials, **no** open port and **no** disk of its own. That makes the NAS a good place for extra processing capacity next to the Render api.

Office documents (DOCX, PPTX, XLSX, ODT, ODP, ODS) are converted to PDF by LibreOffice in a second container of the same image, the **office sidecar**, which has no network and no secrets. See [Office previews](#office-previews-wave-4).

Status: **deployed as `nas-1` for staging (2026-09-28, the milestone-3 image, see docs/PROGRESS.md); the Office sidecar is written and proven with throwaway containers but not deployed yet** ([Office previews](#office-previews-wave-4)). Before the deploy, the image was built on the NAS and the worker ran from this compose file against a throwaway api that stored files in the real R2 bucket; see [NAS proof](#nas-proof-2026-09-27) for what was checked.

## What runs where

| Where | What |
|---|---|
| PC (Git Bash) | `deploy/nas/deploy-worker.sh`: bundles the needed repository files, uploads them over ssh and drives Docker on the NAS. |
| NAS `/volume3/Apps/draftroom-worker/` (mode 700: only your NAS account) | `docker-compose.yml` (copied from `deploy/nas/worker/`), `worker.env` (mode 600, your token), `src/` (the uploaded sources the image is built from). |
| NAS Docker | Compose project `draftroom-worker`, one image, two containers. `draftroom-worker`: 1.5 GB memory cap (no swap), 3 CPUs, 256 processes. `draftroom-office` (the office sidecar): **no network** (`network_mode: none`), no env file, read-only root filesystem with a 256 MB `/tmp`, 1 GB memory cap (no swap), 2 CPUs, 128 processes. Both: all capabilities dropped, `no-new-privileges`, the unprivileged `node` user, restart unless stopped, logs capped at 3 × 10 MB. They share only the scratch volume `office-jobs` (a staged document, its PDF and the Unix socket between them). |

The script and the compose file only ever name the `draftroom-worker` project and its own folder. They never list, stop, rebuild or prune anything else on the NAS, including the `theaitre` project. The only cleanup is the worker's own superseded image (dangling images labelled `com.draftroom.component=worker`).

## One-time setup

1. **Get the worker token.** It is the `DRAFTROOM_WORKER_TOKEN` of the api you want the NAS to work for (on Render: Dashboard → Environment Groups → `draftroom-staging-worker-token`, see `docs/DEPLOY.md` "Worker token"). The worker and the api must have the same value. It must be at least 32 characters and not the `dev-only-…` placeholder.
2. **Create the env file on the PC** at `deploy/nas/worker/.env.worker`. The repository ignores this name (`.env.*`); never commit it. It holds exactly three lines:

   ```
   DRAFTROOM_API_URL=https://<your api host>
   DRAFTROOM_WORKER_TOKEN=<the token from step 1>
   WORKER_ID=nas-1
   ```

   `DRAFTROOM_API_URL` is the api's origin only: no path, no trailing `/api`, no quotes. Plain `http://` is accepted only for an api on the local network. The script refuses any other variable, so storage keys and database URLs can never end up on the NAS by accident.
3. Check it without uploading anything: `bash deploy/nas/deploy-worker.sh check-env` (prints only "ok" or which rule failed, never a value).

## Deploy / update

```bash
bash deploy/nas/deploy-worker.sh          # same as: bash deploy/nas/deploy-worker.sh deploy
```

The script:

1. validates the env file;
2. bundles the repository subset the image needs (every workspace `package.json`, the lockfile, `docker/worker.Dockerfile`, `packages/`, `apps/worker/`). Tests, fixtures, `dev.env`, `.env*` files and `node_modules` are left out, and it aborts if the token appears anywhere in the bundle;
3. uploads the bundle, the compose file and the env file (mode 600, Windows line endings stripped);
4. builds the image on the NAS. The running worker keeps working meanwhile. If the build fails, the previous sources are restored and the container is left alone;
5. swaps the containers (the worker and the office sidecar). The old worker gets SIGTERM, finishes or hands back its current job (up to 10 s), and the new one starts;
6. waits for `[office] listening` and `[worker] started (api: …)` and prints the status.

The first build downloads the Node base image, ffmpeg, LibreOffice and its fonts, and the worker's dependencies (sharp, PDF renderer). Without LibreOffice it took 65 s with an empty cache and made a 776 MB image; with LibreOffice the image is 1.19 GB (measured 2026-09-28, see [Office previews](#office-previews-wave-4)). Later builds reuse Docker's cache.

After the first deploy you can leave out the local env file. The script then keeps the `worker.env` that is already on the NAS.

## Day to day

```bash
bash deploy/nas/deploy-worker.sh status     # both containers: state, restarts, OOM flag, CPU/memory, last 20 log lines
bash deploy/nas/deploy-worker.sh logs       # worker: last 100 log lines (logs 500, or logs -f to follow)
bash deploy/nas/deploy-worker.sh logs 100 office   # the office sidecar's (logs -f office to follow)
bash deploy/nas/deploy-worker.sh stop       # graceful stop; stays stopped (also across NAS reboots)
bash deploy/nas/deploy-worker.sh start      # start it again without rebuilding
```

Healthy logs look like this. The worker logs version ids, never file names, tokens or download URLs.

```
[worker] started (api: https://<your api host>, poll 2000 ms)
[worker] id nas-1, concurrency 1, pdf heap 384 MB
[worker] ver_… claimed (pdf, attempt 1)
[worker] ver_… pdf derived in 449 ms (5 derivatives)
[worker] ver_… pdf ready: 5 derivatives in 2643 ms
```

| Log line | Meaning / what to do |
|---|---|
| `claim refused (HTTP 401 …): check DRAFTROOM_WORKER_TOKEN` | The token differs from the api's. Fix `.env.worker` and deploy again. |
| `claim failed (network …)` | The api is unreachable (NAS offline, wrong URL, api asleep). The worker backs off to one poll every 15 s and logs `api reachable again` when it recovers. |
| `… lease lost …; abandoning it` | The api gave the job to someone else (or could not be reached for a whole lease period). Nothing is written for that job; it is processed again. |
| `SIGTERM: stopping, finishing ver_… (up to 10000 ms)` then `… handed back to the api (worker shutting down)` | Normal on `stop` and on every deploy when a job takes longer than the grace period. The api requeues the job at once without counting an attempt, and the next worker starts it again. |
| `refusing to start: …` | A configuration rule failed; the message names the variable. |
| `[worker] office previews: LibreOffice sidecar (no network, no secrets)` | Office documents go to the sidecar. `off` there means they fail with "not available right now" and stay downloadable. |
| `[office] LibreOffice 25.2.3.2 …` then `[office] listening (…, network: none)` | The sidecar is up. `[office] docx converted in 523 ms` per document. |
| `[office] refusing to start: the office sidecar must hold no secrets …` / `… must run without network …` | Its environment or network changed: it checks both itself and will not run with a token or a network interface. |
| `… attempt N will be retried: office sidecar unreachable (ECONNREFUSED)` | The sidecar was (re)starting. The job is retried; nothing to do unless it repeats. |

## Settings

The env file holds only the three variables above. The compose file sets the non-secret tuning (edit `deploy/nas/worker/docker-compose.yml` and deploy again):

| Variable | Default | Notes |
|---|---|---|
| `WORKER_CONCURRENCY` | `1` | Jobs at once. The 1.5 GB memory cap is sized for 1. Raise it together with `mem_limit`. |
| `WORKER_PDF_HEAP_MB` | `384` | V8 heap of the PDF renderer child. |
| `WORKER_POLL_MS` / `WORKER_POLL_MAX_MS` | `2000` / `15000` | Idle polling: doubles with jitter up to the max, and resets when work arrives. |
| `WORKER_SHUTDOWN_GRACE_MS` | `10000` | How long a stopping worker may finish its job before handing it back. It must stay below `stop_grace_period` (30 s). |
| `OFFICE_SOCKET` / `OFFICE_JOBS_DIR` | `/office-jobs/office.sock` / `/office-jobs` | Set on both containers: where the worker stages documents and reaches the sidecar. Without them (and in production) Office previews are off. |
| `WORKER_OFFICE_TIMEOUT_MS` | `120000` | LibreOffice's budget per document (the page render after it has its own 90 s). |
| `OFFICE_MAX_TIMEOUT_MS` / `OFFICE_MAX_QUEUE` | `120000` / `4` | Sidecar: the most any request may ask for, and how many conversions may wait behind the running one (then `BUSY`, retried by the worker). |

## Removing it

```bash
bash deploy/nas/deploy-worker.sh stop
ssh -i ~/.ssh/ugreen_nas chase@192.168.10.1 \
  'docker compose -p draftroom-worker -f /volume3/Apps/draftroom-worker/docker-compose.yml down -v --rmi all'
ssh -i ~/.ssh/ugreen_nas chase@192.168.10.1 'rm -rf /volume3/Apps/draftroom-worker'
```

Both commands name only the `draftroom-worker` project and folder (`-v` removes the project's own scratch volume, `draftroom-worker_office-jobs`).

## Security notes

- The worker token lets its holder read the originals of queued uploads and write their previews, nothing else (`docs/M3-STORAGE-CONTRACTS.md` §7). To rotate it, change it on the api, update `.env.worker` and deploy again.
- The token is sent only to the api origin. Object-storage downloads and uploads use short-lived presigned URLs, which never see the token and are never logged.
- The PDF renderer, ffprobe and ffmpeg run as child processes with a minimal environment (no token), hard timeouts and size/page/pixel/duration limits.
- LibreOffice runs only in the office sidecar: no network interface but loopback, no token or credential anywhere in its environment (the worker's token is in `worker.env`, which only the worker container reads), a read-only root filesystem, no capabilities. A document that exploits LibreOffice can read the image's public files and the documents staged for conversion, and cannot send anything anywhere. The sidecar refuses to start with a secret in its environment or with a network interface (checked from inside).
- The script makes the NAS folder owner-only (`chmod 700`) on every deploy. New folders under `/volume3/Apps` get the share's world-writable ACL (`drwxrwxrwx+`). Without the chmod, any NAS account could edit `docker-compose.yml` or the sources in `src/`, and Docker runs what they say as root.
- `docker compose … config` prints the values from `worker.env`, including the token. Don't paste its output into chat, tickets or logs. The script never runs it.

## NAS proof (2026-09-27)

What was run: the real images and this compose file on the NAS (Docker 29.6.2, Compose v5.1.3, 12 CPUs, 7.6 GB RAM), all with throwaway names (`draftroom-m3proof-*`). Nothing called `draftroom-worker` was created, and the `theaitre` project was not touched.

- **Setup:**
  - Images: built with a separate buildx builder capped at 2 GB. The api image took 19 s (302 MB), sync 5 s (252 MB) and the worker 65 s (776 MB). The worker was built from the exact bundle `deploy-worker.sh bundle` makes, with `docker buildx bake` reading this compose file.
  - Other containers: PostgreSQL 18.6, and the api (`DATABASE_URL`, `DRAFTROOM_BLOB_STORE=r2` on the real bucket, dev sign-in for the test). The api was capped like Render's plan: 512 MB, 0.5 CPU.
  - Network: all of them on a private Docker network.
  - Worker: started with `docker compose up -d --no-build`, using this compose file plus an override that changed only the names and the network.
- **Container settings, as Docker reported them:** user `node`, `init`, `cap_drop: ALL`, `no-new-privileges`, 1.5 GB memory with no swap, 3 CPUs, 256 pids, `unless-stopped`, no ports, no mounts, json-file 3 × 10 MB.
- **Previews:** a PNG (2 derivatives), a 4-page PDF (5) and an MP4 (h264/aac, 5000 ms; 2) became ready. Through the api, originals were byte-identical, and every Range case, the `416` and every derivative (`nosniff`, immutable cache) were correct. So were the Origin and worker-token refusals (60 of 60 client checks). The worker also refused to start with a public `http://` api URL or the `dev-only-…` token, named a stray `DATABASE_URL` as unused, and logged `claim refused (HTTP 401 …)` with a wrong token.
- **Crash:** the worker's process was killed with SIGKILL while it rendered a slow 8-page PDF. Docker restarted the container at once. The job stayed leased and was reclaimed as attempt 2 about 3 s after the 120 s lease expired, then became ready.
- **`stop` and redeploy while a job ran:** the worker handed the job back after its 10 s grace (`compose stop` took 10.8 s and exited 0). The api requeued the job without counting an attempt, and after `start` or the container swap the new worker finished it. After a rebuild, the label-filtered prune removed the superseded image.
- **Two workers at once:** 12 uploads were split 5/7 between two workers. No job was claimed twice and none got a `409`. `apps/api/test/worker/skip-locked.pg.test.ts` passed three times against this Postgres, and failed once `SKIP LOCKED` was removed from the claim query.
- **Memory:**
  - api: RSS was 146 MiB idle and at most +8.6 MiB while a 200 MiB file streamed in (20 s) and back out (4.7 s). The cgroup peak was 189 of 512 MiB, with no OOM.
  - worker: its cgroup peaked at 642 of 1500 MiB during the slow PDF.
- **Leftovers:**
  - R2: the bucket afterwards held exactly the keys the database listed, and no blob from the crashed or handed-back attempts.
  - Logs: no credential, token, file name or presigned URL in any container log.
- **Cleanup:** every proof object was deleted from R2 and the bucket listed empty. The proof's containers, images, network, builder (with its cache) and folder were removed. `docker ps -a`, `images`, `volume ls`, `network ls` and `system df` matched the state before the proof.
- **Not proven here:** the NAS reaching the real Render api over the internet. The api here was on the same Docker network over plain http.

## Office previews (wave 4)

**Not deployed.** The running `draftroom-worker` still has the milestone-3 image. The integration step deploys this with `bash deploy/nas/deploy-worker.sh` (one build, both containers).

How it works:

- An upload named `.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp` or `.ods` (or declared with one of their types) is kind `pdf`, with a 100 MB limit. The original is always served as a download, never inline.
- The worker decides by content (`apps/worker/src/office.ts`):
  - a truncated package, a zip bomb (more than 1 GiB declared uncompressed, more than 10,000 entries, or an entry that inflates past its declared size), a password-protected document (OOXML in an MS-CFB container, or ODF with encryption data in its manifest) and a macro-enabled package under an Office name (by its content types or a VBA/macro-sheet part, read from the central directory as LibreOffice reads it) are all refused **before** LibreOffice sees them;
  - everything else is staged in the shared `office-jobs` volume and converted by the sidecar (`office-sidecar.ts`, `soffice.ts`):
    - a fresh LibreOffice profile per job, with macros disabled and linked files from untrusted documents blocked;
    - the import filter forced to the sniffed format;
    - a minimal environment;
    - a 120 s timeout that kills the whole process tree, and the same kill as soon as the PDF being written passes 100 MB.
  - Staging directories a killed worker left in the volume (it outlives both containers) are removed when the worker next starts, once they are an hour old.
- The PDF then goes through the existing PDF pipeline (pages, cover, 2,000-page cap). The card says "Preview made from a PDF conversion".

### Office previews: evidence from the NAS (2026-09-28)

Run on the NAS with throwaway names only (`draftroom-office-test*`: one image, containers, one volume, a compose project and a folder). The running `draftroom-worker` and the `theaitre` project were not touched, and nothing was pruned. The script is `apps/worker/scripts/office-smoke.ts`; the fixtures come from `pnpm fixtures`.

- **Image:** built from the exact `deploy-worker.sh bundle`. LibreOffice 25.2.3.2 comes from Debian trixie (`libreoffice-{writer,calc,impress}-nogui`, no Java), with the Liberation, Carlito, Caladea and DejaVu fonts. The image grew from 775,868,198 to 1,187,945,630 bytes (**+412 MB, 1.19 GB**). The LibreOffice layer took 32 s to install; the rest came from the cache.
- **Conversions with the real LibreOffice,** in a container with the sidecar's settings (no network, read-only root, 1 GB, 2 CPUs, 128 pids, no capabilities):

  | File | Pages | Conversion | Whole job (convert + render pages) |
  |---|---|---|---|
  | DOCX (US Letter, Calibri → Carlito) | 3 | 509 ms | 888 ms |
  | PPTX (16:9, Arial → Liberation Sans) | 3 | 490 ms | 766 ms |
  | XLSX (SUM formulas computed: 6200/6200/6600) | 2 | 493 ms | 823 ms |
  | ODT / ODP / ODS | 3 / 3 / 1 | 464–505 ms | 714–894 ms |

  The rendered pages were checked by eye.
- **Refused before any conversion:**
  - `truncated.docx`: `OFFICE_INVALID`, in 3 ms;
  - `encrypted.docx` and `encrypted.odt`: `OFFICE_ENCRYPTED`;
  - `macro.docx`: `TYPE_MISMATCH`;
  - `bomb.docx` (1,120 MiB declared): `FILE_TOO_LARGE`, in 2 ms.

  `broken.docx` (a valid package whose XML is garbage): LibreOffice printed "source file could not be loaded" and wrote nothing, which gives `OFFICE_INVALID`.
- **Bigger documents through the sidecar:**
  - a 200-page DOCX took 1.2 s;
  - a 60-slide PPTX took 0.6 s;
  - a 20,000-row XLSX took 2.0 s and made 371 pages (a 32 MB PDF).
  
  **Memory:** the sidecar's cgroup peaked at **274 MiB** (limit 1 GiB). The worker side peaked at 174 MiB while it staged the documents and rendered their pages.
- **The two-container topology,** run from this compose file with only the names changed:
  - both containers came up: `[office] LibreOffice 25.2.3.2 …`, `[office] listening (…, network: none)`, and `[worker] office previews: LibreOffice sidecar (no network, no secrets)`;
  - Docker reported `office` as `NetworkMode=none`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges`, 1 GiB and 128 pids;
  - the volume started out as `node:node 700`, and the socket was `srw-------`;
  - `compose stop` took 1 s, and both containers exited 0 (`[office] stopped`, `[worker] stopped`).

  The worker's API was a closed port for this check. The api → worker → sidecar chain with real uploads ran locally (e2e, with a LibreOffice stand-in), not on the NAS.
- **Isolation, probed from inside the running sidecar:**
  - the only interface was `lo`;
  - connecting to the NAS (192.168.10.1:22) or to 1.1.1.1:443 failed with `ENETUNREACH`, and DNS failed with `EAI_AGAIN`;
  - no process had a token, secret, key or database variable;
  - `/app` and `/usr` were read-only, every capability set was 0, and `NoNewPrivs` was 1.

  Started with `DRAFTROOM_WORKER_TOKEN` set, or on a network, it refused to start (exit 1) with a message naming the problem.
- **Timeouts and cleanup:**
  - a 40,000-row XLSX given a 1 s budget was answered with `TIMEOUT` at 1,012 ms;
  - afterwards no `soffice`/`oosplash` process was left, `/tmp` held no LibreOffice IPC socket (they are swept between conversions), and the jobs volume held only the socket.
- **Hostile documents, with the hardened profile and a default profile as the control:**
  - a picture linked to a local file was rendered into the preview with the default profile and **not** with ours (`BlockUntrustedRefererLinks`);
  - text sections linked to `/etc/hostname` and `/proc/1/environ` were not loaded with either profile, whatever the Writer/Calc "update links" value (so that setting is left at its default);
  - a Basic macro bound to the document's load events did not run under any profile, including one with macro security set to low. So the probe did **not** demonstrate that our macro settings are what stops macros: LibreOffice's headless conversion did not run this macro in any case.
- **Cleanup:**
  - the test containers, volume, compose project, images and folder were removed;
  - `docker ps -a`, `images`, `volume ls` and `network ls` matched the state before;
  - the default builder's cache grew from 41 to 56 entries (3.66 → 4.27 GB). It was not pruned (never prune on this host), and the real build reuses its LibreOffice layer.
- **Not verified:**
  - real-world decks and spreadsheets (fonts beyond the metric-compatible ones, embedded media, SmartArt, charts);
  - CJK text (no CJK fonts installed);
  - the deployed pair behind the real api.

# Draftroom preview worker on the NAS

The preview worker makes thumbnails, PDF page images and video posters. Since milestone 3 it is only an HTTP client of the Draftroom api (`/api/worker/*`, see `docs/M3-STORAGE-CONTRACTS.md` §4–§5). It downloads each original, processes it, uploads the previews and reports back. It needs **no** database, **no** storage credentials, **no** open port and **no** disk of its own. That makes the NAS a good place for extra processing capacity next to the Render api.

Status: **proven on the NAS with throwaway containers (2026-09-27); not deployed for real yet.** The image was built on the NAS and the worker ran from this compose file against a throwaway api that stored files in the real R2 bucket. Everything was removed afterwards. The real `draftroom-worker` project has never been created. See [NAS proof](#nas-proof-2026-09-27) for what was checked.

## What runs where

| Where | What |
|---|---|
| PC (Git Bash) | `deploy/nas/deploy-worker.sh`: bundles the needed repository files, uploads them over ssh and drives Docker on the NAS. |
| NAS `/volume3/Apps/draftroom-worker/` (mode 700: only your NAS account) | `docker-compose.yml` (copied from `deploy/nas/worker/`), `worker.env` (mode 600, your token), `src/` (the uploaded sources the image is built from). |
| NAS Docker | One container, `draftroom-worker` (compose project `draftroom-worker`): 1.5 GB memory cap (no swap), 3 CPUs, 256 processes, all capabilities dropped, `no-new-privileges`, runs as the unprivileged `node` user, restarts unless stopped, logs capped at 3 × 10 MB. |

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
5. swaps the container. The old one gets SIGTERM, finishes or hands back its current job (up to 10 s), and the new one starts;
6. waits for `[worker] started (api: …)` and prints the status.

The first build downloads the Node base image, ffmpeg and the worker's dependencies (sharp, PDF renderer). On this NAS it took 65 s with an empty cache and made a 776 MB image. Later builds reuse Docker's cache.

After the first deploy you can leave out the local env file. The script then keeps the `worker.env` that is already on the NAS.

## Day to day

```bash
bash deploy/nas/deploy-worker.sh status     # state, restarts, OOM flag, CPU/memory, last 20 log lines
bash deploy/nas/deploy-worker.sh logs       # last 100 log lines (logs 500, or logs -f to follow)
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

## Settings

The env file holds only the three variables above. The compose file sets the non-secret tuning (edit `deploy/nas/worker/docker-compose.yml` and deploy again):

| Variable | Default | Notes |
|---|---|---|
| `WORKER_CONCURRENCY` | `1` | Jobs at once. The 1.5 GB memory cap is sized for 1. Raise it together with `mem_limit`. |
| `WORKER_PDF_HEAP_MB` | `384` | V8 heap of the PDF renderer child. |
| `WORKER_POLL_MS` / `WORKER_POLL_MAX_MS` | `2000` / `15000` | Idle polling: doubles with jitter up to the max, and resets when work arrives. |
| `WORKER_SHUTDOWN_GRACE_MS` | `10000` | How long a stopping worker may finish its job before handing it back. It must stay below `stop_grace_period` (30 s). |

## Removing it

```bash
bash deploy/nas/deploy-worker.sh stop
ssh -i ~/.ssh/ugreen_nas chase@192.168.10.1 \
  'docker compose -p draftroom-worker -f /volume3/Apps/draftroom-worker/docker-compose.yml down --rmi all'
ssh -i ~/.ssh/ugreen_nas chase@192.168.10.1 'rm -rf /volume3/Apps/draftroom-worker'
```

Both commands name only the `draftroom-worker` project and folder.

## Security notes

- The worker token lets its holder read the originals of queued uploads and write their previews, nothing else (`docs/M3-STORAGE-CONTRACTS.md` §7). To rotate it, change it on the api, update `.env.worker` and deploy again.
- The token is sent only to the api origin. Object-storage downloads and uploads use short-lived presigned URLs, which never see the token and are never logged.
- The PDF renderer, ffprobe and ffmpeg run as child processes with a minimal environment (no token), hard timeouts and size/page/pixel/duration limits.
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

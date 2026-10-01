#!/bin/sh
# The runbook's `int` helper (docs/EXCALIDRAW-CUTOVER.md §0) run inside a rehearsal container:
#   tools/int.sh sync GET /internal/maintenance
#   tools/int.sh sync POST /internal/maintenance '{"on":true}'
#   tools/int.sh api  GET /internal/checkpoints/run-all
# PORT and DRAFTROOM_INTERNAL_SECRET come from the container's own environment; nothing is printed but
# the status and the body.
set -u
c=${1:?sync|api}; shift
exec docker exec -i "draftroom-rehearsal-$c" node -e "const [m,p,b]=process.argv.slice(1);fetch('http://127.0.0.1:'+(process.env.PORT||10000)+p,{method:m,headers:{'content-type':'application/json','x-draftroom-internal':process.env.DRAFTROOM_INTERNAL_SECRET},body:b}).then(async r=>{console.log(r.status,await r.text());process.exitCode=r.ok?0:1})" "$@"

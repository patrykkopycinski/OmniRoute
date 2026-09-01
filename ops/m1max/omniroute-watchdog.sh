#!/bin/bash
# omniroute watchdog — keeps the gateway + dashboard alive.
#
# Handles the real failure ladder observed on this box, in order:
#   0. Host memory pressure (swap saturation evicts OrbStack VM pages →
#      Docker daemon unreachable — root cause of 2026-08-21 cascade).
#   1. OrbStack VM stopped (app still "running" — `restart: unless-stopped`
#      does NOT save you here; this is what actually took the gateway down).
#   2. Container stopped/missing.
#   3. Container up but HTTP dead (hung process, port not serving).
#   4. Chunk compat patches missing (only happens after an image recreate —
#      they survive a plain stop/start — but re-applying is idempotent and
#      cheap, and a gateway without them silently breaks kiro/github/oauth).
#
# Idempotent and quiet: logs only when it acts, so the log is a record of
# real incidents rather than a heartbeat spam file.

set -uo pipefail

CONTAINER=omniroute
PORT=20128
IMAGE="${OMNIROUTE_IMAGE:-omniroute:local-ui-fix-quota-skip-v9}"
VOLUME=omniroute-data
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
LOG="${HOME}/Library/Logs/omniroute-watchdog.log"
PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.orbstack/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$(dirname "$LOG")"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOG"; }

# Trim the log so it can never grow unbounded (launchd does not rotate).
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  log "[rotate] log truncated to last 500 lines"
fi

healthy() {
  # Probe via the container IP, NOT host loopback. Under heavy host load
  # (load avg >100, swap thrashing) OrbStack's userspace port-forwarder for
  # 127.0.0.1:20128 stalls for 20s+ while the app itself answers in ~30ms on
  # its container IP. Probing loopback therefore reported a perfectly healthy
  # gateway as dead and triggered a restart loop that made the load worse.
  # Verified 2026-08-03: loopback 3×timeout @25s, container IP 200 in 4.5ms.
  local code ip
  ip=$(docker inspect "$CONTAINER" \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
        2>/dev/null | tr -d '\r' | awk 'NF{print;exit}')
  if [ -n "$ip" ]; then
    code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://${ip}:${PORT}/healthz" 2>/dev/null)
    [ "$code" = "200" ] && return 0
  fi
  # Last resort: ask the app about itself from inside the container, which
  # bypasses the host forwarder entirely.
  code=$(docker exec "$CONTAINER" node -e \
    'fetch("http://127.0.0.1:'"${PORT}"'/healthz",{signal:AbortSignal.timeout(8000)})
       .then(r=>{process.stdout.write(String(r.status))})
       .catch(()=>{process.stdout.write("000")})' 2>/dev/null | tr -d '\r')
  [ "$code" = "200" ]
}

# True host-path reachability: the app can be fine while OrbStack's forwarder
# is wedged. That is a real user-visible outage (every client dials loopback)
# but the fix is NOT an app restart — report it distinctly.
host_path_ok() {
  local code
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)
  [ "$code" = "200" ]
}

# --- Rung 0: host memory pressure ---------------------------------------
# Severe swap saturation makes macOS evict OrbStack VM pages, which kills
# the Docker daemon. Verified 2026-08-21: 17.4 GB swap + 644 MB free RAM
# → OrbStack unreachable every ~15 min. Killing an 11 GB orphaned Kibana
# dev server dropped swap to 5.6 GB and stopped the restart cascade.
#
# This rung logs on level transitions only (ok→warn→crit and back), so the
# log stays a record of incidents. It never restarts anything — a restart
# under swap saturation adds more memory pressure and makes the load worse.
#
# Thresholds (Apple Silicon, page size = 16 KB):
#   warn: free physical < 160 MB  OR  swap file > 60% full
#   crit: free physical <  49 MB  OR  swap file > 85% full
MEM_STAMP="${HOME}/.9router/.mem-pressure"
FREE_PAGES=$(vm_stat 2>/dev/null | awk '/^Pages free:/{gsub(/\./,"",$3); print $3+0}')
swap_raw=$(sysctl -n vm.swapusage 2>/dev/null | awk '{gsub(/M/,"",$3); gsub(/M/,"",$6); print int($6+0.5) " " int($3+0.5)}')
SWAP_USED=$(echo "$swap_raw" | awk '{print $1}')
SWAP_TOTAL=$(echo "$swap_raw" | awk '{print $2}')
SWAP_PCT=0
[ "${SWAP_TOTAL:-0}" -gt 0 ] && SWAP_PCT=$(( SWAP_USED * 100 / SWAP_TOTAL ))

mem_level="ok"
if [ "${FREE_PAGES:-99999}" -lt 3000 ] || [ "$SWAP_PCT" -gt 85 ]; then
  mem_level="crit"
elif [ "${FREE_PAGES:-99999}" -lt 10000 ] || [ "$SWAP_PCT" -gt 60 ]; then
  mem_level="warn"
fi

if [ "$mem_level" != "ok" ]; then
  prev_level=$(cat "$MEM_STAMP" 2>/dev/null || echo "ok")
  if [ "$mem_level" != "$prev_level" ]; then
    free_mb=$(( ${FREE_PAGES:-0} * 16 / 1024 ))
    top5=$(top -l 1 -s 0 -o MEM -n 5 2>/dev/null \
      | awk '/^[0-9]+[[:space:]]/{printf "%s=%s ", $2, $8}' \
      | cut -c1-120)
    log "[mem] ${mem_level}: free=${free_mb}MB swap=${SWAP_USED}/${SWAP_TOTAL}MB (${SWAP_PCT}%) load=$(uptime | sed 's/.*averages: //') top: ${top5}"
    echo "$mem_level" > "$MEM_STAMP"
  fi
else
  if [ -f "$MEM_STAMP" ]; then
    free_mb=$(( ${FREE_PAGES:-0} * 16 / 1024 ))
    log "[mem] recovered: free=${free_mb}MB swap=${SWAP_USED}/${SWAP_TOTAL}MB (${SWAP_PCT}%)"
    rm -f "$MEM_STAMP"
  fi
fi

# --- Rung 1: OrbStack VM ------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  log "[vm] docker daemon unreachable — starting OrbStack VM"
  orb start >/dev/null 2>&1
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if docker info >/dev/null 2>&1; then
    log "[vm] docker daemon back up"
  else
    log "[vm] FAILED to bring docker up — giving up this tick"
    exit 1
  fi
fi

# --- Rung 2: container running ------------------------------------------
if ! docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  if docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    log "[container] not running — docker start ${CONTAINER}"
    docker start "$CONTAINER" >/dev/null 2>&1
  else
    # Container deleted (e.g. `docker rm`). The run spec is fixed and known,
    # so recreate it rather than leaving the gateway down. Patches are wiped
    # by a recreate — rung 4 below re-applies them on this same tick.
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      log "[container] MISSING and image ${IMAGE} not found — manual intervention required"
      exit 1
    fi
    log "[container] MISSING entirely — recreating via run-omniroute.sh (full spec: redis+heap+health)"
    if [ -x "${HOME}/.hermes/scripts/run-omniroute.sh" ]; then
      "${HOME}/.hermes/scripts/run-omniroute.sh" >/dev/null 2>&1
    else
      # Fallback to inline spec kept in sync with run-omniroute.sh (redis+heap+health).
      docker network inspect omniroute-net >/dev/null 2>&1 || docker network create omniroute-net >/dev/null 2>&1
      docker run -d --name "$CONTAINER" --restart unless-stopped --network omniroute-net \
        -p "${PORT}:${PORT}" -v "${VOLUME}:/app/data" \
        -e NODE_ENV=production -e PORT="${PORT}" -e HOSTNAME=0.0.0.0 \
        -e DATA_DIR=/app/data -e OMNIROUTE_MIGRATIONS_DIR=/app/migrations \
        -e OMNIROUTE_MEMORY_MB=4096 -e NODE_OPTIONS="--max-old-space-size=4096" \
        -e REDIS_URL="redis://omniroute-redis:6379" \
        --health-cmd "node healthcheck.mjs" --health-interval 30s \
        --health-timeout 15s --health-retries 5 --health-start-period 20s \
        "$IMAGE" >/dev/null 2>&1
    fi
    if [ $? -ne 0 ]; then
      log "[container] recreate FAILED"
      exit 1
    fi
    log "[container] recreated"
  fi
  sleep 10
fi

# --- Rung 3: HTTP liveness ----------------------------------------------
if ! healthy; then
  # Give a booting container a chance before declaring it hung.
  for _ in $(seq 1 15); do
    sleep 2
    healthy && break
  done
  if ! healthy; then
    log "[http] app not answering on container IP — restarting container"
    docker restart "$CONTAINER" >/dev/null 2>&1
    for _ in $(seq 1 30); do
      sleep 2
      healthy && break
    done
    healthy && log "[http] recovered after restart" || log "[http] STILL DOWN after restart"
  fi
fi

# --- Rung 3b: host port-forward path ------------------------------------
# App healthy but loopback wedged => OrbStack forwarder problem, not an app
# problem. Restarting the container does NOT fix this (proven: 4 restarts in
# a row on 2026-08-03 all left loopback dead; it cleared only when host load
# dropped). So: log it, do not restart-loop. Escalate only if it persists,
# and then restart the OrbStack VM rather than the container.
if healthy && ! host_path_ok; then
  STAMP="${HOME}/.9router/.forwarder-wedged"
  now=$(date +%s)
  if [ -f "$STAMP" ]; then
    first=$(cat "$STAMP" 2>/dev/null || echo "$now")
  else
    first=$now
    echo "$now" > "$STAMP"
    log "[forward] app OK on container IP but 127.0.0.1:${PORT} not answering — OrbStack port-forwarder wedged (load avg: $(uptime | sed 's/.*averages: //')). NOT restarting container."
  fi
  wedged_for=$(( now - first ))
  # 15 min of a wedged forwarder is a real outage worth a VM-level bounce.
  if [ "$wedged_for" -ge 900 ]; then
    log "[forward] wedged for ${wedged_for}s — restarting OrbStack VM"
    orb restart >/dev/null 2>&1
    sleep 20
    host_path_ok && log "[forward] recovered after OrbStack restart" \
                 || log "[forward] STILL wedged after OrbStack restart"
    rm -f "$STAMP"
  fi
elif host_path_ok; then
  STAMP="${HOME}/.9router/.forwarder-wedged"
  if [ -f "$STAMP" ]; then
    log "[forward] 127.0.0.1:${PORT} answering again — clearing wedged state"
    rm -f "$STAMP"
  fi
fi

# --- Rung 4 opt-out: source-based images -------------------------------
# OMNIROUTE_SOURCE_BASED_IMAGE_GUARD
# Images built from Dockerfile.local ship app code as TS SOURCE at
# /app/open-sse/*.ts; Next chunks are stale build artifacts that are never
# executed. Chunk-marker greps therefore can NEVER be satisfied on these
# images -> reapply patches 0 chunks -> unconditional restart loop, and the
# breaker signature embeds the image tag so every new tag resets it.
# If the cursor fixes are present in the TS source, skip rung 4 entirely.
SKIP_RUNG4=0
# Generic source-based-image detection. Do NOT key on any single marker string:
# markers come and go as fixes land upstream. Ask the structural question
# instead -- does this image execute TS source rather than the chunk tree?
# Dockerfile.local images run dev/run-standalone.mjs over /app/open-sse/*.ts,
# so the chunks under /app/.build are inert build artifacts and patching them
# is a no-op forever.
if docker exec "$CONTAINER" sh -c '[ -f /app/open-sse/executors/cursor.ts ]' 2>/dev/null; then
  SKIP_RUNG4=1
fi
# No repair tool present => nothing rung 4 can ever do.
if ! docker exec "$CONTAINER" sh -c '[ -f /app/data/reapply-compat-patches.js ]' 2>/dev/null; then
  SKIP_RUNG4=1
fi

# --- Rung 4: compat chunk patches ---------------------------------------
# Wiped by an image recreate. Without them kiro/github/oauth-reloc silently
# regress, so treat a missing patch as an incident and re-apply.
if healthy && [ "$SKIP_RUNG4" -eq 0 ]; then
  # cursorkv: Fix 4 makes the cursor executor stop treating a kv_server_message
  # (blob-store side channel) frame as terminal. Without it, any cursor turn
  # streaming >~2.5K chars of text is truncated mid-generation, which surfaces as
  # "the agent stops after a single message". kvleak is the inverse assertion:
  # zero chunks may still carry the terminal assignment.
  counts=$(docker exec "$CONTAINER" sh -c \
    'cd /app/.build/next/server/chunks 2>/dev/null && echo "$(grep -l "__mv=" *.js 2>/dev/null | wc -l) $(grep -l "__sid=" *.js 2>/dev/null | wc -l) $(grep -l "return _n!==\"web_search\"" *.js 2>/dev/null | wc -l) $(grep -l "__ORKVFIX" *.js 2>/dev/null | wc -l) $(grep -l "endReason=\"kv_after_text\"" *.js 2>/dev/null | wc -l)"' \
    2>/dev/null | tr -d '\r' | tail -1)
  reloc=$(echo "$counts" | awk '{print $1+0}')
  kiro=$(echo "$counts" | awk '{print $2+0}')
  gh=$(echo "$counts" | awk '{print $3+0}')
  cursorkv=$(echo "$counts" | awk '{print $4+0}')
  kvleak=$(echo "$counts" | awk '{print $5+0}')

  if [ "$reloc" -eq 0 ] || [ "$kiro" -eq 0 ] || [ "$gh" -eq 0 ] || [ "$cursorkv" -eq 0 ] || [ "$kvleak" -ne 0 ]; then
    # --- circuit breaker -------------------------------------------------
    # A missing marker does NOT always mean a missing fix. When a fix lands
    # upstream the marker string disappears for good (v3851-c661e1c81 ships
    # the cursor kv fix model-gated as x.Ut(b.model), so cursorkv/kvleak can
    # never satisfy this check and reapply patches 0 chunks). Without a
    # breaker that is an infinite restart loop: 218 restarts / 85s apart on
    # 2026-09-01 before this guard existed.
    #
    # Retry only while retrying still changes something. The signature is the
    # running image plus the measured counts; two ineffective attempts against
    # the same signature trip the breaker until the image or counts move.
    BREAKER="${HOME}/.9router/.patch-breaker"
    mkdir -p "$(dirname "$BREAKER")"
    running_image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null | tr -d '\r')
    sig="${running_image}:${reloc}:${kiro}:${gh}:${cursorkv}:${kvleak}"
    prev_sig=$(awk 'NR==1{print $1}' "$BREAKER" 2>/dev/null || echo "")
    prev_n=$(awk 'NR==1{print $2+0}' "$BREAKER" 2>/dev/null || echo 0)
    if [ "$sig" = "$prev_sig" ]; then
      attempts=$prev_n
    else
      attempts=0
    fi

    if [ "$attempts" -ge 2 ]; then
      # Tripped. Log only on the transition so this stays an incident log.
      if [ "$attempts" -eq 2 ]; then
        log "[patch] BREAKER TRIPPED — 2 ineffective re-applies for sig ${sig}; markers absent but reapply patches 0 chunks (fix likely upstream in this image). Not restarting again until image or counts change. Verify with: docker exec ${CONTAINER} sh -c 'cd /app/.build/next/server/chunks && grep -l kvAfterTextSeen *.js'"
        echo "$sig $((attempts + 1))" > "$BREAKER"
      fi
    else
      log "[patch] missing (reloc=$reloc kiro=$kiro gh=$gh cursorkv=$cursorkv kvleak=$kvleak) — re-applying compat patches (attempt $((attempts + 1))/2)"
      # RUNG4_EFFECTIVE_REPAIR_GUARD
      # Capture the repair's own report and restart ONLY if it changed bytes.
      # Invariant: a repair that patched 0 chunks cannot be fixed by a restart,
      # so restarting is pure damage (it drops in-flight requests and, before
      # this guard, looped forever). This holds regardless of which markers
      # exist, which image runs, or what lands upstream next -- unlike the
      # breaker below, whose signature embeds the image tag and therefore
      # resets on every deploy.
      reapply_out=$(docker exec -u root "$CONTAINER" node /app/data/reapply-compat-patches.js 2>&1)
      printf '%s\n' "$reapply_out" >>"$LOG"
      patched_total=$(printf '%s' "$reapply_out" \
        | grep -oE 'patched: *[0-9]+' | grep -oE '[0-9]+' \
        | awk '{t+=$1} END {print t+0}')
      if [ "${patched_total:-0}" -eq 0 ]; then
        log "[patch] repair changed 0 chunks — NOT restarting (restart cannot fix what the repair cannot reach). Marking signature exhausted."
        echo "$sig 99" > "$BREAKER"
        exit 0
      fi
      log "[patch] repair changed ${patched_total} chunk(s) — restarting to load them"
      docker restart "$CONTAINER" >/dev/null 2>&1
      for _ in $(seq 1 30); do
        sleep 2
        healthy && break
      done
      echo "$sig $((attempts + 1))" > "$BREAKER"
      log "[patch] re-applied and container restarted"
    fi
  else
    # Patches present: clear any tripped breaker so a future real regression
    # gets its full retry budget back.
    BREAKER="${HOME}/.9router/.patch-breaker"
    if [ -f "$BREAKER" ]; then
      log "[patch] all markers present — clearing breaker state"
      rm -f "$BREAKER"
    fi
  fi
fi

exit 0

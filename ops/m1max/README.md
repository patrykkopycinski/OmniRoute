# m1max operational scripts

Host scripts for the m1max OmniRoute deployment (`mac@100.67.93.90`), kept in
git because they live in `/Users/mac/bin/` on a single machine with no other
copy. Edit here, then deploy.

## `omniroute-watchdog.sh`

LaunchAgent `com.mac.omniroute-watchdog` runs this on a timer. Five rungs,
escalating: host memory pressure → OrbStack VM → container running → HTTP
liveness → host port-forward → compat chunk patches.

### Deploy

```bash
scp ops/m1max/omniroute-watchdog.sh mac@100.67.93.90:/Users/mac/bin/
ssh mac@100.67.93.90 'bash -n /Users/mac/bin/omniroute-watchdog.sh && \
  launchctl kickstart -k gui/$(id -u)/com.mac.omniroute-watchdog'
```

Use `kickstart -k`, not a bootout/bootstrap cycle.

### ⛔ Rung 4 and the restart loop (2026-09-01)

Rung 4 re-applies compat patches to **minified Turbopack chunks** under
`/app/.build/next/server/chunks/`, detecting need by grepping for marker
strings. It caused two production restart loops:

1. **218 restarts / 85s apart** — a fix landed upstream, its marker string
   disappeared for good, so the check could never be satisfied.
2. **Every ~60-90s after deploying `v3851-cursorfix-1945cc631`** — images built
   from `Dockerfile.local` execute **TS source** at `/app/open-sse/*.ts`; the
   chunk tree is an inert build artifact, so patching it is a no-op forever.

Both loops restarted a **healthy** container with `RestartCount` stuck at `0`
(the watchdog issues `docker restart`; Docker never saw a crash). Detect by
polling `.State.StartedAt`, never `RestartCount`:

```bash
docker inspect omniroute --format \
  "health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}"
```

A container reporting `healthy` at one poll and `starting` with a **new**
`StartedAt` at the next was restarted while healthy. That is never legitimate.

### The three layers that now prevent it

**1. Effective-repair guard (`RUNG4_EFFECTIVE_REPAIR_GUARD`) — the load-bearing one.**
Parses the repair's own `patched: N` report and restarts **only if N > 0**.

> Invariant: a repair that patched 0 chunks cannot be fixed by a restart.

This holds regardless of which markers exist, which image runs, or what lands
upstream next — so it closes the whole bug class, not one instance.

**2. Generic source-based-image probe (`SKIP_RUNG4`).**
Skips rung 4 entirely when `/app/open-sse/executors/cursor.ts` exists (image
runs TS source) or when `/app/data/reapply-compat-patches.js` is absent (no
repair tool ⇒ nothing rung 4 can do). Deliberately **structural** — do not
re-key this on a marker string like `kvAfterTextSeen`; markers come and go as
fixes land upstream, which is what caused loop #1.

**3. Circuit breaker (`~/.9router/.patch-breaker`) — weakest, keep last.**
Caps retries per signature. Insufficient alone: its signature embeds the image
tag, so **every new deploy resets it**, and it reads only line 1 (`awk 'NR==1'`),
so it cannot be pre-seeded across the drifting `kvleak` count.

### Before disabling rung 4 for a new image

Its warnings sound alarming (*"cursor tool calls will drop"*). Prove the fix it
wants is already present in the executing source first:

```bash
docker exec omniroute sh -c "grep -c kvAfterTextSeen /app/open-sse/executors/cursor.ts"
```

Non-zero ⇒ the hand-patch is redundant and the warning is the watchdog failing
to find its marker somewhere that no longer matters. **A monitor complaining
about a missing workaround is not evidence the bug is back.**

### Verifying a change

`bash -n` only catches syntax. Test the parser against real repair output:

```bash
parse() { printf "%s" "$1" | grep -oE "patched: *[0-9]+" | grep -oE "[0-9]+" \
  | awk "{t+=\$1} END {print t+0}"; }
parse "[reapply-compat] kiro chunks patched: 0, github chunks patched: 0"   # 0 => no restart
parse "[reapply-compat] kiro chunks patched: 4, github chunks patched: 4"   # 8 => restart
```

Then reload and watch `StartedAt` for ≥5 minutes. Ten stable 30s ticks is the
bar — the loop's period was 60-90s, so a short check proves nothing.

Backups on the host: `omniroute-watchdog.sh.bak-*`.

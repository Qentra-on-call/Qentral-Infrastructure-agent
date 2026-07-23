#!/usr/bin/env node
// Qentra Infrastructure Agent — runs directly on a Proxmox VE node (systemd
// service, root), NOT inside Kubernetes. Collects host/VM/storage state via
// `pvesh` (Proxmox's local CLI — always present, talks to pveproxy over a unix
// socket, no separate Proxmox API token to create) and ships a snapshot to
// Qentra every COLLECT_SECONDS. Pure Node stdlib, no npm deps — mirrors the
// Kubernetes agent's philosophy (tiny, near-zero footprint).
//
// READ-ONLY BY DESIGN — audit this file for exactly five kinds of external
// calls and nothing else (grep for "execFileSync" to verify every call site
// if you're reviewing this before installing it on production hypervisors):
//   1. `pvesh(path)` below, which ALWAYS runs `pvesh get ...` — never
//      `pvesh create/set/delete`. It cannot start, stop, migrate, snapshot,
//      or reconfigure anything.
//   2. `zpool status` (read-only diagnostic; not `zpool scrub`/`create`/etc).
//   3. `sensors -j` (lm-sensors) — read-only hardware sensor query.
//   4. `ipmitool dcmi power reading` — read-only BMC power query.
//   5. `ipmitool sdr list` — read-only BMC Sensor Data Record query (fan/temp
//      readings from the BMC, e.g. HPE iLO). Neither ipmitool call ever
//      invokes a `chassis`/`raw`/config subcommand that could change anything.
// The agent never opens a network listener other than its own /healthz, and
// never accepts inbound commands from Qentra — it only pushes snapshots out.
//
//   QENTRA_URL       e.g. https://crm.qentra.it.com     (default: hosted Qentra)
//   QENTRA_TOKEN     ApiToken with scope infra:write     (required)
//   NODE_NAME        Proxmox node name (default: short hostname)
//   PROXMOX_CLUSTER  label for this Proxmox cluster, e.g. "prod-1" — same idea
//                    as the Kubernetes agent's CLUSTER_NAME. An org with
//                    several Proxmox clusters (e.g. 4, one per DC/rack) gives
//                    each its own name + its own cluster-scoped token, so one
//                    compromised install token can't report as another
//                    cluster. Defaults to the cluster name Proxmox itself
//                    reports (pvesh /cluster/status), or "default" if
//                    standalone.
//   COLLECT_SECONDS  how often to collect + ship (default: 30)
//   HEALTH_PORT      default 8081 (GET /healthz)
//   REFRESH_HOURS    long-period hygiene self-restart, in hours (default: 3,
//                     0 disables). Belt-and-suspenders general refresh — see
//                     STALE_MIN below for the fast-recovery watchdog, which is
//                     the one that actually catches a wedged agent quickly.
//   STALE_MIN        watchdog: if no successful ingest in this many minutes,
//                     self-restart (default: 8, 0 disables). THIS is the fix
//                     for the historical failure mode — the agent process
//                     stays alive and even keeps its /healthz port open, but
//                     silently stops shipping data (a wedged connection, a
//                     hung child process) without ever crashing, so
//                     `Restart=always` never triggers because there's nothing
//                     to restart from systemd's point of view. The old fix was
//                     "SSH in and reinstall", which just restarts the same
//                     binary — this does that automatically, within minutes,
//                     with no reinstall and no human needed. Runs on its own
//                     interval independent of collectAndShip, so it still
//                     fires even if a collection cycle is hung.
import os from 'node:os';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Prefer IPv4 when a hostname resolves to both. Without this, Node can try an
// IPv6 address first even on networks with no IPv6 route at all — the
// connection attempt fails outright (not a timeout) but Node's fallback to
// the working IPv4 address isn't always fast/clean for https.request, and it
// can surface as "socket disconnected before secure TLS connection was
// established" on EVERY attempt. Seen on a real customer's office network
// with no IPv6 route; curl handled the fallback fine, Node's https module
// didn't. This makes the agent work correctly on IPv6-less networks without
// requiring any network reconfiguration.
dns.setDefaultResultOrder('ipv4first');

const URL_BASE = (process.env.QENTRA_URL || 'https://crm.qentra.it.com').replace(/\/$/, '');
const TOKEN = process.env.QENTRA_TOKEN || '';
const NODE_NAME = process.env.NODE_NAME || os.hostname().split('.')[0];
const CLUSTER_OVERRIDE = process.env.PROXMOX_CLUSTER || '';
const COLLECT_MS = (Number(process.env.COLLECT_SECONDS) || 30) * 1000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 8081;
const REFRESH_HOURS = process.env.REFRESH_HOURS != null ? Number(process.env.REFRESH_HOURS) : 3;
const STALE_MIN = process.env.STALE_MIN != null ? Number(process.env.STALE_MIN) : 8;
const VERSION = '0.2.8';

if (!TOKEN) {
  console.error('[qentra-infra-agent] QENTRA_TOKEN is required (an ApiToken with scope infra:write)');
  process.exit(1);
}

// Run `pvesh get <path> --output-format json` and parse it — READ-ONLY, always
// the `get` verb (see the file-header audit note). Returns null (never throws)
// so one missing/misconfigured subsystem (e.g. no Ceph) doesn't take down the
// whole collection cycle. A short timeout + ignored stdin keeps this from ever
// hanging or prompting — it cannot block pveproxy or wedge the node.
// DEBUG=1 logs every pvesh call's outcome (path + ok/fail + row count) — turn
// on when diagnosing "why isn't X showing up" via `journalctl -u qentra-infra-agent`.
const DEBUG = process.env.DEBUG === '1';

function pvesh(path) {
  try {
    const out = execFileSync('pvesh', ['get', path, '--output-format', 'json'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out);
    if (DEBUG) console.log(`[qentra-infra-agent] pvesh get ${path} -> ok (${Array.isArray(parsed) ? parsed.length + ' rows' : typeof parsed})`);
    return parsed;
  } catch (err) {
    // Previously swallowed silently — the #1 reason "why isn't my data showing
    // up" was unanswerable. Always log failures (not just under DEBUG) since
    // they're rare enough not to be noisy and important enough to always see.
    const detail = err.stderr ? String(err.stderr).trim().split('\n')[0] : err.message;
    console.error(`[qentra-infra-agent] pvesh get ${path} failed: ${detail}`);
    return null;
  }
}

// Best-effort local ZFS scrub state — `zpool status` isn't a pvesh endpoint.
function zfsScrubState(pool) {
  try {
    const out = execFileSync('zpool', ['status', pool], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/scan:\s*(.+)/);
    return m ? m[1].trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

// Best-effort hardware temperature + fan sensors via lm-sensors (`sensors -j`
// — read-only, ships on most Proxmox hosts or is a one-line `apt install
// lm-sensors` away). Returns { temps: [{label, tempC}], fans: [{label, rpm}] }
// or both empty arrays if lm-sensors isn't installed/configured — never
// fabricated, and this failure mode is silent (unlike pvesh) because "no
// lm-sensors installed" is a normal, common state, not an error to log.
function collectSensors() {
  const temps = [], fans = [];
  try {
    const out = execFileSync('sensors', ['-j'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const data = JSON.parse(out);
    for (const [chip, features] of Object.entries(data)) {
      if (!features || typeof features !== 'object') continue;
      for (const [label, reading] of Object.entries(features)) {
        if (!reading || typeof reading !== 'object') continue;
        for (const [key, val] of Object.entries(reading)) {
          if (typeof val !== 'number') continue;
          if (key.endsWith('_input') && key.startsWith('temp')) temps.push({ label: `${chip}/${label}`, tempC: val });
          else if (key.endsWith('_input') && key.startsWith('fan')) fans.push({ label: `${chip}/${label}`, rpm: val });
        }
      }
    }
  } catch { /* lm-sensors not installed/configured — normal, not an error */ }
  return { temps: temps.slice(0, 32), fans: fans.slice(0, 32) };
}

// Best-effort power draw via ipmitool (requires BMC/IPMI access — common on
// server-class hardware, absent on consumer boards/VMs). `dcmi power reading`
// is a READ-ONLY query (no write/config subcommand is ever invoked). Returns
// null if ipmitool isn't installed or the host has no accessible BMC.
function collectPowerWatts() {
  try {
    const out = execFileSync('ipmitool', ['dcmi', 'power', 'reading'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/Instantaneous power reading:\s*(\d+)\s*Watts/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Best-effort fan + temperature sensors via the BMC (`ipmitool sdr list` —
// READ-ONLY Sensor Data Record query, same read-only guarantee as `dcmi power
// reading`). Fills a real gap: many server vendors (HPE iLO, Dell iDRAC,
// Supermicro) manage fan control entirely through the BMC rather than a
// Super-I/O chip lm-sensors can probe on the local bus, so `sensors -j` can
// report CPU/NVMe temps but ZERO fan data on that same hardware even though
// the fans (and their RPM) are fully visible via IPMI. Labeled "ipmi/..." so
// it's clearly distinguishable from lm-sensors readings when both exist.
function collectIpmiSensors() {
  const temps = [], fans = [];
  try {
    // `sdr list` enumerates every sensor over IPMI (often 40+ on dual-CPU
    // servers) and was observed timing out at 10s specifically under the
    // systemd service's CPUQuota=25% throttling (confirmed live: instant when
    // run interactively as root, ETIMEDOUT every cycle under the service).
    // 25s leaves headroom inside the 30s collection interval.
    const out = execFileSync('ipmitool', ['sdr', 'list'], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      const cols = line.split('|').map((c) => c.trim());
      if (cols.length < 2) continue;
      const [name, value] = cols;
      if (!name || !value) continue;
      const rpmMatch = value.match(/^([\d.]+)\s*RPM$/i);
      if (rpmMatch) { fans.push({ label: `ipmi/${name}`, rpm: Number(rpmMatch[1]) }); continue; }
      // Some BMCs (observed: HPE iLO on ProLiant Gen10) don't expose a
      // tachometer RPM reading via IPMI at all — only a commanded duty-cycle
      // percentage (e.g. "Fan 1 DutyCycle | 28.22 percent | ok"). Report it
      // honestly as a percentage rather than inventing an RPM figure. Scoped
      // to sensor names containing "fan" so an unrelated percent-valued
      // sensor (e.g. a PSU load reading) isn't misclassified as a fan.
      const pctMatch = value.match(/^([\d.]+)\s*percent$/i);
      if (pctMatch && /fan/i.test(name)) { fans.push({ label: `ipmi/${name}`, pct: Number(pctMatch[1]) }); continue; }
      const tempMatch = value.match(/^([\d.]+)\s*degrees C$/i);
      if (tempMatch) temps.push({ label: `ipmi/${name}`, tempC: Number(tempMatch[1]) });
    }
    if (DEBUG) console.log(`[qentra-infra-agent] ipmitool sdr list -> ok (${temps.length} temp, ${fans.length} fan readings)`);
  } catch (err) {
    // Unlike a missing/absent BMC (the normal case on most hardware), a
    // command that exists but fails is worth surfacing — this swallowed
    // silently for a long time and made "why is fan data missing" undiagnosable.
    console.error(`[qentra-infra-agent] ipmitool sdr list failed: ${err.code === 'ENOENT' ? 'ipmitool not installed' : (err.stderr?.toString().trim() || err.message)}`);
  }
  return { temps: temps.slice(0, 32), fans: fans.slice(0, 32) };
}

// Combine lm-sensors + IPMI readings, capped so a chatty BMC can't bloat the
// payload (the ingest schema itself also caps at 64 each — this just keeps
// what's most likely to matter: local chip readings first, then BMC).
function mergeSensors(local, ipmi) {
  return {
    temps: [...local.temps, ...ipmi.temps].slice(0, 48),
    fans: [...local.fans, ...ipmi.fans].slice(0, 48),
  };
}

function collectNode() {
  const status = pvesh(`/nodes/${NODE_NAME}/status`) || {};
  const cluster = pvesh('/cluster/status') || [];
  const clusterInfo = Array.isArray(cluster) ? cluster.find((c) => c.type === 'cluster') : null;
  const mem = status.memory || {};
  // Proxmox VE 9.2.4 has been observed always returning status.cpu = 0 (a real
  // API behavior on that version, confirmed against a live host — not a bug in
  // this agent). Fall back to a standard load-average-based estimate
  // (load1 / logical cores) whenever the direct field reads as exactly zero,
  // which a genuinely idle multi-core host essentially never does.
  const cores = status.cpuinfo?.cpus;
  let cpu = typeof status.cpu === 'number' && status.cpu > 0 ? status.cpu * 100 : null;
  if (cpu == null && Array.isArray(status.loadavg) && cores) {
    const load1 = Number(status.loadavg[0]);
    if (Number.isFinite(load1)) cpu = Math.min(100, (load1 / cores) * 100);
  }
  // The Qentra-facing cluster label: an explicit PROXMOX_CLUSTER wins (so an
  // org can name/scope clusters however it authorized its token), falling back
  // to what Proxmox itself reports, then "default" for a standalone node.
  const clusterName = CLUSTER_OVERRIDE || clusterInfo?.name || 'default';
  // IO wait — Proxmox reports it as a 0..1 fraction (`status.wait`), the same
  // shape as `cpu`, in the SAME /nodes/<n>/status response already fetched
  // above (no extra API call). High iowait with normal CPU means "storage is
  // the bottleneck, not the CPU". Best-effort: undefined when absent.
  const iowait = typeof status.wait === 'number' ? Math.max(0, Math.min(100, status.wait * 100)) : undefined;
  return {
    name: NODE_NAME,
    clusterName,
    quorate: clusterInfo ? !!clusterInfo.quorate : undefined,
    status: 'online',
    cpuUsedPct: cpu ?? undefined,
    iowaitPct: iowait,
    cpuCores: status.cpuinfo?.cpus ?? undefined,
    memUsedBytes: mem.used ?? undefined,
    memTotalBytes: mem.total ?? undefined,
    uptimeSeconds: status.uptime ?? undefined,
    kernelVersion: status.kversion ?? undefined,
    pveVersion: status.pveversion ?? undefined,
    loadAvg: Array.isArray(status.loadavg) ? status.loadavg.map(Number) : undefined,
    networkDown: collectNetworkDown(),
    ...mergeSensors(collectSensors(), collectIpmiSensors()),
    powerWatts: collectPowerWatts() ?? undefined,
  };
}

// Physical uplinks (eth/bond) Proxmox itself reports as inactive. Deliberately
// narrow — NOT bridges/VLANs, which are routinely "down" by design (unused
// trunk, a bridge with no member yet) and would just be alert noise. This is a
// real signal from `pvesh get`, not a fabricated metric: Proxmox's own
// /nodes/{node}/network already reports each interface's `active` state.
function collectNetworkDown() {
  const ifaces = pvesh(`/nodes/${NODE_NAME}/network`) || [];
  return ifaces
    .filter((i) => (i.type === 'eth' || i.type === 'bond') && i.active === 0)
    .map((i) => i.iface)
    .filter(Boolean);
}

function collectVms() {
  const vms = [];
  for (const [kind, type] of [['qemu', 'qemu'], ['lxc', 'lxc']]) {
    const list = pvesh(`/nodes/${NODE_NAME}/${kind}`) || [];
    for (const v of list) {
      vms.push({
        vmid: v.vmid,
        name: v.name || undefined,
        type,
        status: v.status === 'running' ? 'running' : v.status === 'paused' ? 'paused' : 'stopped',
        cpuUsedPct: typeof v.cpu === 'number' ? v.cpu * 100 : undefined,
        cpuCores: v.cpus ?? undefined,
        memUsedBytes: v.mem ?? undefined,
        memMaxBytes: v.maxmem ?? undefined,
        diskUsedBytes: v.disk ?? undefined,
        diskMaxBytes: v.maxdisk ?? undefined,
        uptimeSeconds: v.uptime ?? undefined,
        // Cumulative bytes since the VM started (Proxmox's own counters,
        // already present in this list response — no extra API call).
        netInBytes: v.netin ?? undefined,
        netOutBytes: v.netout ?? undefined,
      });
    }
  }
  return vms;
}

function collectStorage() {
  const pools = [];
  const storages = pvesh(`/nodes/${NODE_NAME}/storage`) || [];
  // Best-effort Ceph cluster health (only present if this node runs Ceph).
  const cephStatus = pvesh('/cluster/ceph/status');
  const cephOsdUp = cephStatus?.osdmap?.osdmap?.num_up_osds ?? cephStatus?.osdmap?.num_up_osds;
  const cephOsdTotal = cephStatus?.osdmap?.osdmap?.num_osds ?? cephStatus?.osdmap?.num_osds;
  const cephHealthy = cephStatus?.health?.status === 'HEALTH_OK';
  const cephWarn = cephStatus?.health?.status === 'HEALTH_WARN';
  // The actual reason, not just OK/WARN/ERR — Ceph's health.checks is an object
  // keyed by check name (e.g. "OSD_NEARFULL", "PG_DEGRADED"), each carrying a
  // human summary message. Without this, "warning" on its own tells the
  // operator nothing they can act on.
  const cephDetail = cephStatus?.health?.checks
    ? Object.values(cephStatus.health.checks).map((c) => c?.summary?.message).filter(Boolean).join('; ')
    : undefined;

  if (DEBUG) console.log(`[qentra-infra-agent] collectStorage: ${storages.length} storage def(s) from pvesh, cephStatus=${cephStatus ? 'present' : 'null'}`);

  for (const s of storages) {
    let type = 'other';
    if (s.type === 'rbd' || s.type === 'cephfs') type = 'ceph';
    else if (s.type === 'zfspool') type = 'zfs';
    else if (s.type === 'lvm' || s.type === 'lvmthin') type = 'lvm';
    else if (s.type === 'dir') type = 'dir';
    else if (s.type === 'nfs' || s.type === 'cifs') type = 'nfs';

    const pool = {
      name: s.storage,
      type,
      usedBytes: s.used ?? undefined,
      totalBytes: s.total ?? undefined,
      health: 'unknown',
    };
    if (type === 'ceph') {
      pool.health = cephHealthy ? 'healthy' : cephWarn ? 'warning' : cephStatus ? 'critical' : 'unknown';
      pool.cephOsdUp = cephOsdUp ?? undefined;
      pool.cephOsdTotal = cephOsdTotal ?? undefined;
      pool.healthDetail = cephDetail;
    } else if (type === 'zfs') {
      const scrub = zfsScrubState(s.storage);
      pool.zfsScrubState = scrub ?? undefined;
      pool.health = scrub && /errors: no known data errors/i.test(scrub) ? 'healthy' : scrub ? 'warning' : 'unknown';
      pool.healthDetail = scrub ?? undefined;
    } else {
      // Report even an inactive/unreachable storage def rather than hiding it —
      // "this storage is broken" is more useful than silence. Previously this
      // loop skipped anything with active !== 1, which could drop everything
      // if a node's storage.cfg entries don't carry that field the way we
      // assumed.
      pool.health = s.active === 0 ? 'critical' : 'healthy';
    }
    pools.push(pool);
  }
  return pools;
}

function postOnce(payload) {
  return new Promise((resolve) => {
    const url = new URL(`${URL_BASE}/api/ingest/proxmox`);
    const body = Buffer.from(JSON.stringify(payload));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Authorization: `Bearer ${TOKEN}`,
      },
      // Force IPv4 at the SOCKET level. dns.setDefaultResultOrder('ipv4first')
      // only reorders resolver results — Node can still open an IPv6 socket
      // (e.g. a AAAA that resolves first for a later connection), and on a
      // network with a broken/partial IPv6 route that surfaces as "Client
      // network socket disconnected before secure TLS connection was
      // established" every few cycles. family:4 guarantees IPv4 only, which is
      // the reliable path on these Proxmox hosts.
      family: 4,
      timeout: 15_000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (err) => { lastShipError = err.message; resolve(0); });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  });
}
let lastShipError = null;

// Ship with a few quick in-cycle retries so a single dropped TLS handshake
// (common on flaky office/uplink networks) doesn't cost the whole cycle. A 2xx
// wins immediately; otherwise back off briefly and retry, up to 3 attempts.
async function post(payload) {
  const delays = [0, 1500, 4000];
  let lastCode = 0;
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    lastCode = await postOnce(payload);
    if (lastCode >= 200 && lastCode < 300) return lastCode;
  }
  return lastCode;
}

let lastOk = null;
// Start optimistic (now, not 0) so a slow-but-healthy first boot isn't flagged
// stale before it's even had a chance to ship once.
let lastSuccessAt = Date.now();
async function collectAndShip() {
  try {
    const node = collectNode();
    const vms = collectVms();
    const storagePools = collectStorage();
    const code = await post({ node, vms, storagePools });
    lastOk = code >= 200 && code < 300;
    if (lastOk) lastSuccessAt = Date.now();
    else console.error(`[qentra-infra-agent] ingest failed after retries (HTTP ${code}${code === 0 && lastShipError ? `: ${lastShipError}` : ''})`);
  } catch (err) {
    lastOk = false;
    console.error('[qentra-infra-agent] collection failed:', err.message);
  }
}

// GET /healthz — simple liveness for systemd/monitoring.
http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(lastOk === false ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: lastOk !== false, version: VERSION, node: NODE_NAME }));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(HEALTH_PORT);

// Stuck-agent watchdog — see STALE_MIN above. Checked every 60s on its own
// timer (independent of collectAndShip) so it still fires even if a cycle is
// hung. Exits non-zero (a real failure, unlike the clean REFRESH_HOURS exit)
// so it's visible in `systemctl status` / journalctl as a genuine recovery.
if (STALE_MIN > 0) {
  setInterval(() => {
    const staleMs = Date.now() - lastSuccessAt;
    if (staleMs > STALE_MIN * 60_000) {
      console.error(`[qentra-infra-agent] no successful ingest in ${Math.round(staleMs / 60_000)}m (limit ${STALE_MIN}m) — self-restarting`);
      process.exit(1);
    }
  }, 60_000);
}

// Periodic self-restart — see REFRESH_HOURS above. Jittered up to 10% so a
// whole fleet installed at the same time doesn't cycle in lockstep later.
if (REFRESH_HOURS > 0) {
  const refreshMs = REFRESH_HOURS * 3600_000;
  const jitterMs = Math.random() * refreshMs * 0.1;
  setTimeout(() => {
    console.log(`[qentra-infra-agent] periodic refresh after ~${REFRESH_HOURS}h uptime — exiting cleanly for systemd to restart`);
    process.exit(0);
  }, refreshMs + jitterMs);
}

console.log(`[qentra-infra-agent] v${VERSION} starting — node=${NODE_NAME} cluster=${CLUSTER_OVERRIDE || '(auto)'} target=${URL_BASE} every ${COLLECT_MS / 1000}s${STALE_MIN > 0 ? `, watchdog restarts after ${STALE_MIN}m stuck` : ''}${REFRESH_HOURS > 0 ? `, self-refresh every ~${REFRESH_HOURS}h` : ''}`);
collectAndShip();
setInterval(collectAndShip, COLLECT_MS);

#!/usr/bin/env node
// Qentra Infrastructure Agent — runs directly on a Proxmox VE node (systemd
// service, root), NOT inside Kubernetes. Collects host/VM/storage state via
// `pvesh` (Proxmox's local CLI — always present, talks to pveproxy over a unix
// socket, no separate Proxmox API token to create) and ships a snapshot to
// Qentra every COLLECT_SECONDS. Pure Node stdlib, no npm deps — mirrors the
// Kubernetes agent's philosophy (tiny, near-zero footprint).
//
// READ-ONLY BY DESIGN — audit this file for exactly two kinds of external
// calls and nothing else:
//   1. `pvesh(path)` below, which ALWAYS runs `pvesh get ...` — never
//      `pvesh create/set/delete`. It cannot start, stop, migrate, snapshot,
//      or reconfigure anything. Grep for "execFileSync" to verify every call
//      site if you're reviewing this before installing it on production
//      hypervisors.
//   2. `zpool status` (read-only diagnostic; not `zpool scrub`/`create`/etc).
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
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const URL_BASE = (process.env.QENTRA_URL || 'https://crm.qentra.it.com').replace(/\/$/, '');
const TOKEN = process.env.QENTRA_TOKEN || '';
const NODE_NAME = process.env.NODE_NAME || os.hostname().split('.')[0];
const CLUSTER_OVERRIDE = process.env.PROXMOX_CLUSTER || '';
const COLLECT_MS = (Number(process.env.COLLECT_SECONDS) || 30) * 1000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 8081;
const VERSION = '0.1.0';

if (!TOKEN) {
  console.error('[qentra-infra-agent] QENTRA_TOKEN is required (an ApiToken with scope infra:write)');
  process.exit(1);
}

// Run `pvesh get <path> --output-format json` and parse it — READ-ONLY, always
// the `get` verb (see the file-header audit note). Returns null (never throws)
// so one missing/misconfigured subsystem (e.g. no Ceph) doesn't take down the
// whole collection cycle. A short timeout + ignored stdin keeps this from ever
// hanging or prompting — it cannot block pveproxy or wedge the node.
function pvesh(path) {
  try {
    const out = execFileSync('pvesh', ['get', path, '--output-format', 'json'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
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

function collectNode() {
  const status = pvesh(`/nodes/${NODE_NAME}/status`) || {};
  const cluster = pvesh('/cluster/status') || [];
  const clusterInfo = Array.isArray(cluster) ? cluster.find((c) => c.type === 'cluster') : null;
  const mem = status.memory || {};
  const cpu = typeof status.cpu === 'number' ? status.cpu * 100 : null;
  // The Qentra-facing cluster label: an explicit PROXMOX_CLUSTER wins (so an
  // org can name/scope clusters however it authorized its token), falling back
  // to what Proxmox itself reports, then "default" for a standalone node.
  const clusterName = CLUSTER_OVERRIDE || clusterInfo?.name || 'default';
  return {
    name: NODE_NAME,
    clusterName,
    quorate: clusterInfo ? !!clusterInfo.quorate : undefined,
    status: 'online',
    cpuUsedPct: cpu ?? undefined,
    cpuCores: status.cpuinfo?.cpus ?? undefined,
    memUsedBytes: mem.used ?? undefined,
    memTotalBytes: mem.total ?? undefined,
    uptimeSeconds: status.uptime ?? undefined,
    kernelVersion: status.kversion ?? undefined,
    pveVersion: status.pveversion ?? undefined,
    loadAvg: Array.isArray(status.loadavg) ? status.loadavg.map(Number) : undefined,
  };
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

  for (const s of storages) {
    if (s.active === 0) continue; // skip inactive/unreachable storage defs
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
    } else if (type === 'zfs') {
      const scrub = zfsScrubState(s.storage);
      pool.zfsScrubState = scrub ?? undefined;
      pool.health = scrub && /errors: no known data errors/i.test(scrub) ? 'healthy' : scrub ? 'warning' : 'unknown';
    } else {
      pool.health = 'healthy'; // active + reachable; no deeper health signal for lvm/dir/nfs yet
    }
    pools.push(pool);
  }
  return pools;
}

function post(payload) {
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
      timeout: 15_000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (err) => { console.error('[qentra-infra-agent] ship failed:', err.message); resolve(0); });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  });
}

let lastOk = null;
async function collectAndShip() {
  try {
    const node = collectNode();
    const vms = collectVms();
    const storagePools = collectStorage();
    const code = await post({ node, vms, storagePools });
    lastOk = code >= 200 && code < 300;
    if (!lastOk) console.error(`[qentra-infra-agent] ingest returned HTTP ${code}`);
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

console.log(`[qentra-infra-agent] v${VERSION} starting — node=${NODE_NAME} cluster=${CLUSTER_OVERRIDE || '(auto)'} target=${URL_BASE} every ${COLLECT_MS / 1000}s`);
collectAndShip();
setInterval(collectAndShip, COLLECT_MS);

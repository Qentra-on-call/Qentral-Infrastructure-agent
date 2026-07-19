# Qentra Infrastructure Agent

Reports Proxmox VE host, VM, and storage (Ceph/ZFS) state to
[Qentra](https://qentra.it.com) — the "physical/virtualization layer"
counterpart to Qentra's Kubernetes DaemonSet agent.

Runs directly on each Proxmox node as a systemd service (a Proxmox host
doesn't run Kubernetes, so this can't be a DaemonSet). Pure Node.js stdlib,
no npm dependencies — collects via `pvesh` (Proxmox's built-in local CLI, so
there's no separate Proxmox API token to create) and ships a snapshot every
30 seconds.

## Install

On each Proxmox node, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Qentra-on-call/Qentral-Infrastructure-agent/main/install.sh \
  | QENTRA_TOKEN=<your infra:write token> bash
```

Create the token in Qentra under **CLI → API tokens**, scope `infra:write`.

This installs the agent to `/opt/qentra-infra-agent`, its config to
`/etc/qentra-infra-agent/env`, and registers/starts the
`qentra-infra-agent` systemd service.

## What it collects

- **Host**: cluster name + quorum, CPU/memory usage, uptime, kernel/PVE
  version, load average.
- **VMs** (QEMU + LXC): status, CPU/memory/disk usage, uptime.
- **Storage**: Ceph pools (health, OSD up/total) and ZFS pools (scrub
  state), plus capacity for other storage types (LVM/dir/NFS).

This is a point-in-time snapshot on every collection cycle, not a full
metrics time series — trend history is a possible future addition.

## Configuration

Edit `/etc/qentra-infra-agent/env` and `systemctl restart
qentra-infra-agent`:

| Variable | Default | Description |
|---|---|---|
| `QENTRA_URL` | `https://crm.qentra.it.com` | Qentra API base (only override when self-hosting) |
| `QENTRA_TOKEN` | *(required)* | ApiToken with scope `infra:write` |
| `NODE_NAME` | this node's short hostname | Proxmox node name as seen in `pvesh` paths |
| `COLLECT_SECONDS` | `30` | How often to collect + ship |
| `HEALTH_PORT` | `8081` | Local `GET /healthz` port |

## Uninstall

```bash
systemctl disable --now qentra-infra-agent
rm -rf /opt/qentra-infra-agent /etc/qentra-infra-agent /etc/systemd/system/qentra-infra-agent.service
systemctl daemon-reload
```

## Status

v0.1.0 — host/VM inventory + Ceph/ZFS storage health. See the
[Qentra Infrastructure Platform spec](https://qentra.it.com) for the
longer-term roadmap (NUMA, SMART, live-migration tracking, predictive
failure detection, correlation with the Kubernetes agent, and more).

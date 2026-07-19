#!/usr/bin/env bash
# Installs the Qentra Infrastructure Agent as a systemd service on a Proxmox VE
# node. Run as root on the node itself:
#
#   curl -fsSL https://raw.githubusercontent.com/Qentra-on-call/Qentral-Infrastructure-agent/main/install.sh \
#     | QENTRA_TOKEN=<your infra:write token> bash
#
# Optional env vars (same defaults as the agent):
#   QENTRA_URL        default https://crm.qentra.it.com
#   NODE_NAME         default: this node's short hostname
#   COLLECT_SECONDS   default 30
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/Qentra-on-call/Qentral-Infrastructure-agent/main"
INSTALL_DIR="/opt/qentra-infra-agent"
CONF_DIR="/etc/qentra-infra-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (needed for pvesh/zpool access and the systemd unit)." >&2
  exit 1
fi

if [ -z "${QENTRA_TOKEN:-}" ]; then
  echo "QENTRA_TOKEN is required — create an ApiToken with scope infra:write in Qentra (CLI -> API tokens) and re-run:" >&2
  echo "  QENTRA_TOKEN=<token> bash install.sh" >&2
  exit 1
fi

if ! command -v pvesh >/dev/null 2>&1; then
  echo "pvesh not found — this doesn't look like a Proxmox VE node. Aborting." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js (nodejs, via apt)..." >&2
  apt-get update -qq && apt-get install -y -qq nodejs
fi

mkdir -p "$INSTALL_DIR" "$CONF_DIR"
curl -fsSL "$REPO_RAW/agent.js" -o "$INSTALL_DIR/agent.js"
curl -fsSL "$REPO_RAW/package.json" -o "$INSTALL_DIR/package.json"

cat > "$CONF_DIR/env" <<EOF
QENTRA_URL=${QENTRA_URL:-https://crm.qentra.it.com}
QENTRA_TOKEN=${QENTRA_TOKEN}
NODE_NAME=${NODE_NAME:-$(hostname -s)}
COLLECT_SECONDS=${COLLECT_SECONDS:-30}
EOF
chmod 600 "$CONF_DIR/env"

curl -fsSL "$REPO_RAW/qentra-infra-agent.service" -o /etc/systemd/system/qentra-infra-agent.service

systemctl daemon-reload
systemctl enable --now qentra-infra-agent

echo
echo "Qentra Infrastructure Agent installed and started."
echo "Check status:  systemctl status qentra-infra-agent"
echo "Check logs:    journalctl -u qentra-infra-agent -f"
echo "Health check:  curl -s http://localhost:8081/healthz"

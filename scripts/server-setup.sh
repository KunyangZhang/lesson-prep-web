#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_SMOKE=0
INSTALL_DEV=0
START_AFTER=0

for arg in "$@"; do
  case "$arg" in
    --smoke)
      RUN_SMOKE=1
      INSTALL_DEV=1
      ;;
    --dev)
      INSTALL_DEV=1
      ;;
    --start)
      START_AFTER=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/server-setup.sh [--smoke] [--dev] [--start]

Options:
  --smoke   Install dev dependencies and run npm run smoke with temporary data.
  --dev     Install dev dependencies with npm ci.
  --start   Run npm start after checks pass. For production, systemd is recommended.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

step() {
  printf '\n==> %s\n' "$1"
}

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

step "Checking runtime"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node 20+ first."
command -v npm >/dev/null 2>&1 || fail "npm is not installed."
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $(node --version) is too old. Use Node 20+."
fi
echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

step "Preparing .env"
if [ ! -f .env ]; then
  cp deploy/env.production.example .env
  echo "Created .env from deploy/env.production.example"
  echo "Edit .env before public production use: nano .env"
else
  echo ".env already exists"
fi

step "Installing dependencies"
if [ "$INSTALL_DEV" -eq 1 ]; then
  npm ci
else
  npm ci --omit=dev
fi

step "Building application"
npm run build

step "Running deploy checks"
npm run deploy:check

if [ "$RUN_SMOKE" -eq 1 ]; then
  step "Running smoke test"
  npm run smoke
else
  echo
  echo "Skip smoke test. Run this later if needed:"
  echo "  bash scripts/server-setup.sh --smoke"
fi

echo
echo "After Codex CLI is installed and logged in on this server, run a real Codex smoke test:"
echo "  npm run codex:smoke"

step "Next production steps"
cat <<'EOF'
Health check after start:
  curl http://127.0.0.1:${PORT:-4178}/api/health

Recommended long-running service:
  1. Edit deploy/systemd/lesson-prep-web.service.example
  2. Copy it to /etc/systemd/system/lesson-prep-web.service
  3. Run:
     sudo systemctl daemon-reload
     sudo systemctl enable --now lesson-prep-web
     sudo systemctl status lesson-prep-web

Nginx reverse proxy example:
  deploy/nginx/lesson-prep-web.conf.example

Before exposing publicly, set HTTPS and strong auth-related values in .env:
  SECURE_COOKIES=true
  TRUST_PROXY=true
  ENABLE_HSTS=true
EOF

if [ "$START_AFTER" -eq 1 ]; then
  step "Starting app"
  npm start
fi

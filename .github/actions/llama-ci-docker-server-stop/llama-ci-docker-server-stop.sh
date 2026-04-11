#!/usr/bin/env bash
# Remove llama-server container started by llama-ci-docker-server-start.
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-auto-pr-llama}"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

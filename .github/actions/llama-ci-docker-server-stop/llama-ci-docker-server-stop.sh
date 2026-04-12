#!/usr/bin/env bash
# Remove llama-server container started by llama-ci-docker-server-start.
set -euo pipefail

docker rm -f auto-pr-llama 2>/dev/null || true

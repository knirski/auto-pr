#!/usr/bin/env bash
# Print one free TCP port (kernel-assigned via bind to :0).
set -euo pipefail
python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'

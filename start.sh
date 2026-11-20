#!/bin/sh
# Run the local agent communications network (no pip / npm installation).
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec python3 phone/start.py "$@"

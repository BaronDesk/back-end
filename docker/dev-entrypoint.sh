#!/bin/sh
set -e

# Runs on every container start. Cheap, idempotent, and it writes into the
# bind-mounted source tree — so your editor on the host gets the types too.
echo "→ prisma generate"
npx prisma generate

exec "$@"
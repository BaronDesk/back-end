#!/bin/sh
set -e

echo "Testing Hello World..."
curl -s localhost:3000

echo "Checking health..."
curl -s localhost:3000/health | jq

echo "Checking commands..."
curl -s localhost:3000/ops/commands/counts | jq

echo "Posting command..."
curl -s -X POST localhost:3000/ops/commands \
  -H 'content-type: application/json' \
  -d '{"machineId":"m-001","type":"ping","payload":{}}' | jq

echo "Check http://localhost:3000/docs for endpoints"

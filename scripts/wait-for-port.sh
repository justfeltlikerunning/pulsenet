#!/bin/bash
# Kill any process on port 3000
/usr/bin/fuser -k 3000/tcp 2>/dev/null || true
# Wait up to 10 seconds for port to actually free
for i in {1..20}; do
  if ! /usr/bin/fuser 3000/tcp >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.5
done
echo 'WARNING: port 3000 still in use after 10s'
exit 1

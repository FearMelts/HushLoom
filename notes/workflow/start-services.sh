#!/bin/sh
# Restart local Postgres and Redis after a container restart (idempotent).
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/claude/.pgdata status" >/dev/null 2>&1 || \
  su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/claude/.pgdata -o '-k /tmp -p 5432' -l /home/claude/.pgdata/server.log start"
redis-cli ping >/dev/null 2>&1 || { mkdir -p /home/claude/.redis-data; redis-server --daemonize yes --dir /home/claude/.redis-data >/dev/null; }
sleep 1; redis-cli ping; psql -h localhost -U playbox -d postgres -tAc "select 'pg ok'"

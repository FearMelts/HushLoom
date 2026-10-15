set -o pipefail
cd /home/claude/clean-verify
echo "== node $(node -v) npm $(npm -v) at $(git rev-parse --short HEAD) $(date -u +%FT%TZ)"
echo "== npm ci"; npm ci --no-audit --no-fund 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"
echo "== typecheck"; npm run typecheck 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"
echo "== lint"; npm run lint 2>&1 | tail -2; echo "exit ${PIPESTATUS[0]}"
echo "== vitest"; TEST_DATABASE_URL=postgres://playbox@localhost:5432/playbox_test_clean TEST_REDIS_URL=redis://localhost:6379/0 STORAGE_LOCAL_DIR=.storage-test-clean npx vitest run 2>&1 | tail -6; echo "exit ${PIPESTATUS[0]}"
echo "== next build"; NODE_ENV=production APP_ENV=test MEDIA_SIGNING_SECRET=$(openssl rand -hex 32) STORAGE_LOCAL_DIR=/tmp/clean-storage npx next build 2>&1 | tail -15; echo "exit ${PIPESTATUS[0]}"
echo "== done $(date -u +%FT%TZ)"

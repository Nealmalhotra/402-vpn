VULTR_HOST="149.248.44.237" \
VULTR_USER="root" \
VULTR_APP_DIR="/root/402-vpn" \
REDIS_URL="redis://6.tcp.us-cal-1.ngrok.io:17781" \
REGIONAL_PROXY_SHARED_SECRET="supersecret123" \
bash <<'EOF'
set -euo pipefail

VULTR_HOST="149.248.44.237"
VULTR_USER="root"
REDIS_URL="redis://6.tcp.us-cal-1.ngrok.io:17781"
REGION_ID="us-west"
SECRET="supersecret123"
LOCAL_API_PORT="3010"

echo "==> 2) Verify remote health"
ssh "$VULTR_USER@$VULTR_HOST" "curl -fsS http://127.0.0.1:3001/health && echo"

echo "==> 3) Set region proxy_url in Redis"
REDIS_URL="$REDIS_URL" REGION_ID="$REGION_ID" VULTR_HOST="$VULTR_HOST" node --input-type=module -e '
import Redis from "ioredis";
const r = new Redis(process.env.REDIS_URL);
await r.hset(`region:${process.env.REGION_ID}`, { proxy_url: `http://${process.env.VULTR_HOST}:3001/regional/fetch` });
console.log(await r.hgetall(`region:${process.env.REGION_ID}`));
await r.quit();
'

echo "==> 4) Start local API + billing"
REDIS_URL="$REDIS_URL" API_PORT="$LOCAL_API_PORT" X402_ENABLED=false ALLOW_LOCAL_PROXY_FALLBACK=false REGIONAL_PROXY_SHARED_SECRET="$SECRET" npm run start:api >/tmp/402vpn-local-api.log 2>&1 &
API_PID=$!
REDIS_URL="$REDIS_URL" npm run start:billing >/tmp/402vpn-local-billing.log 2>&1 &
BILL_PID=$!

trap 'kill $API_PID $BILL_PID 2>/dev/null || true' EXIT

echo "==> 5) Wait local API health"
for i in {1..30}; do
  curl -fsS "http://127.0.0.1:3010/health" >/dev/null && break
  sleep 1
done
curl -fsS "http://127.0.0.1:3010/health" >/dev/null

BASE="http://127.0.0.1:3010"

echo "==> 6) Create proxy session"
CREATE=$(curl -sS -X POST "$BASE/session/create" \
  -H "content-type: application/json" \
  -d "{\"region\":\"$REGION_ID\",\"minutes\":10,\"mode\":\"proxy\"}")
echo "$CREATE" | jq .
TOKEN=$(echo "$CREATE" | jq -r '.token')
SID=$(echo "$CREATE" | jq -r '.session_id')

echo "==> 7) /fetch via Vultr regional proxy"
FETCH=$(curl -sS -X POST "$BASE/fetch" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"https://httpbin.org/get","method":"GET"}')
echo "$FETCH" | jq .
echo "origin: $(echo "$FETCH" | jq -r '.body | fromjson | .origin')"

echo "✅ done. session=$SID"
EOF
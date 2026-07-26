#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# v3.3 "Ingress" — happy-path test script
# ─────────────────────────────────────────────────────────────────
# Usage:
#   ./test_ingress.sh <projectId>
# If projectId is not passed, the script will pick the first project
# from GET /api/projects.
#
# Requires: curl, jq
# ─────────────────────────────────────────────────────────────────

set -e

BASE_URL="${TASKREAPER_URL:-http://localhost:3000}"
PROJECT_ID="${1:-}"

echo "── TaskReaper Ingress Test ──"
echo "  Server: $BASE_URL"

# Discover projectId if not supplied
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(curl -s "$BASE_URL/api/projects" | jq -r '.projects[0].id // empty')
  if [ -z "$PROJECT_ID" ]; then
    echo "❌ No projects found. Create one in the UI first, then re-run."
    exit 1
  fi
  echo "  Auto-selected project: $PROJECT_ID"
else
  echo "  Project: $PROJECT_ID"
fi

# ── Step 1: Fetch the ingress token ──
echo
echo "▶ Fetching ingress token..."
TOKEN_RESP=$(curl -s "$BASE_URL/api/projects/$PROJECT_ID/ingress-token")
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.ingressToken // empty')

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token. Response:"
  echo "$TOKEN_RESP" | jq .
  exit 1
fi
echo "  Token: ${TOKEN:0:12}… (truncated)"

# ── Step 2: Post a single task ──
echo
echo "▶ Test 1: POST a single task..."
RESP=$(curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Test ingress: fix the login button alignment",
    "agent": "cline",
    "metadata": {
      "source": "test_ingress.sh",
      "priority": "low"
    }
  }')

echo "$RESP" | jq .
SUCCESS=$(echo "$RESP" | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
  echo "❌ Single-task ingest failed."
  exit 1
fi
echo "✅ Single task accepted."

# ── Step 3: Post a batch of tasks ──
echo
echo "▶ Test 2: POST a batch of 3 tasks..."
RESP=$(curl -s -X POST "$BASE_URL/api/projects/$PROJECT_ID/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      { "prompt": "Batch task A" },
      { "prompt": "Batch task B", "agent": "aider" },
      { "prompt": "Batch task C", "orchestrate": true }
    ]
  }')

echo "$RESP" | jq .
COUNT=$(echo "$RESP" | jq -r '.count')
if [ "$COUNT" != "3" ]; then
  echo "❌ Expected 3 tasks, got $COUNT."
  exit 1
fi
echo "✅ Batch of 3 accepted."

# ── Step 4: Auth failure (missing token) ──
echo
echo "▶ Test 3: Auth failure — no Bearer header (expect 401)..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/projects/$PROJECT_ID/ingest" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"should be rejected"}')
if [ "$CODE" != "401" ]; then
  echo "❌ Expected 401, got $CODE."
  exit 1
fi
echo "✅ Correctly rejected with 401."

# ── Step 5: Auth failure (wrong token) ──
echo
echo "▶ Test 4: Auth failure — wrong token (expect 401)..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/projects/$PROJECT_ID/ingest" \
  -H "Authorization: Bearer wrong_token_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"should be rejected"}')
if [ "$CODE" != "401" ]; then
  echo "❌ Expected 401, got $CODE."
  exit 1
fi
echo "✅ Correctly rejected with 401."

# ── Step 6: Validation failure (missing prompt) ──
echo
echo "▶ Test 5: Validation failure — missing prompt (expect 400)..."
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/projects/$PROJECT_ID/ingest" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"cline"}')
if [ "$CODE" != "400" ]; then
  echo "❌ Expected 400, got $CODE."
  exit 1
fi
echo "✅ Correctly rejected with 400."

# ── Step 7: Verify tasks made it into the project ──
echo
echo "▶ Test 6: Verify tasks landed on the board..."
TASK_COUNT=$(curl -s "$BASE_URL/api/project/$PROJECT_ID/tasks" | jq '.tasks | length')
echo "  Project now has $TASK_COUNT total tasks."

echo
echo "🎉 All ingress tests passed!"
echo "   Open the TaskReaper UI and check the '$PROJECT_ID' project's kanban board."

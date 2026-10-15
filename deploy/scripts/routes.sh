#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Creates or removes the waiting room routes through the Cloudflare API.
# Requires curl and jq. The settings come from a config file (default
# deploy/routes.env, copy of deploy/routes.env.example); variables already set in
# the environment are used when the file does not set them (keep secrets there).
#
#   CLOUDFLARE_API_TOKEN  token with the Workers Routes > Edit permission on the zone. wrangler
#                  reads the same variable and prefers it to `wrangler login`: export it only
#                  for this script, or give the token the Workers Scripts permission too.
#   ZONE_ID        zone identifier
#   HOSTS          space-separated hostnames            e.g. "shop.example.com"
#   PROTECTED      space-separated path patterns        default "/*"
#   EXCLUDED       space-separated path patterns        e.g. "/static/* /api/* /webhooks/*"
#   SCRIPT         Worker name                          default "waitingroom"
#   PREFLIGHT_URL  https://<operator host>/__wr/admin/v1/preflight, checked by `apply`
#   WR_ADMIN_TOKEN admin token, for the preflight call
#   SKIP_PREFLIGHT set to 1 to create the routes without the check (not recommended)
#
# Usage: routes.sh plan | apply | delete [config file]
#   plan    prints what apply would do (create, update a route pointing elsewhere, nothing)
#   apply   checks that the Worker is ready (preflight), then converges the routes listed by
#           HOSTS/PROTECTED/EXCLUDED: missing ones are created, drifted ones updated (idempotent)
#   delete  removes those routes only, and only when they still point where this script put them
#           (rollback); other routes of the zone, even to SCRIPT, are left untouched
# Patterns and scripts are compared exactly (jq), never as regular expressions.
# The verified-bot Transform Rules are created by hand (docs/routing.md#verified-bots).
set -euo pipefail
# Command substitutions stop on errors too (bash >= 4.4).
shopt -s inherit_errexit
# Route patterns such as "/*" must never be expanded against the local filesystem.
set -f

CONFIG="${2:-$(dirname "$0")/../routes.env}"
if [ -f "$CONFIG" ]; then
  # shellcheck source=/dev/null
  set -a; . "$CONFIG"; set +a
elif [ -n "${2:-}" ]; then
  echo "config file not found: $CONFIG" >&2; exit 2
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CF_API_TOKEN:-}" ]; then
  echo "CF_API_TOKEN is deprecated, use CLOUDFLARE_API_TOKEN" >&2
  CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
fi
: "${CLOUDFLARE_API_TOKEN:?}" "${ZONE_ID:?}" "${HOSTS:?}"
PROTECTED="${PROTECTED:-/*}"
EXCLUDED="${EXCLUDED:-}"
SCRIPT="${SCRIPT:-waitingroom}"
API="https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes"

# Cloudflare API call: prints the response body, or explains the error and fails.
api() {
  local out code
  out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "$@")" \
    || { echo "Cloudflare API unreachable" >&2; return 1; }
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then printf '%s\n' "$out"; return; fi
  echo "Cloudflare API error, HTTP ${code}: $(jq -r '[.errors[]? | "\(.message) [code \(.code)]"] | join("; ")' <<<"$out" 2>/dev/null || printf '%s' "$out")" >&2
  case "$code" in
    401|403|404)
      echo "Check ZONE_ID (${ZONE_ID}): it is NOT the account ID shown in the dashboard URL" >&2
      echo "(dash.cloudflare.com/<account ID>/...). Open your domain > Overview: Zone ID is in the right column, under API." >&2
      echo "Then check CLOUDFLARE_API_TOKEN: Workers Routes > Edit, with this zone in Zone Resources." >&2
      ;;
  esac
  return 1
}

# Inventory managed by this script: [{pattern, script}] (script null: route without Worker).
wanted() {
  for h in $HOSTS; do
    printf '%s\t%s\n' "${h}/__wr/*" "$SCRIPT"
    for p in $PROTECTED; do printf '%s\t%s\n' "${h}${p}" "$SCRIPT"; done
    for p in $EXCLUDED; do printf '%s\t\n' "${h}${p}"; done
  done | jq -Rn '[inputs | split("\t") | {pattern: .[0], script: (if .[1] == "" then null else .[1] end)}] | unique_by(.pattern)'
}

existing() {
  local out
  out="$(api "$API")" || return 1
  jq '[.result[] | {id, pattern, script: (.script // null)}]' <<<"$out"
}

# One action per wanted route: create, update (same pattern, other script) or ok.
actions() {
  jq -n --argjson want "$WANT" --argjson have "$HAVE" '
    $want[] as $w
    | ([$have[] | select(.pattern == $w.pattern)] | first) as $e
    | if $e == null then {op: "create", pattern: $w.pattern, script: $w.script}
      elif $e.script != $w.script then {op: "update", id: $e.id, pattern: $w.pattern, script: $w.script, was: $e.script}
      else {op: "ok", pattern: $w.pattern, script: $w.script} end'
}

body() { jq -nc --arg p "$1" --argjson s "$2" 'if $s == null then {pattern: $p} else {pattern: $p, script: $s} end'; }

# Where to find the result in the Cloudflare dashboard.
where() {
  cat <<EOT

In the Cloudflare dashboard:
  - every route of the zone, including those without a Worker (excluded paths):
      your domain > Workers Routes (left menu)
  - the routes that run the Worker:
      Workers & Pages > ${SCRIPT} > Settings > Domains & Routes
  - the optional verified-bot rules (not managed by this script):
      your domain > Rules > Transform Rules > Modify Request Header
EOT
}

# Refuses to route traffic to a Worker whose room id, keys, fail mode or coordinator are not ready.
preflight() {
  if [ "${SKIP_PREFLIGHT:-}" = "1" ]; then echo "preflight skipped (SKIP_PREFLIGHT=1)" >&2; return; fi
  : "${PREFLIGHT_URL:?set PREFLIGHT_URL, or SKIP_PREFLIGHT=1}" "${WR_ADMIN_TOKEN:?}"
  local body
  body="$(curl -sS -H "Authorization: Bearer ${WR_ADMIN_TOKEN}" "$PREFLIGHT_URL")" || { echo "preflight: request failed, routes not created" >&2; exit 1; }
  if [ "$(jq -r '.ok // false' <<<"$body" 2>/dev/null)" != "true" ]; then
    echo "preflight failed, routes not created: ${body}" >&2
    exit 1
  fi
  echo "preflight ok: $(jq -c '{room, failMode, coordinator}' <<<"$body")"
}

case "${1:-plan}" in
  plan|apply|delete) ;;
  *) echo "usage: $0 plan|apply|delete [config file]" >&2; exit 2 ;;
esac
if [ "${1:-plan}" = "apply" ]; then preflight; fi
# Computed here, not inside pipelines, so that an API error stops the script before any change.
WANT="$(wanted)"
HAVE="$(existing)"

case "${1:-plan}" in
  plan)
    echo "PLAN ONLY: nothing is changed. What \`apply\` would do on zone ${ZONE_ID}:"
    echo
    PLAN="$(actions | jq -sr '.[] | (if .op == "create" then "  would create " elif .op == "update" then "  would update " else "  unchanged    " end)
      + "\(.pattern) -> \(.script // "(no Worker)")"
      + (if .op == "update" then " (currently \(.was // "no Worker"))" else "" end)')"
    echo "$PLAN"
    echo
    if grep -q "would " <<<"$PLAN"; then
      echo "Nothing was changed. To apply: $0 apply ${2:-}"
    else
      echo "Nothing to do: the zone already matches the config."
    fi
    exit 0
    ;;
  apply)
    actions | jq -c '.' | while read -r a; do
      op="$(jq -r .op <<<"$a")"
      pattern="$(jq -r .pattern <<<"$a")"
      script="$(jq -c .script <<<"$a")"
      case "$op" in
        ok) echo "ok      ${pattern}" ;;
        create) api -X POST "$API" -d "$(body "$pattern" "$script")" >/dev/null; echo "created ${pattern}" ;;
        update) api -X PUT "${API}/$(jq -r .id <<<"$a")" -d "$(body "$pattern" "$script")" >/dev/null; echo "updated ${pattern}" ;;
      esac
    done
    ;;
  delete)
    jq -n --argjson want "$WANT" --argjson have "$HAVE" -c '
      $have[] as $e | $want[] | select(.pattern == $e.pattern)
      | {id: $e.id, pattern: $e.pattern, ours: (.script == $e.script)}' | while read -r a; do
      pattern="$(jq -r .pattern <<<"$a")"
      if [ "$(jq -r .ours <<<"$a")" != "true" ]; then echo "skipped ${pattern} (points elsewhere)"; continue; fi
      api -X DELETE "${API}/$(jq -r .id <<<"$a")" >/dev/null
      echo "deleted ${pattern}"
    done
    ;;
esac
where

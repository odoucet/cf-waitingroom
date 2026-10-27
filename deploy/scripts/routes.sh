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
#                  When unset, the OAuth token of the `wrangler login` session is used
#                  (`wrangler auth token`, never printed).
#   ZONE_ID        zone identifier
#   HOSTS          space-separated hostnames            e.g. "shop.example.com"
#   PROTECTED      space-separated path patterns        default "/*"
#   EXCLUDED       space-separated path patterns        e.g. "/static/* /api/* /webhooks/*"
#   SCRIPT         Worker name                          default "waitingroom"
#   PREFLIGHT_URL  https://<operator host>/__wr/admin/v1/preflight, checked by `apply`
#   WR_ADMIN_TOKEN admin token, for the preflight call and the whitelist
#   SKIP_PREFLIGHT set to 1 to create the routes without the check (not recommended)
#   WHITELIST      space-separated "cidr=label" entries  e.g. "198.51.100.0/24=office 203.0.113.7=probe"
#   WHITELIST_PRUNE set to 1 to also remove the whitelist entries missing from WHITELIST
#                  (otherwise entries added from the dashboard or the admin API are kept)
#   ADMIN_URL      https://<operator host>/__wr/admin/v1   default: PREFLIGHT_URL without /preflight
#
# Usage: routes.sh plan | apply | delete [config file]
#   plan    prints what apply would do (create, update a route pointing elsewhere, nothing)
#   apply   checks that the Worker is ready (preflight), converges the whitelist when WHITELIST
#           or WHITELIST_PRUNE is set, then converges the routes listed by
#           HOSTS/PROTECTED/EXCLUDED: missing ones are created, drifted ones updated (idempotent)
#   delete  removes those routes only, and only when they still point where this script put them
#           (rollback); other routes of the zone, even to SCRIPT, are left untouched; the whitelist
#           is left untouched
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
# The `wrangler login` session has the workers_routes:write scope. Run from the repository so the
# project's wrangler is used; the token is kept in this shell only.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN="$(cd "$(dirname "$0")/../.." && npx --no-install wrangler auth token 2>/dev/null | tail -n 1 | tr -d '[:space:]')" \
    || CLOUDFLARE_API_TOKEN=""
  if ! [[ "$CLOUDFLARE_API_TOKEN" =~ ^[A-Za-z0-9._-]{20,}$ ]]; then
    echo "no CLOUDFLARE_API_TOKEN, and no usable \`wrangler login\` session (npx wrangler login, or export the token)" >&2
    exit 2
  fi
  echo "using the OAuth token of the wrangler session" >&2
fi
: "${ZONE_ID:?}" "${HOSTS:?}"
PROTECTED="${PROTECTED:-/*}"
EXCLUDED="${EXCLUDED:-}"
SCRIPT="${SCRIPT:-waitingroom}"
WHITELIST="${WHITELIST:-}"
ADMIN_URL="${ADMIN_URL:-${PREFLIGHT_URL:+${PREFLIGHT_URL%/preflight}}}"
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

# Admin API call of the Worker: prints the response body, or explains the error and fails.
admin() {
  local out code
  out="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer ${WR_ADMIN_TOKEN}" -H "Content-Type: application/json" "$@")" \
    || { echo "admin API unreachable (ADMIN_URL=${ADMIN_URL})" >&2; return 1; }
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then printf '%s\n' "$out"; return; fi
  echo "admin API error, HTTP ${code}: $(jq -r '.error // empty' <<<"$out" 2>/dev/null || printf '%s' "$out")" >&2
  case "$code" in
    401) echo "Check WR_ADMIN_TOKEN: same value as the Worker secret." >&2 ;;
    404) echo "Check ADMIN_URL (${ADMIN_URL}): an operator hostname (ADMIN_HOSTS), ending in /__wr/admin/v1." >&2 ;;
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

wl_managed() { [ -n "$WHITELIST" ] || [ "${WHITELIST_PRUNE:-}" = "1" ]; }

# Whitelist managed by this script: [{cidr, label}] (labels cut to 64 characters, like the Worker).
wl_wanted() {
  for e in $WHITELIST; do printf '%s\n' "$e"; done \
    | jq -Rn '[inputs | capture("^(?<cidr>[^=]+)(=(?<label>.*))?$") | {cidr, label: ((.label // "")[0:64])}] | unique_by(.cidr)'
}

# One action per entry: add, update (other label), ok, and for entries missing from WHITELIST,
# remove (WHITELIST_PRUNE=1) or keep.
wl_actions() {
  jq -n --argjson want "$WL_WANT" --argjson have "$WL_HAVE" --arg prune "${WHITELIST_PRUNE:-}" '
    ($want[] as $w
      | ([$have[] | select(.cidr == $w.cidr)] | first) as $e
      | if $e == null then {op: "add", cidr: $w.cidr, label: $w.label}
        elif $e.label != $w.label then {op: "update", cidr: $w.cidr, label: $w.label, was: $e.label}
        else {op: "ok", cidr: $w.cidr, label: $w.label} end),
    ($have[] | . as $e | select(all($want[]; .cidr != $e.cidr))
      | {op: (if $prune == "1" then "remove" else "keep" end), cidr, label})'
}

# One POST for the additions and label changes, one DELETE for the removals.
wl_apply() {
  local add del
  add="$(jq -c '[.[] | select(.op == "add" or .op == "update") | {cidr, label}]' <<<"$WL")"
  del="$(jq -c '[.[] | select(.op == "remove") | .cidr]' <<<"$WL")"
  if [ "$add" != "[]" ]; then admin -X POST "${ADMIN_URL}/whitelist" -d "{\"entries\":${add}}" >/dev/null; fi
  if [ "$del" != "[]" ]; then admin -X DELETE "${ADMIN_URL}/whitelist" -d "{\"cidrs\":${del}}" >/dev/null; fi
  jq -r '.[] | {add: "whitelisted ", update: "relabeled   ", ok: "ok          ", remove: "unlisted    ", keep: "kept        "}[.op]
    + "\(.cidr) (\(.label))" + (if .op == "keep" then ", not in WHITELIST" else "" end)' <<<"$WL"
}

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
# Whitelist actions; plan compares only when the admin token is there, apply requires it.
WL="[]"
if [ "${1:-plan}" != "delete" ] && wl_managed && { [ "${1:-plan}" = "apply" ] || [ -n "${WR_ADMIN_TOKEN:-}" ]; }; then
  : "${ADMIN_URL:?set ADMIN_URL or PREFLIGHT_URL to manage the whitelist}" "${WR_ADMIN_TOKEN:?}"
  WL_WANT="$(wl_wanted)"
  WL_HAVE="$(admin "${ADMIN_URL}/whitelist")"
  WL="$(wl_actions | jq -s '.')"
fi

case "${1:-plan}" in
  plan)
    echo "PLAN ONLY: nothing is changed. What \`apply\` would do on zone ${ZONE_ID}:"
    echo
    PLAN="$(actions | jq -sr '.[] | (if .op == "create" then "  would create " elif .op == "update" then "  would update " else "  unchanged    " end)
      + "\(.pattern) -> \(.script // "(no Worker)")"
      + (if .op == "update" then " (currently \(.was // "no Worker"))" else "" end)')"
    if wl_managed; then
      if [ -z "${WR_ADMIN_TOKEN:-}" ]; then
        PLAN+=$'\n\n'"  whitelist not compared: export WR_ADMIN_TOKEN"
      else
        PLAN+=$'\n\n'"$(jq -r '.[] | {add: "  would whitelist ", update: "  would relabel   ", ok: "  unchanged       ", remove: "  would unlist    ", keep: "  kept            "}[.op]
          + "\(.cidr) (\(.label))"
          + (if .op == "update" then " (currently \(.was))" elif .op == "keep" then ", not in WHITELIST" else "" end)' <<<"$WL")"
      fi
    fi
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
    # Before the routes, so that whitelisted addresses never wait.
    if wl_managed; then wl_apply; echo; fi
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

#!/usr/bin/env bash
# Poll until the @facthouse/mcp tarball for one version returns HTTP 200.
#
# The verify job installs npm@latest before this probe. That is npm 12 on
# current runners, and npm 12 always prints `npm view --json` as an array,
# including when one version matches. npm 10 (the npm that ships with Node 22,
# and the npm that prints a single object for this query locally) does not.
# A jq filter that keeps only type == "object" therefore drops the runner's
# payload. The tarball variable stays empty, curl is skipped, and the log is
# "dist.tarball HTTP 000" about a second later. Both streams were sent to
# /dev/null, so the successful npm view looked like a registry miss.
#
# Read either JSON shape. When that still yields no https URL, request the
# registry path for this package:
#   https://registry.npmjs.org/@facthouse/mcp/-/mcp-<version>.tgz
# npm's stderr from the last failed probe is printed. Earlier probes stay quiet.
#
# Usage: wait_for_npm_tarball.sh VERSION MAX_WAIT_SECONDS
# Writes resolved= and waited= to GITHUB_OUTPUT when that variable is set.
# `sleep` and `npm` and `curl` are the commands on PATH.

set -euo pipefail

# shellcheck disable=SC2016 # jq uses $want; the program must not expand in bash.
JQ_FILTER='
def url_of:
  if type == "string" then .
  elif type == "object" then (.["dist.tarball"] // .dist.tarball // empty)
  else empty end;
if type == "string" then .
elif type == "object" then (url_of // empty)
elif type == "array" then
  (
    ([.[] | select(type == "object" and .version == $want) | url_of | select(type == "string" and . != "")] | .[0])
    //
    ([.[] | url_of | select(type == "string" and . != "")] | .[0])
    // empty
  )
else empty end
'

canonical_tarball_url() {
  printf 'https://registry.npmjs.org/@facthouse/mcp/-/mcp-%s.tgz\n' "$1"
}

# Seconds to sleep before the next probe. The interval is 30s, shortened so
# the sleep cannot run past the deadline.
poll_sleep_seconds() {
  local left="$1"
  local interval=30
  if [ "$left" -le 0 ]; then
    echo 0
    return
  fi
  if [ "$interval" -gt "$left" ]; then
    echo "$left"
  else
    echo "$interval"
  fi
}

# Curl --max-time for one probe. Cap at 20s, and at whatever time is left.
curl_max_seconds() {
  local left="$1"
  local cap=20
  if [ "$left" -lt 0 ]; then
    echo 0
  elif [ "$left" -lt "$cap" ]; then
    echo "$left"
  else
    echo "$cap"
  fi
}

# Print an https tarball URL from npm view --json, or nothing.
tarball_url_from_meta() {
  local version="$1"
  local meta="$2"
  local url=""
  if [ -n "$meta" ]; then
    url=$(printf '%s\n' "$meta" | jq -r --arg want "$version" "$JQ_FILTER" 2>/dev/null || true)
    url=${url%%$'\n'*}
  fi
  case "$url" in
    https://*) printf '%s\n' "$url" ;;
  esac
}

write_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

wait_for_tarball() {
  local version="$1"
  local max_wait="$2"
  local deadline=$((SECONDS + max_wait))
  local attempt=0
  local err_file
  err_file=$(mktemp)
  local meta="" url="" code="" left="" delay="" curl_max=""
  local used_fallback="" last_fallback="" last_meta="" last_url=""

  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    meta=$(npm view "@facthouse/mcp@${version}" version dist.tarball --json 2>"$err_file" || true)
    url=$(tarball_url_from_meta "$version" "$meta")
    used_fallback=""
    if [ -z "$url" ]; then
      url=$(canonical_tarball_url "$version")
      url=${url%$'\n'}
      used_fallback="1"
    fi
    last_fallback="$used_fallback"
    last_meta="$meta"
    last_url="$url"

    # A probe with no time left cannot curl. Logging that as HTTP 000 looks
    # like the empty-URL failure this script exists to remove.
    curl_max=$(curl_max_seconds "$((deadline - SECONDS))")
    if [ "$curl_max" -le 0 ]; then
      break
    fi
    code=$(curl -sS -L --max-time "$curl_max" -o /dev/null -w "%{http_code}" "$url" || true)
    code=$(printf '%s' "$code" | tr -cd '0-9')
    code=${code:-000}

    if [ "$code" = "200" ]; then
      write_output resolved true
      write_output waited "$SECONDS"
      echo "@facthouse/mcp@${version} tarball is HTTP 200 after ${SECONDS}s ($attempt attempt(s))."
      rm -f "$err_file"
      exit 0
    fi

    left=$((deadline - SECONDS))
    if [ "$used_fallback" = "1" ]; then
      echo "attempt ${attempt}: dist.tarball HTTP ${code} after ${SECONDS}s (${left}s left) url=${url} fallback=canonical"
    else
      echo "attempt ${attempt}: dist.tarball HTTP ${code} after ${SECONDS}s (${left}s left) url=${url}"
    fi
    if [ "$left" -le 0 ]; then
      break
    fi
    delay=$(poll_sleep_seconds "$left")
    if [ "$delay" -gt 0 ]; then
      sleep "$delay"
    fi
  done

  if [ -s "$err_file" ]; then
    echo "npm view stderr on final attempt:"
    cat "$err_file"
  fi
  if [ "$last_fallback" = "1" ]; then
    echo "npm view stdout on final attempt had no dist.tarball; used ${last_url}"
    if [ -n "$last_meta" ]; then
      printf '%s\n' "$last_meta"
    else
      echo "(empty)"
    fi
  fi
  rm -f "$err_file"
  write_output resolved false
  write_output waited "$SECONDS"
  echo "::error::Release ${version} tarball was not HTTP 200 after ${SECONDS}s. npm view can resolve while the tarball URL still 404s."
  exit 1
}

main() {
  local version="${1:-}"
  local max_wait="${2:-}"
  if [ "$#" -ne 2 ]; then
    echo "usage: wait_for_npm_tarball.sh VERSION MAX_WAIT_SECONDS" >&2
    exit 2
  fi
  if ! [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
    echo "::error::Refusing tarball URL for version: ${version}" >&2
    exit 2
  fi
  if ! [[ "$max_wait" =~ ^[0-9]+$ ]]; then
    echo "::error::MAX_WAIT must be a non-negative integer" >&2
    exit 2
  fi
  wait_for_tarball "$version" "$max_wait"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

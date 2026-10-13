#!/usr/bin/env bash
# Build the site, serve it the way GitHub Pages does (under a sub-folder) and run every test, then print a summary.
#
#   bash tests/run_all.sh            build from the data already in data/live/, offline pipeline unit tests
#   bash tests/run_all.sh --live     first refresh markets + news for real, and run the full pipeline test (network)
#   bash tests/run_all.sh --only home,integrate      run only some suites (names: shell markets dictionary library home
#                                                    integrate pipeline)
#
# Needs python3, node 20+ (run with --experimental-websocket) and Google Chrome. Uses free ports it finds itself, so it
# never collides with another preview. Each suite gets SUITE_TIMEOUT seconds (default 900) and one retry. Output: tests/out/run_all/<suite>.log, screenshots in tests/out/<suite>/.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOP="$(dirname "$ROOT")"
LIVE=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --live) LIVE=1 ;;
    --only) ONLY=",$2,"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac; shift
done
want() { [ -z "$ONLY" ] || [[ "$ONLY" == *",$1,"* ]]; }

LOGS="$ROOT/tests/out/run_all"; mkdir -p "$LOGS"
DEV="$ROOT/.dev/run-all"; SITE="$DEV/site"; SUB="$DEV/sub"
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if [ "$LIVE" = 1 ]; then
  step "Refreshing markets and news (network)"
  python3 "$ROOT/scripts/fetch_markets.py" | tail -3
  G="$(mktemp -d)"; python3 "$ROOT/scripts/build_glossary.py" --out "$G" | tail -1
  python3 "$ROOT/scripts/fetch_news.py" --glossary "$G/index.json" | tail -3
  rm -rf "$G"
fi

step "Building the site (--demo) and the claude.ai dictionary build"
python3 "$ROOT/scripts/build_site.py" --demo --out "$SITE" | tail -1 || exit 1
# words the site must never use (the glossary explains genuine finance terms and is off-limits, so it is skipped)
if grep -rIniE 'placement|undergraduate|\bMBA\b' "$SITE" --exclude-dir=glossary -l | grep -q .; then
  echo "FORBIDDEN WORDS in the build:"; grep -rniIE 'placement|undergraduate|\bMBA\b' "$SITE" --exclude-dir=glossary | cut -c1-200; exit 1
fi
rm -rf "$SUB"; mkdir -p "$SUB"; cp -R "$SITE" "$SUB/finspire"
ART_OK=1
if python3 "$ROOT/scripts/build_artifact.py" --out "$SUB/artifact" > "$LOGS/build_artifact.log" 2>&1 && [ -f "$TOP/finspire.html" ] && [ -f "$TOP/tools/wrap.py" ]; then
  python3 "$TOP/tools/wrap.py" "$TOP/finspire.html" "$SUB/artifact/index.html"
  tail -1 "$LOGS/build_artifact.log"
else
  ART_OK=0; echo "build_artifact.py failed (see $LOGS/build_artifact.log)"
fi

PORT="$(free_port)"
python3 -m http.server "$PORT" --bind 127.0.0.1 -d "$SUB" > /dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/finspire/" && break; sleep 0.25; done
BASE="http://127.0.0.1:$PORT/finspire/"
echo "serving $SUB on port $PORT (site at $BASE)"

SUITE_TIMEOUT="${SUITE_TIMEOUT:-900}"
declare -a NAMES RESULTS
FAILED=0
run() {   # run <name> <command...>
  local name="$1"; shift
  want "$name" || return 0
  step "$name"
  local t0=$SECONDS rc=0 try
  for try in 1 2; do    # headless Chrome very occasionally stops answering on a busy machine: time out and retry once
    "$@" > "$LOGS/$name.log" 2>&1 &
    local pid=$! waited=0
    while kill -0 $pid 2>/dev/null && [ $waited -lt "$SUITE_TIMEOUT" ]; do sleep 2; waited=$((waited + 2)); done
    if kill -0 $pid 2>/dev/null; then
      pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; wait $pid 2>/dev/null
      [ -n "${CHROME_PORT:-}" ] && pkill -f "remote-debugging-port=$CHROME_PORT" 2>/dev/null
      echo "timed out after ${SUITE_TIMEOUT}s (try $try)" | tee -a "$LOGS/$name.log"; rc=124
      continue
    fi
    wait $pid; rc=$?; break
  done
  grep -E '^FAIL' "$LOGS/$name.log" | cut -c1-240
  local sum
  sum="$(grep -Eo '^[0-9]+/[0-9]+ passed' "$LOGS/$name.log" | tail -1)"
  if [ -z "$sum" ]; then
    local ran; ran="$(grep -Eo 'Ran [0-9]+ tests' "$LOGS/$name.log" | grep -Eo '[0-9]+' | tail -1)"
    if [ -n "$ran" ]; then
      if grep -qE '^OK' "$LOGS/$name.log" && [ $rc = 0 ]; then sum="$ran/$ran unit tests"; else sum="unit tests failed (of $ran)"; fi
      grep -q 'live checks' "$LOGS/$name.log" && sum="$sum + live checks"
    else sum="no summary (exit $rc)"; fi
  fi
  [ $rc = 0 ] && status="ok" || { status="FAIL"; FAILED=1; }
  NAMES+=("$name"); RESULTS+=("$(printf '%-5s %-34s %4ss' "$status" "$sum" "$((SECONDS - t0))")")
  echo "$status  $sum"
}

chrome_suite() {   # chrome_suite <name> [extra args]: one browser suite on its own debug port; no Chrome left behind
  local name="$1"; shift
  local cp; cp="$(free_port)"
  CHROME_PORT="$cp" run "$name" node --experimental-websocket "$ROOT/tests/$name.test.mjs" "$BASE" "$cp" "$@"
  pkill -f "remote-debugging-port=$cp" 2>/dev/null || true
}
chrome_suite shell
chrome_suite markets
chrome_suite dictionary
chrome_suite library
chrome_suite home
if [ "$ART_OK" = 1 ]; then chrome_suite integrate "http://127.0.0.1:$PORT/artifact/"; else chrome_suite integrate; fi
if [ "$LIVE" = 1 ]; then run pipeline python3 "$ROOT/tests/pipeline_test.py"
else run pipeline python3 "$ROOT/tests/pipeline_test.py" --offline; fi

step "Summary"
for i in "${!NAMES[@]}"; do printf '  %-11s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"; done
[ "$ART_OK" = 1 ] || { echo "  build_artifact.py FAILED"; FAILED=1; }
echo "  logs: $LOGS"
exit $FAILED

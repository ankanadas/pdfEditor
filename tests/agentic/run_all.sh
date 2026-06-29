#!/usr/bin/env bash
# run_all.sh — sequence EVERY agentic suite one at a time (respects the CPU-contention rule),
# run each agent's Python verifier when one exists, and print a single green/red matrix.
# Usage:  AGENT_BROWSER=chrome bash tests/agentic/run_all.sh
# Pre-reqs: static dist server on :9000, local backend on :5001 (the script checks both).
set -u
cd "$(dirname "$0")/../.."
BROWSER="${AGENT_BROWSER:-chrome}"
PY=backend/venv/bin/python
OUT=/tmp/run_all_$$
mkdir -p "$OUT"

# Every agent base-name (core = the bare agent.cjs). Order: cheap → expensive-ish.
SUITES="agent:core latex reflow styles annotation richtext toolbar resume_textlayer divider \
fontlib hyperlink password protected regression reorder restriction shadow layout \
highlight_ui annotation_incremental signature mobile editor roundtrip combo pickers mobilefix mobilefixvx largefiles allpdf \
styleround styleadd mixedbold mixededit partialstyle addpartial partialstrict clickaway addroundtrip editflow addlink dynmode addempty partialbug partialbleed partialroundtrip mobilereorder colorbug colorreopen rotpartial stylematrix multistyle editfidelity addflip latexsize multiline wholeline"

# Map a suite to its agent file + verify file (core is special).
agent_file(){ [ "$1" = core ] && echo tests/agentic/agent.cjs || echo "tests/agentic/${1}_agent.cjs"; }
verify_file(){ [ "$1" = core ] && echo tests/agentic/verify.py || echo "tests/agentic/${1}_verify.py"; }

# Server preflight
sc=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/ 2>/dev/null)
bc=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/health 2>/dev/null)
echo "preflight: static9000=$sc backend5001=$bc  browser=$BROWSER"
[ "$sc" = 200 ] || { echo "FATAL: static server :9000 not up"; exit 3; }

echo "================ AGENTIC BATTERY ($BROWSER) ================"
green=0; red=0
for entry in $SUITES; do
  name="${entry%%:*}"; [ "$name" = agent ] && name=core
  base="${entry##*:}"; [ "$entry" = "agent:core" ] && base=core
  # normalise: for "agent:core" use agent.cjs/verify.py; else base==name
  if [ "$entry" = "agent:core" ]; then af=tests/agentic/agent.cjs; vf=tests/agentic/verify.py; label=core
  else af=$(agent_file "$entry"); vf=$(verify_file "$entry"); label="$entry"; fi

  alog="$OUT/${label}.agent"; vlog="$OUT/${label}.verify"
  AGENT_BROWSER="$BROWSER" node "$af" > "$alog" 2>&1; aexit=$?
  apass=$(grep -cE '\[PASS\]' "$alog"); afail=$(grep -cE '\[FAIL\]|SCENARIO FAILED|FATAL' "$alog")

  vinfo=""; vfail=0
  if [ -f "$vf" ]; then
    $PY "$vf" > "$vlog" 2>&1; vexit=$?
    vinfo=$(grep -oE '[0-9]+/[0-9]+ checks passed( across [0-9]+ PDFs)?' "$vlog" | tail -1)
    vfail=$(grep -cE '\[FAIL\]' "$vlog")
  fi

  if [ "$aexit" -eq 0 ] && [ "$afail" -eq 0 ] && [ "$vfail" -eq 0 ]; then status="GREEN"; green=$((green+1)); else status="RED  "; red=$((red+1)); fi
  printf "%-22s %s  agent_exit=%s pass=%s fail=%s  %s\n" "$label" "$status" "$aexit" "$apass" "$afail" "$vinfo"
done

# Committed-engine font/colour/size fidelity (in-process, no browser). Mirrors the committed
# backend test backend/tests/test_font_fidelity.py so the agentic run also surfaces it.
echo "===== FIDELITY (font family / size / colour preservation) ====="
$PY tests/agentic/fidelity_check.py > "$OUT/fidelity.log" 2>&1 && fid="GREEN" || fid="RED  "
echo "fidelity               $fid  $(grep -oE '[0-9]+/[0-9]+ checks passed' "$OUT/fidelity.log" | tail -1)"
[ "$fid" = "GREEN" ] || red=$((red+1))

echo "==========================================================="
echo "TOTAL: $green green, $red red   (logs in $OUT)"
[ "$red" -eq 0 ] && echo "ALL GREEN" || echo "SOME RED — inspect $OUT"

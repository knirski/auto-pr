#!/usr/bin/env bash
# Composite: write selected_model= / routing_context= / band= to GITHUB_OUTPUT.

set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${WORKSPACE:?}"
: "${DEFAULT_BRANCH:?}"
: "${AI_PROVIDER:?}"

cd "$WORKSPACE"

commits_count="${COMMITS_COUNT:-}"
if [[ -z "$commits_count" ]]; then
	commits_count="$(git log --format=%s "origin/$DEFAULT_BRANCH..HEAD" | grep -cvE '^Merge ' || true)"
fi

range="origin/$DEFAULT_BRANCH..HEAD"
n_sem="$commits_count"

# All changed paths in the PR range.
files="$(git diff --name-only "$range")"
s_spread="$(printf '%s\n' "$files" | sed '/^$/d' | awk -F/ '{print $1}' | sort -u | wc -l | tr -d ' ')"

# Distinguish generated-noise churn from source churn.
# Binary rows in numstat are "-" (treated as 0 line churn).
numstat="$(git diff --numstat "$range")"
metrics="$(printf '%s\n' "$numstat" | awk '
  function is_generated(path) {
    return path ~ /(^|\/)(dist|build|out|coverage|vendor|__snapshots__|\.terraform)(\/|$)/ ||
      path ~ /(^|\/)\.next(\/|$)/ ||
      path ~ /(^|\/)(pnpm-lock\.yaml|package-lock\.json|Cargo\.lock|go\.sum)$/ ||
      path ~ /\.lock$/ ||
      path ~ /\.min\.js$/ ||
      path ~ /\.map$/
  }
  {
    ins = ($1 == "-" ? 0 : $1) + 0
    del = ($2 == "-" ? 0 : $2) + 0
    path = $3
    churn = ins + del
    raw += churn
    if (is_generated(path)) {
      gen += churn
    } else {
      src += churn
    }
  }
  END {
    if (raw == "") raw = 0
    if (gen == "") gen = 0
    if (src == "") src = 0
    printf "%d %d %d\n", raw, src, gen
  }')"
delta_raw="$(echo "$metrics" | awk '{print $1}')"
delta_src="$(echo "$metrics" | awk '{print $2}')"
delta_gen="$(echo "$metrics" | awk '{print $3}')"

# Conventional commit type spread as a simple synthesis hardness signal.
type_count="$(git log --format=%s "$range" |
	grep -vE '^Merge ' |
	sed -nE 's/^([a-z]+)(\(.+\))?(!)?:.*/\1/p' |
	sort -u |
	wc -l |
	tr -d ' ')"

has_docs="$(printf '%s\n' "$files" | grep -Eq '^docs/|\.md$' && echo true || echo false)"
has_src="$(printf '%s\n' "$files" | grep -Eq '^src/' && echo true || echo false)"

# Hardness heuristic.
hardness=low
if [ "$type_count" -ge 3 ] || [ "$s_spread" -ge 3 ] || { [ "$has_docs" = true ] && [ "$has_src" = true ]; }; then
	hardness=high
elif [ "$type_count" -ge 2 ] || [ "$s_spread" -ge 2 ] || [ "$delta_src" -ge 400 ]; then
	hardness=medium
fi

# Bucketized source churn.
delta_src_bucket=small
if [ "$delta_src" -ge 1200 ]; then
	delta_src_bucket=large
elif [ "$delta_src" -ge 350 ]; then
	delta_src_bucket=medium
fi

# Generated-noise ratio bucket.
ratio_pct=0
if [ "$delta_raw" -gt 0 ]; then
	ratio_pct=$((delta_gen * 100 / delta_raw))
fi
gen_ratio_bucket=low
if [ "$ratio_pct" -ge 80 ]; then
	gen_ratio_bucket=high
elif [ "$ratio_pct" -ge 35 ]; then
	gen_ratio_bucket=medium
fi

# Band policy.
band=B
if [ "$delta_raw" -gt 0 ] && [ "$delta_src" -lt 120 ] && [ "$ratio_pct" -ge 80 ]; then
	band=A
elif { [ "$n_sem" -le 2 ] && [ "$delta_src" -lt 200 ] && [ "$hardness" = low ]; }; then
	band=A
elif { [ "$delta_src" -ge 1200 ] || [ "$hardness" = high ] || [ "$n_sem" -ge 8 ]; }; then
	band=C
fi

# Explicit input model wins; otherwise provider defaults keep generate-content valid.
selected_model="${INPUT_MODEL:-}"
if [ -z "$selected_model" ]; then
	if [ "$AI_PROVIDER" = "github-models" ]; then
		if [ "$band" = "C" ]; then
			selected_model="openai/gpt-4.1"
		else
			selected_model="microsoft/phi-4-mini-instruct"
		fi
	elif [ "$AI_PROVIDER" = "local" ]; then
		selected_model="gpt-oss"
	fi
fi

routing_context="band=$band; n_sem=$n_sem; delta_src=$delta_src_bucket; gen_ratio=$gen_ratio_bucket; hardness=$hardness. Prefer user-visible and breaking changes over lockfiles/generated churn."

{
	echo "selected_model=$selected_model"
	echo "routing_context=$routing_context"
	echo "band=$band"
} >>"$GITHUB_OUTPUT"

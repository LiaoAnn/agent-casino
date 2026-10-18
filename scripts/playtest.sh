#!/usr/bin/env bash
# Playtest: a real Claude Code (`claude -p`) and a real Codex (`codex exec`)
# play each other once, the way a participating agent would. Each gets the
# platform's skill.md installed as a project skill and one sentence asking it
# to queue under a given name.
#
#   pnpm playtest [<casino-url>]
#
# Run it on a machine where `claude` and `codex` are installed and logged in,
# not in the Dev Container (it has neither). It calls Anthropic and OpenAI.
#
# The url defaults to CASINO_URL, else this worktree's api on the dev VM
# (https://app-<worktree>.<hostname>.liaoann.net).
# PLAYTEST_CLAUDE_MODEL / PLAYTEST_CODEX_MODEL pick the models (default: each
# CLI's own default). PLAYTEST_TIMEOUT is the limit per agent in seconds
# (default 3600: a freezeout usually lasts 10-25 hands).
#
# Exits 0 only when the platform has a finished match between the two names
# in which both made their own last action, both agents got the server's
# match_over answer (seen in their logs), and both exited normally;
# the agents' own reports don't count. Everything the agents write and say
# goes to a fresh folder under /tmp, printed at the start.
set -euo pipefail

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
[ $# -le 1 ] || { echo "usage: pnpm playtest [<casino-url>]" >&2; exit 2; }
URL=${1:-${CASINO_URL:-https://app-$(basename "$root").$(hostname).liaoann.net}}
URL=${URL%/}
for cmd in claude codex curl jq git; do
  command -v "$cmd" >/dev/null || { echo "playtest needs $cmd (run it on the VM, not in the container)" >&2; exit 2; }
done
curl -fsS --max-time 20 "$URL/health" >/dev/null || { echo "no casino at $URL (is the api running?)" >&2; exit 2; }

RUN=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6 || true)
OUT=/tmp/agent-casino-playtest-$RUN
LIMIT=${PLAYTEST_TIMEOUT:-3600}
mkdir -p "$OUT"
echo "playtest $RUN against $URL, logs in $OUT"

# The agents' homes hold only links to the real logins, so they see none of
# the rules, skills or memories of whoever runs this.
real_home=$HOME
codex_home=${CODEX_HOME:-$real_home/.codex}
[ -s "$codex_home/auth.json" ] || { echo "codex is not logged in ($codex_home/auth.json)" >&2; exit 2; }
mkdir -p "$OUT/home-codex/.codex" "$OUT/home-claude/.claude"
ln -s "$codex_home/auth.json" "$OUT/home-codex/.codex/auth.json"

# Claude: CLAUDE_CODE_OAUTH_TOKEN if set, else the t3 service's, else the
# runner's credentials file.
claude_token=${CLAUDE_CODE_OAUTH_TOKEN:-}
if [ -z "$claude_token" ] && t3=$(pgrep -f 't3 serve' | head -1); then
  claude_token=$(tr '\0' '\n' <"/proc/$t3/environ" | sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' | head -1)
fi
if [ -z "$claude_token" ]; then
  creds=${CLAUDE_CONFIG_DIR:-$real_home/.claude}/.credentials.json
  [ -s "$creds" ] || { echo "claude is not logged in (no CLAUDE_CODE_OAUTH_TOKEN, no $creds)" >&2; exit 2; }
  ln -s "$creds" "$OUT/home-claude/.claude/.credentials.json"
fi

unset CODEX_HOME CLAUDE_CONFIG_DIR CLAUDECODE CLAUDE_CODE_ENTRYPOINT

# player <claude|codex> <name>: plays in its own git folder, skill installed
# where its CLI looks for project skills; the stream goes to <name>.jsonl.
player() {
  local harness=$1 name=$2 dir=$OUT/$2 log=$OUT/$2.jsonl skilldir invoke prompt
  case $harness in
    claude) skilldir=$dir/.claude/skills/agent-casino invoke=/agent-casino ;;
    codex) skilldir=$dir/.agents/skills/agent-casino invoke=\$agent-casino ;;
  esac
  mkdir -p "$skilldir"
  git -C "$dir" init -q
  curl -fsS --max-time 20 "$URL/skill.md" -o "$skilldir/SKILL.md"
  prompt="$invoke 請用名字 $name 去排一局德州撲克。對手是另一個 agent，會同時來排隊，等到配對成功為止，然後打完。"
  cd "$dir"
  case $harness in
    claude)
      HOME=$OUT/home-claude CLAUDE_CODE_OAUTH_TOKEN=$claude_token \
        timeout "$LIMIT" claude -p "$prompt" ${PLAYTEST_CLAUDE_MODEL:+--model "$PLAYTEST_CLAUDE_MODEL"} \
        --output-format stream-json --verbose --dangerously-skip-permissions </dev/null >"$log" 2>&1
      ;;
    codex)
      HOME=$OUT/home-codex \
        timeout "$LIMIT" codex exec --json ${PLAYTEST_CODEX_MODEL:+-m "$PLAYTEST_CODEX_MODEL"} \
        --dangerously-bypass-approvals-and-sandbox "$prompt" </dev/null >"$log" 2>&1
      ;;
  esac
}

claude_name=smoke-claude-$RUN
codex_name=smoke-codex-$RUN
player claude "$claude_name" &
claude_pid=$!
player codex "$codex_name" &
codex_pid=$!
# On Ctrl-C, stop the agents too (each runs under `timeout`, which passes it on).
trap 'pkill -TERM -P "$claude_pid" || true; pkill -TERM -P "$codex_pid" || true; exit 130' INT TERM

rc_claude=0 rc_codex=0
wait "$claude_pid" || rc_claude=$?
wait "$codex_pid" || rc_codex=$?
echo "claude exited $rc_claude, codex exited $rc_codex (124 = timed out)"

# The platform decides: a finished match between the two names in which each
# player's last action was its own, not the server playing for an agent that
# had already gone.
match=$(curl -fsS --max-time 20 "$URL/v1/matches" | jq -r --arg a "$claude_name" --arg b "$codex_name" \
  '[.matches[] | select((.players | index($a)) and (.players | index($b)))
    | select(.result | test("^(seat0_win|seat1_win|draw)$"))][0].match_id // empty')
if [ -z "$match" ]; then
  echo "not ok - no finished match between $claude_name and $codex_name on $URL" >&2
  exit 1
fi
detail=$(curl -fsS --max-time 20 "$URL/v1/matches/$match")
jq -r '
  . as $m
  | "match \(.match_id): \(.players[0]) vs \(.players[1]), \(.result), \(.hands | length) hands, final stacks \(.final_stacks | map(tostring) | join(":"))",
    (range(2) as $s
      | [$m.hands[].events[] | select(.seat == $s and .type != "post_blind")] as $acts
      | "  \($m.players[$s]): \($acts | length) actions, \([$acts[] | select(.timeout)] | length) timeouts, last action \(if ($acts | last | .timeout) then "by the server (timeout)" else "its own" end)")' <<<"$detail"
present=$(jq '[range(2) as $s | [.hands[].events[] | select(.seat == $s and .type != "post_blind")]
  | length > 0 and (last | .timeout | not)] | all' <<<"$detail")

# And each agent got the server's own match_over answer: the output of one of
# its commands (not its own messages) holds a match_over that names this run's
# opponent, so it can't come from skill.md either.
# got_match_over <log> <opponent>
got_match_over() {
  jq -e -n -R --arg opp "$2" '
    [ inputs | fromjson? | objects | (select(.type == "user") | .message.content[]? | select(.type == "tool_result")
             | .content | if type == "array" then map(.text? // "") | join("\n") else . end),
            (select(.type == "item.completed" and .item.type == "command_execution")
             | .item.aggregated_output) ]
    | map(strings | select(test("\"status\"\\s*:\\s*\"match_over\"")
        and test("\"opponent_name\"\\s*:\\s*\"" + $opp + "\"")))
    | length > 0' "$1" >/dev/null
}
seen_claude=no seen_codex=no
got_match_over "$OUT/$claude_name.jsonl" "$codex_name" && seen_claude=yes
got_match_over "$OUT/$codex_name.jsonl" "$claude_name" && seen_codex=yes
echo "  match_over in the server's answers: $claude_name $seen_claude, $codex_name $seen_codex"

if [ "$present" != true ] || [ "$seen_claude" != yes ] || [ "$seen_codex" != yes ] ||
  [ "$rc_claude" -ne 0 ] || [ "$rc_codex" -ne 0 ]; then
  echo "not ok - an agent did not play match $match to match_over (see above and the logs in $OUT)" >&2
  exit 1
fi
echo "ok - both agents played match $match to match_over"

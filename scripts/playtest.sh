#!/usr/bin/env bash
# Playtest: real Claude Code (`claude -p`) and Codex (`codex exec`) agents
# play the way a participating agent would. Each gets the agent kit (A24)
# installed as project skills, a profile with its name, and one sentence
# asking it to play.
#
#   pnpm playtest [<casino-url>]
#
# Run it on a machine where `claude` and `codex` are installed and logged in,
# not in the Dev Container (it has neither). It calls Anthropic and OpenAI.
#
# The url defaults to CASINO_URL, else this worktree's api on the dev VM
# (https://app-<worktree>.<hostname>.liaoann.net).
# PLAYTEST_PLAYERS lists the harness of each player, 1 to 6 of them
# (default "claude codex"); they all run at once.
# PLAYTEST_SCENARIO (T42):
#   table         (default) every player runs `play` and sits at one public
#                 table; the host is told to start once all are seated.
#   private-bots  the first player only: opens a private table with
#                 `room create` and starts it with PLAYTEST_BOTS house-bots
#                 (default 2). Unrated, so only the play itself is checked.
# PLAYTEST_CLAUDE_MODEL / PLAYTEST_CODEX_MODEL pick the models (default: each
# CLI's own default). PLAYTEST_TIMEOUT is the limit per agent in seconds
# (default 3600: a freezeout usually lasts 10-25 hands).
#
# Exits 0 only when the platform has a finished match with exactly these
# names (plus the house-bots of private-bots) in which every player made its
# own last action, every agent saw casino.sh say its match was over or that it
# was out (in its own command output), and every agent exited normally; the
# agents' own reports don't count. Everything the agents write and say goes
# to a fresh folder under /tmp, printed at the start.
set -euo pipefail

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
[ $# -le 1 ] || { echo "usage: pnpm playtest [<casino-url>]" >&2; exit 2; }
URL=${1:-${CASINO_URL:-https://app-$(basename "$root").$(hostname).liaoann.net}}
URL=${URL%/}
for cmd in claude codex curl jq git; do
  command -v "$cmd" >/dev/null || { echo "playtest needs $cmd (run it on the VM, not in the container)" >&2; exit 2; }
done
curl -fsS --max-time 20 "$URL/health" >/dev/null || { echo "no casino at $URL (is the api running?)" >&2; exit 2; }

read -r -a harnesses <<<"${PLAYTEST_PLAYERS:-claude codex}"
SCENARIO=${PLAYTEST_SCENARIO:-table}
BOTS=${PLAYTEST_BOTS:-2}
case $SCENARIO in
  table) [ "${#harnesses[@]}" -ge 2 ] && [ "${#harnesses[@]}" -le 6 ] ||
    { echo "PLAYTEST_PLAYERS: 2 to 6 players for the table scenario" >&2; exit 2; } ;;
  private-bots)
    harnesses=("${harnesses[0]}")
    [[ $BOTS =~ ^[1-5]$ ]] || { echo "PLAYTEST_BOTS: 1 to 5" >&2; exit 2; } ;;
  *) echo "PLAYTEST_SCENARIO: table or private-bots" >&2; exit 2 ;;
esac
for h in "${harnesses[@]}"; do
  case $h in claude | codex) ;; *) echo "PLAYTEST_PLAYERS: claude or codex, not $h" >&2; exit 2 ;; esac
done
RUN=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6 || true)
OUT=/tmp/agent-casino-playtest-$RUN
LIMIT=${PLAYTEST_TIMEOUT:-3600}
mkdir -p "$OUT"
echo "playtest $RUN ($SCENARIO: ${harnesses[*]}) against $URL, logs in $OUT"

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

# player <claude|codex> <name> <prompt>: plays in its own git folder, the kit
# installed where its CLI looks for project skills, with a profile under
# <name> made beforehand (an agent keeps a profile it finds, A20); the stream
# goes to <name>.jsonl.
player() {
  local harness=$1 name=$2 prompt=$3 dir=$OUT/$2 log=$OUT/$2.jsonl skills invoke file
  case $harness in
    claude) skills=$dir/.claude/skills invoke=/agent-casino ;;
    codex) skills=$dir/.agents/skills invoke=\$agent-casino ;;
  esac
  mkdir -p "$dir" && git -C "$dir" init -q
  for file in agent-casino/SKILL.md agent-casino/scripts/casino.sh agent-casino-holdem/SKILL.md; do
    curl -fsS --max-time 20 --create-dirs -o "$skills/$file" "$URL/skills/$file"
  done
  mkdir -p "$dir/.casino"
  jq -nc --arg name "$name" --arg shown "$name 試玩" '{name: $name, display_name: $shown}' \
    >"$dir/.casino/profile.json"
  prompt="$invoke $prompt"
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

n=${#harnesses[@]}
names=() pids=()
for i in "${!harnesses[@]}"; do
  name=pt-${harnesses[$i]}-$RUN-$i
  names+=("$name")
  if [[ $SCENARIO == table ]]; then
    prompt="請玩一局德州撲克，用 play 自動入座。這次一共有 $n 個 agent 同時來；你如果是房主，等到 $n 人都入座就開始，不用再問我；不是房主就等房主開始。打完為止。"
  else
    prompt="請開一間私人房玩一局德州撲克（room create），不用等別人，直接用 $BOTS 個 house-bot 補空位開始，不用再問我。打完為止。"
  fi
  player "${harnesses[$i]}" "$name" "$prompt" &
  pids+=($!)
done
# On Ctrl-C, stop the agents too (each runs under `timeout`, which passes it on).
trap 'for p in "${pids[@]}"; do pkill -TERM -P "$p" || true; done; exit 130' INT TERM

rcs=()
for p in "${pids[@]}"; do
  rc=0
  wait "$p" || rc=$?
  rcs+=("$rc")
done
for i in "${!names[@]}"; do echo "${names[$i]} exited ${rcs[$i]} (124 = timed out)"; done

# The platform decides: a finished match with exactly these names (and the
# house-bots), in which each player's last action was its own, not the server
# playing for an agent that had already gone.
# table: only these names, rated; private-bots: the name and exactly BOTS
# house-bots, unrated.
want=$(printf '%s\n' "${names[@]}" | jq -R . | jq -sc 'sort')
bots=0 rated=true
[[ $SCENARIO == private-bots ]] && bots=$BOTS rated=false
match=$(curl -fsS --max-time 20 "$URL/v1/matches" | jq -r --argjson want "$want" \
  --argjson bots "$bots" --argjson rated "$rated" '
  [.matches[] | select(([.players[] | select(. != "house-bot")] | sort) == $want
      and ([.players[] | select(. == "house-bot")] | length) == $bots
      and .rated == $rated)
    | select(.result | test("^(seat[0-5]_win|draw)$"))][0].match_id // empty')
if [ -z "$match" ]; then
  echo "not ok - no finished match with ${names[*]} and $bots house-bots (rated: $rated) on $URL" >&2
  exit 1
fi
detail=$(curl -fsS --max-time 20 "$URL/v1/matches/$match")
jq -r '
  . as $m
  | "match \(.match_id): \(.players | join(", ")), \(.result), \(.hands | length) hands, final stacks \(.final_stacks | map(tostring) | join(":")), places \(.places | map(tostring) | join(":"))",
    (range(.players | length) as $s | select($m.players[$s] != "house-bot")
      | [$m.hands[].events[] | select(.seat == $s and .type != "post_blind")] as $acts
      | "  \($m.players[$s]): \($acts | length) actions, \([$acts[] | select(.timeout)] | length) timeouts, last action \(if ($acts | last | .timeout) then "by the server (timeout)" else "its own" end)")' <<<"$detail"
present=$(jq '[range(.players | length) as $s | select(.players[$s] != "house-bot")
  | [.hands[].events[] | select(.seat == $s and .type != "post_blind")]
  | length > 0 and (last | .timeout | not)] | all' <<<"$detail")

# And each agent saw its match end in casino.sh's own output (one of its
# commands, not its own messages): "The match is over: <result>" or, out of
# chips at a bigger table, "You are out of the match: place N".
# saw_end <log>
saw_end() {
  jq -e -n -R '
    [ inputs | fromjson? | objects | (select(.type == "user") | .message.content[]? | select(.type == "tool_result")
             | .content | if type == "array" then map(.text? // "") | join("\n") else . end),
            (select(.type == "item.completed" and .item.type == "command_execution")
             | .item.aggregated_output) ]
    | map(strings | select(test("The match is over: (win|loss|draw)|You are out of the match: place [1-6]")))
    | length > 0' "$1" >/dev/null
}
all_ok=$([ "$present" = true ] && echo yes || echo no)
for i in "${!names[@]}"; do
  seen=no
  saw_end "$OUT/${names[$i]}.jsonl" && seen=yes
  echo "  ${names[$i]}: casino.sh said the match ended: $seen"
  [ "$seen" = yes ] && [ "${rcs[$i]}" -eq 0 ] || all_ok=no
done

if [ "$all_ok" != yes ]; then
  echo "not ok - an agent did not play match $match to its end (see above and the logs in $OUT)" >&2
  exit 1
fi
echo "ok - every agent played match $match to its end"

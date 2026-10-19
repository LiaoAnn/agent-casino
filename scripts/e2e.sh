#!/usr/bin/env bash
# End to end with nothing but curl and jq, the way a participating agent
# plays: skill.md, a match against house-bot, two players who queue and play
# each other, then the records and the leaderboard.
#
#   pnpm e2e --target=local     # CASINO_URL, else http://127.0.0.1:8787
#   pnpm e2e --target=staging   # needs CASINO_URL
#   pnpm e2e --target=prod      # needs CASINO_URL
#
# With WEB_URL (the web of the same deployment) it also checks that the web
# shows the matches it played.
#
# Prints one line per check and exits 0 only when all of them pass. Rated
# matches it plays go on the leaderboard as e2e-a-<run> and e2e-b-<run>.
set -euo pipefail

target=""
for arg in "$@"; do
  case $arg in
    --target=*) target=${arg#--target=} ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
case $target in
  local) URL=${CASINO_URL:-http://127.0.0.1:8787} ;;
  staging | prod)
    URL=${CASINO_URL:?set CASINO_URL to the $target api, e.g. https://api.example}
    ;;
  *) echo "usage: pnpm e2e --target=local|staging|prod" >&2; exit 2 ;;
esac
URL=${URL%/}
command -v jq >/dev/null || { echo "e2e needs jq" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kill $(jobs -p) 2>/dev/null || true' EXIT
RUN=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)
# Settings nobody else is likely to queue with, so the two players here meet
# each other (A2).
SETTINGS='{"starting_stack":40,"blind_every":3,"max_hands":40,"turn_seconds":30}'

ok() { echo "ok - $*"; }
fail() { echo "not ok - $*" >&2; exit 1; }
# check <description> <jq filter that must be true> <json>
check() {
  if jq -e "$2" >/dev/null <<<"$3"; then ok "$1"; else
    echo "$3" >&2
    fail "$1"
  fi
}

get() { curl -sS --max-time 40 "$URL$1" "${@:2}"; }
post() {
  curl -sS --max-time 40 -X POST "$URL$1" -H 'Content-Type: application/json' \
    -d "$2" "${@:3}"
}

# play <room_id> <token> <out file> [two-step]: checks when it can, else
# calls, until match_over, which goes to <out file>. Each action is sent with
# ?wait=1, whose answer is the next state (T47); with two-step, the old way:
# actions answers accepted, then wait.
play() {
  local room=$1 token=$2 out=$3 mode=${4-} r="" status turn type acted=false
  for _ in $(seq 1 2000); do
    [[ -n $r ]] || r=$(get "/v1/rooms/$room/wait" -H "Authorization: Bearer $token")
    status=$(jq -r .status <<<"$r")
    case $status in
      your_turn)
        # T48: tell_owner (the watch link) until the seat's first action.
        check "your_turn includes completed hands, the owner message only before the first action, and points to actions?wait=1" \
          '(.hands_since_your_turn | type) == "array"
           and (if '"$acted"' then (has("tell_owner") | not)
             else (.tell_owner | type == "string" and contains("Watch: ")) end)
           and (.hint | contains("/actions?wait=1"))
           and ([.hands_since_your_turn[].hand_number] | . == sort)' "$r"
        turn=$(jq -r .turn_id <<<"$r")
        type=$(jq -r 'if any(.legal_actions[]; .type == "check")
          then "check" else "call" end' <<<"$r")
        if [[ $mode == two-step ]]; then
          r=$(post "/v1/rooms/$room/actions" \
            "{\"turn_id\":\"$turn\",\"type\":\"$type\"}" \
            -H "Authorization: Bearer $token")
          [[ $(jq -r .status <<<"$r") == accepted ]] || {
            echo "$r" >&2
            return 1
          }
          r=""
          acted=true
        else
          r=$(post "/v1/rooms/$room/actions?wait=1" \
            "{\"turn_id\":\"$turn\",\"type\":\"$type\"}" \
            -H "Authorization: Bearer $token")
          [[ $(jq -r .status <<<"$r") =~ ^(your_turn|waiting|match_over)$ ]] || {
            echo "$r" >&2
            return 1
          }
          acted=true
        fi
        ;;
      waiting)
        check "waiting has no owner message or completed-hand array" \
          '(has("tell_owner") or has("hands_since_your_turn")) | not' "$r"
        r="" ;;
      match_over)
        check "match_over includes a complete owner report and hand history" \
          '(.hands_since_your_turn | type) == "array"
           and ([.hands_since_your_turn[].hand_number] | . == sort)
           and (.tell_owner | type) == "string"' "$r"
        check "owner report includes result, final chips, Elo and record link" \
          '. as $r | (.tell_owner | contains($r.result) and contains("Elo")
           and contains("/matches/" + $r.match_id))
           and all(.final_stacks[]; . as $chips | $r.tell_owner | contains($chips | tostring))
           and (if .ratings == null then (.tell_owner | contains("unrated"))
             else all(.ratings[]; . as $rating | $r.tell_owner |
               contains($rating.name) and contains($rating.change | tostring)) end)' "$r"
        echo "$r" >"$out"; return 0 ;;
      *) echo "$r" >&2; return 1 ;;
    esac
  done
  return 1
}

# A fresh queue_key (A17): 32 hex characters, as skill.md makes it.
queue_key() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# queue_body <name> <queue_key> [display_name]
queue_body() {
  jq -nc --arg name "$1" --arg key "$2" --arg shown "${3-}" \
    --argjson settings "$SETTINGS" \
    '{game: "holdem", name: $name, queue_key: $key, settings: $settings}
     + if $shown == "" then {} else {display_name: $shown} end'
}

# queue <name> <queue_key> <out file> [display_name]: queues until matched.
queue() {
  local r
  for _ in $(seq 1 10); do
    r=$(post /v1/queue "$(queue_body "$1" "$2" "${4-}")")
    case $(jq -r .status <<<"$r") in
      matched) echo "$r" >"$3"; return 0 ;;
      waiting) ;;
      *) echo "$r" >&2; return 1 ;;
    esac
  done
  return 1
}

echo "# e2e against $URL ($target)"

check "GET /v1/leaderboard" '.entries | type == "array"' "$(get /v1/leaderboard)"
skill=$(get /skill.md)
[[ $skill == ---* && $skill == *"name: agent-casino"* ]] &&
  ok "GET /skill.md has the skill frontmatter" ||
  fail "GET /skill.md has the skill frontmatter"

# --- a match against house-bot -------------------------------------------
human="e2e-h-$RUN"
r=$(post /v1/rooms \
  "{\"game\":\"holdem\",\"name\":\"$human\",\"opponent\":\"bot\",\"settings\":{\"hands\":10}}" \
  -w '\n%{http_code}')
check "POST /v1/rooms with the old settings.hands: 400 pointing to max_hands" \
  '.[0].code == "invalid_request" and .[1] == 400
   and (.[0].hint | contains("max_hands"))' "$(jq -s . <<<"$r")"
# A display name is any text but a line break (A20).
r=$(post /v1/rooms \
  "{\"game\":\"holdem\",\"name\":\"$human\",\"display_name\":\"two\\nlines\",\"opponent\":\"bot\"}" \
  -w '\n%{http_code}')
check "POST /v1/rooms with a line break in display_name: 400 invalid_request" \
  '.[0].code == "invalid_request" and .[1] == 400' "$(jq -s . <<<"$r")"
room=$(post /v1/rooms \
  "{\"game\":\"holdem\",\"name\":\"$human\",\"display_name\":\"  人類   玩家 🃏 \",\"opponent\":\"bot\"}")
# No settings: the defaults (holdem-rules 設定表).
check "POST /v1/rooms with house-bot and the default settings" \
  '.seat == 0 and (.token | length > 0)
   and .settings == {starting_stack: 40, blind_every: 5, max_hands: 50, turn_seconds: 30}' "$room"
check "POST /v1/rooms trims and squeezes the display name; house-bot is House Bot" \
  '.display_name == "人類 玩家 🃏" and .opponent_display_name == "House Bot"' \
  "$room"
check "bot start tells the owner the opponent and exact watch link" \
  '. as $r | .tell_owner | contains("House Bot") and contains($r.watch_url)' "$room"
bot_room=$(jq -r .room_id <<<"$room")
# The house-bot match keeps the two requests per action (actions, then wait).
play "$bot_room" "$(jq -r .token <<<"$room")" "$TMP/bot" two-step ||
  fail "play house-bot to match_over"
check "house-bot match: over, not rated" \
  '.status == "match_over" and (.result | IN("win", "loss", "draw"))
   and .ratings == null and (.final_stacks | add) == 80
   and .view.next_blinds_at_hand == null
   and .view.blinds == .last_hand.blinds
   and .display_name == "人類 玩家 🃏" and .opponent_display_name == "House Bot"' \
  "$(cat "$TMP/bot")"
# A freezeout (A19): it ends on a bust or after max_hands, and the blinds
# double every blind_every hands.
check "GET /v1/matches/{id} of the house-bot match" \
  ".players == [\"$human\", \"house-bot\"] and .rated == false
   and .display_names == [\"人類 玩家 🃏\", \"House Bot\"]
   and .settings == {starting_stack: 40, blind_every: 5, max_hands: 50, turn_seconds: 30}
   and (.hands | length) >= 1 and (.hands | length) <= 50
   and ((.final_stacks | index(0)) != null or (.hands | length) == 50)
   and .end_reason == (if (.final_stacks | index(0)) != null then \"bust\" else \"max_hands\" end)
   and all(.hands[]; .blinds == [pow(2; (.hand_number - 1) / 5 | floor),
                                 2 * pow(2; (.hand_number - 1) / 5 | floor)])
   and (.seed | test(\"^[0-9a-f]{64}$\"))" "$(get "/v1/matches/$bot_room")"

# Production smoke checks only play house-bot, which never changes Elo.
if [[ $target == prod ]]; then
  check "production smoke match leaves the leaderboard unchanged" \
    "all(.entries[]; .name != \"$human\" and .name != \"house-bot\")" \
    "$(get /v1/leaderboard)"
  if [[ -n ${WEB_URL:-} ]]; then
    page=$(curl -sS --max-time 40 "${WEB_URL%/}/matches/$bot_room")
    [[ $page == *"@$human"* && $page == *"House Bot"* ]] &&
      ok "the web shows the house-bot match" || fail "the web shows the house-bot match"
  fi
  echo "# skipped rated queue matches on prod"
  echo "# all checks passed"
  exit 0
fi

# --- two players queue and play each other --------------------------------
a="e2e-a-$RUN"
b="e2e-b-$RUN"
key_a=$(queue_key)
key_b=$(queue_key)
r=$(post /v1/queue "$(queue_body "$a" short)" -w '\n%{http_code}')
check "POST /v1/queue with a bad queue_key: 400 invalid_request" \
  '.[0].code == "invalid_request" and .[1] == 400' \
  "$(jq -s . <<<"$r")"
# $a shows a display name; $b gives none, so theirs is the name (A20).
queue "$a" "$key_a" "$TMP/qa" "  選手   A 🃏 " &
qa=$!
sleep 2
queue "$b" "$key_b" "$TMP/qb" || fail "POST /v1/queue pairs $b"
wait $qa || fail "POST /v1/queue pairs $a"
check "both queued players got the same room" \
  '.[0].room_id == .[1].room_id and .[0].seat == 0 and .[1].seat == 1' \
  "$(jq -s . "$TMP/qa" "$TMP/qb")"
check "matched tells each owner the opponent and their exact watch link" \
  'all(.[]; . as $r | .tell_owner | contains($r.opponent_display_name) and contains($r.watch_url))' \
  "$(jq -s . "$TMP/qa" "$TMP/qb")"
check "matched shows both display names to both" \
  ".[0].display_name == \"選手 A 🃏\" and .[0].opponent_display_name == \"$b\"
   and .[1].display_name == \"$b\" and .[1].opponent_display_name == \"選手 A 🃏\"" \
  "$(jq -s . "$TMP/qa" "$TMP/qb")"
# Someone who knows $a's name, but not the queue_key, gets nothing (A17).
r=$(post /v1/queue "$(queue_body "$a" "$(queue_key)")" -w '\n%{http_code}')
check "POST /v1/queue with $a's name and another queue_key: 409 name_in_use" \
  '.[0].code == "name_in_use" and .[1] == 409
   and (.[0] | has("room_id") or has("token") or has("watch_url") | not)' \
  "$(jq -s . <<<"$r")"
check "POST /v1/queue again with $a's queue_key and another display name: the same matched" \
  '.[0] == .[1]' \
  "$(jq -s . "$TMP/qa" <(post /v1/queue "$(queue_body "$a" "$key_a" "改名")"))"
pair_room=$(jq -r .room_id "$TMP/qa")
# T47: a refused action answers its error at once, without waiting.
r=$(post "/v1/rooms/$pair_room/actions?wait=1" '{"turn_id":"t_999","type":"fold"}' \
  -H "Authorization: Bearer $(jq -r .token "$TMP/qb")" -w '\n%{http_code} %{time_total}')
check "a refused actions?wait=1 answers 409 at once, with state" \
  '(.[0].code | IN("not_your_turn", "stale_turn")) and (.[0].state | type) == "object"
   and .[1] == 409 and .[2] < 5' "$(jq -s . <<<"$r")"
r=$(post "/v1/rooms/$pair_room/actions?wait=true" '{"turn_id":"t_1","type":"fold"}' \
  -H "Authorization: Bearer $(jq -r .token "$TMP/qa")" -w '\n%{http_code}')
check "actions?wait=true: 400 invalid_request" \
  '.[0].code == "invalid_request" and .[1] == 400' "$(jq -s . <<<"$r")"
play "$pair_room" "$(jq -r .token "$TMP/qa")" "$TMP/a" &
pa=$!
play "$pair_room" "$(jq -r .token "$TMP/qb")" "$TMP/b" || fail "play $b to match_over"
wait $pa || fail "play $a to match_over"
check "queued match: over and rated for both" \
  "(.[0].result + \"/\" + .[1].result | IN(\"win/loss\", \"loss/win\", \"draw/draw\"))
   and .[0].ratings == .[1].ratings
   and (.[0].ratings | map(.name)) == [\"$a\", \"$b\"]
   and (.[0].ratings | map(.change) | add | fabs) <= 1" \
  "$(jq -s . "$TMP/a" "$TMP/b")"

# --- what the web shows ---------------------------------------------------
check "GET /v1/matches lists both matches" \
  "[.matches[].match_id] | index(\"$bot_room\") != null and index(\"$pair_room\") != null" \
  "$(get /v1/matches)"
check "GET /v1/matches/{id} of the queued match is rated" \
  ".players == [\"$a\", \"$b\"] and .rated == true
   and .display_names == [\"選手 A 🃏\", \"$b\"]
   and (.rating_changes | length) == 2" "$(get "/v1/matches/$pair_room")"
check "GET /v1/leaderboard counts the queued match, not house-bot" \
  "([.entries[] | select(.name == \"$a\" or .name == \"$b\") | .games] == [1, 1]
    or (.entries | length) == 100)
   and all(.entries[]; .name != \"house-bot\" and .name != \"$human\")
   and all(.entries[] | select(.name == \"$a\"); .display_name == \"選手 A 🃏\")
   and all(.entries[] | select(.name == \"$b\"); .display_name == \"$b\")" \
  "$(get /v1/leaderboard)"

if [[ -n ${WEB_URL:-} ]]; then
  WEB_URL=${WEB_URL%/}
  home=$(curl -sS --max-time 40 "$WEB_URL/")
  [[ $home == *"選手 A 🃏"* && $home == *"@$a"* && $home == *"$human"* ]] &&
    ok "the web lists both matches" || fail "the web lists both matches"
  page=$(curl -sS --max-time 40 "$WEB_URL/matches/$pair_room")
  [[ $page == *"選手 A 🃏"* && $page == *"@$a"* && $page == *"$b"* ]] &&
    ok "the web shows the queued match" || fail "the web shows the queued match"
else
  echo "# skipped the web checks: no WEB_URL"
fi

echo "# all checks passed"

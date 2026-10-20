#!/usr/bin/env bash
# End to end with nothing but curl and jq, the way a participating agent
# plays: skill.md, a match against house-bot, two players who sit at one
# public table with POST /v1/rooms/quick and play each other, then the
# records and the leaderboard. The local or staging deployment should have no
# open public table with the default settings: the first player opens one.
#
#   pnpm e2e --target=local     # CASINO_URL, else http://127.0.0.1:8787
#   pnpm e2e --target=staging   # needs CASINO_URL
#   pnpm e2e --target=prod      # CASINO_URL and WEB_URL, else https://casino.liaoann.net
#
# With WEB_URL (the web of the same deployment) it also checks that the web
# shows the matches it played. Production serves the api through the web
# (T44), so both default to its one domain.
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
  staging)
    URL=${CASINO_URL:?set CASINO_URL to the staging api, e.g. https://api.example}
    ;;
  prod)
    URL=${CASINO_URL:-https://casino.liaoann.net}
    WEB_URL=${WEB_URL:-https://casino.liaoann.net}
    ;;
  *) echo "usage: pnpm e2e --target=local|staging|prod" >&2; exit 2 ;;
esac
URL=${URL%/}
command -v jq >/dev/null || { echo "e2e needs jq" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kill $(jobs -p) 2>/dev/null || true' EXIT
RUN=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8 || true)

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

# quick <name> [display_name]: POST /v1/rooms/quick (A2, A25).
quick() {
  post /v1/rooms/quick "$(jq -nc --arg name "$1" --arg shown "${2-}" \
    '{game: "holdem", name: $name}
     + if $shown == "" then {} else {display_name: $shown} end')"
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
  echo "# skipped the rated quick-seat match on prod"
  echo "# all checks passed"
  exit 0
fi

# --- the queue is gone (T39) ----------------------------------------------
for body in '{"game":"holdem","name":"e2e-q","queue_key":"0123456789abcdef0123456789abcdef"}' '{bad'; do
  r=$(post /v1/queue "$body" -w '\n%{http_code}')
  check "POST /v1/queue ($body): 410 gone pointing to POST /v1/rooms/quick" \
    '.[0].code == "gone" and .[1] == 410 and .[0].retryable == false
     and (.[0].hint | contains("POST /v1/rooms/quick") and contains("/skill.md"))' \
    "$(jq -s . <<<"$r")"
done

# --- two players sit at one public table and play each other --------------
a="e2e-a-$RUN"
b="e2e-b-$RUN"
# $a shows a display name; $b gives none, so theirs is the name (A20).
quick "$a" "  選手   A 🃏 " >"$TMP/qa"
check "POST /v1/rooms/quick opens a public table with $a as host" \
  '.seat == 0 and .is_host == true and .visibility == "public"
   and .invite_code == null and (has("tell_owner") | not)
   and .settings.blind_every == null and .seats_open == 5
   and .display_name == "選手 A 🃏"' "$(cat "$TMP/qa")"
pair_room=$(jq -r .room_id "$TMP/qa")
check "GET /v1/lobby lists the new table with $a" \
  "any(.rooms[]; .room_id == \"$pair_room\" and .visibility == \"public\"
     and .seats == [{seat: 0, name: \"$a\", display_name: \"選手 A 🃏\"}]
     and .seats_open == 5)" "$(get /v1/lobby)"
quick "$b" >"$TMP/qb"
check "POST /v1/rooms/quick seats $b at the same table" \
  ".room_id == \"$pair_room\" and .seat == 1 and .is_host == false
   and .display_name == \"$b\" and .opponent_display_name == \"選手 A 🃏\"" \
  "$(cat "$TMP/qb")"
check "quick tells the joining owner the host and their exact watch link" \
  '. as $r | .tell_owner | contains("Joined the table of 選手 A 🃏")
   and contains($r.watch_url)' "$(cat "$TMP/qb")"
r=$(post "/v1/rooms/$pair_room/start" '{}' \
  -H "Authorization: Bearer $(jq -r .token "$TMP/qa")")
check "the host starts the table: playing, blind_every set for 2 seats" \
  '.room_status == "playing" and .settings.blind_every == 5 and .seats_open == 0' "$r"
check "GET /v1/lobby no longer lists the started table" \
  "all(.rooms[]; .room_id != \"$pair_room\")" "$(get /v1/lobby)"
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
check "quick-seat match: over and rated for both" \
  "(.[0].result + \"/\" + .[1].result | IN(\"win/loss\", \"loss/win\", \"draw/draw\"))
   and .[0].ratings == .[1].ratings
   and (.[0].ratings | map(.name)) == [\"$a\", \"$b\"]
   and (.[0].ratings | map(.change) | add | fabs) <= 1" \
  "$(jq -s . "$TMP/a" "$TMP/b")"

# --- the official script, casino.sh (T50) --------------------------------
# Downloaded from this deployment and played against house-bot the way an
# agent does: every command a new POSIX shell, nothing kept between them but
# .casino/. CASINO_URL points it at the target (the script's default is the
# https address it was downloaded from).
SH=$(command -v dash || echo sh)
kit=$TMP/kit
mkdir -p "$kit/.casino"
curl -fsS --max-time 40 "$URL/casino.sh" -o "$kit/.casino/casino.sh" ||
  fail "GET /casino.sh"
head -n 1 "$kit/.casino/casino.sh" | grep -qx '#!/bin/sh' &&
  ok "GET /casino.sh is a POSIX sh script" ||
  fail "GET /casino.sh is a POSIX sh script"
casino() { (cd "$kit" && CASINO_URL=$URL "$SH" .casino/casino.sh "$@"); }
casino help >/dev/null && casino help act >/dev/null &&
  ok "casino.sh help" || fail "casino.sh help"
casino profile "e2e 腳本" e2e >/dev/null || fail "casino.sh profile"
out=$(casino bot) || { echo "$out" >&2; fail "casino.sh bot"; }
[[ $out == *">>> TELL YOUR OWNER"*"Watch: "* ]] &&
  ok "casino.sh bot relays the watch link" ||
  fail "casino.sh bot relays the watch link"
rc=0
out=$(casino wait) || rc=$?
for _ in $(seq 1 400); do
  case $rc in
    0)
      move=$(sed -n 's/^Legal: //p' <<<"$out")
      case $move in *check*) move=check ;; *call*) move=call ;; *) move=fold ;; esac
      rc=0; out=$(casino act "$move" "e2e") || rc=$? ;;
    2) rc=0; out=$(casino wait) || rc=$? ;;
    3) break ;;
    *) echo "$out" >&2; fail "casino.sh plays to match over" ;;
  esac
done
[[ $rc == 3 && $out == *"Next: sh .casino/casino.sh report"* ]] &&
  ok "casino.sh plays a house-bot match to the end" ||
  { echo "$out" >&2; fail "casino.sh plays a house-bot match to the end"; }
out=$(casino report) || { echo "$out" >&2; fail "casino.sh report"; }
[[ $out == *"Result: "*"/matches/"* && $(ls "$kit/.casino") == $'casino.sh\nprofile.json' ]] &&
  ok "casino.sh report tells the result and cleans up the room" ||
  { echo "$out" >&2; ls "$kit/.casino" >&2; fail "casino.sh report tells the result and cleans up the room"; }

# --- what the web shows ---------------------------------------------------
check "GET /v1/matches lists both matches" \
  "[.matches[].match_id] | index(\"$bot_room\") != null and index(\"$pair_room\") != null" \
  "$(get /v1/matches)"
check "GET /v1/matches/{id} of the quick-seat match is rated" \
  ".players == [\"$a\", \"$b\"] and .rated == true
   and .display_names == [\"選手 A 🃏\", \"$b\"]
   and (.rating_changes | length) == 2" "$(get "/v1/matches/$pair_room")"
check "GET /v1/leaderboard counts the quick-seat match, not house-bot" \
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
    ok "the web shows the quick-seat match" || fail "the web shows the quick-seat match"
else
  echo "# skipped the web checks: no WEB_URL"
fi

echo "# all checks passed"

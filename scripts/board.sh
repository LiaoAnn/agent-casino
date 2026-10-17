#!/usr/bin/env bash
# 看板：從 docs/tickets.md 的依賴、本地 branch 和 GitHub PR 推算每張 ticket 的狀態。
# 在 VM 上跑（不是容器裡），需要 git、gh、jq。沒有任何狀態是手動維護的。
set -euo pipefail

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
cd "$root"

# 每個 PR 一行：小寫 ticket 編號、PR 號、狀態、是否 needs-human、CI 燈號、網址
prs=$(gh pr list --state all --limit 300 \
  --json number,headRefName,state,labels,statusCheckRollup,url \
  --jq '.[] | select(.headRefName | test("^t[0-9]+-")) |
    [ (.headRefName | capture("^(?<id>t[0-9]+)-").id),
      .number, .state,
      (if any(.labels[]; .name == "needs-human") then "yes" else "no" end),
      ( [.statusCheckRollup[]?] as $c |
        if ($c | length) == 0 then "沒有 CI"
        elif any($c[]; (.conclusion // .state // "") | test("FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED")) then "CI 失敗"
        elif any($c[]; (.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING") then "CI 跑中"
        else "CI 綠" end ),
      .url ] | @tsv')

# 已合併的 ticket（大寫編號），用來判斷依賴有沒有解開
done_ids=" $(awk -F'\t' '$3 == "MERGED" {print toupper($1)}' <<<"$prs" | sort -u | tr '\n' ' ')"

declare -A status note
order=()

while IFS= read -r line; do
  [[ $line =~ ^###\ (T[0-9]+)\ (.+)（.*Blocked\ by：(.*)$ ]] || continue
  id=${BASH_REMATCH[1]}
  title=${BASH_REMATCH[2]}
  blockers=${BASH_REMATCH[3]//、/ }
  [[ $blockers == 無 ]] && blockers=""
  lower=${id,,}
  order+=("$id")

  merged=$(awk -F'\t' -v id="$lower" '$1 == id && $3 == "MERGED"' <<<"$prs" | head -n1)
  open=$(awk -F'\t' -v id="$lower" '$1 == id && $3 == "OPEN"' <<<"$prs" | head -n1)
  branch=$(git -C "$root" for-each-ref --format='%(refname:short)' "refs/heads/$lower-*" | head -n1)

  if [[ -n $merged ]]; then
    IFS=$'\t' read -r _ num _ _ _ _ <<<"$merged"
    status[$id]="Done"; note[$id]="$title · #$num"
  elif [[ -n $open ]]; then
    IFS=$'\t' read -r _ num _ human ci url <<<"$open"
    if [[ $human == yes ]]; then status[$id]="等你核准"; else status[$id]="PR 中"; fi
    note[$id]="$title · #$num · $ci · $url"
  elif [[ -n $branch ]]; then
    wt=$(git -C "$root" worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree /{p=$2} $0 == "branch " b {print p}')
    status[$id]="進行中"; note[$id]="$title · $branch${wt:+ · $wt}"
  else
    waiting=""
    for b in $blockers; do
      [[ $done_ids == *" $b "* ]] || waiting+="$b "
    done
    if [[ -z $waiting ]]; then
      status[$id]="Ready"; note[$id]="$title"
    else
      status[$id]="Blocked"; note[$id]="$title · 等 ${waiting% }"
    fi
  fi
done < docs/tickets.md

for col in 等你核准 "PR 中" 進行中 Ready Blocked Done; do
  echo "## $col"
  for id in $(printf '%s\n' "${order[@]}" | sort -V); do
    [[ ${status[$id]} == "$col" ]] && echo "- $id ${note[$id]}"
  done
  echo
done

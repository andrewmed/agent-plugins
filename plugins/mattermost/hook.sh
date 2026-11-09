#!/bin/sh
# $1 is the pid of claude. A hook must pass it from its own shell: "$PPID" in this script is a different process.
socket="$HOME/.config/mattermost-agents/run/$1.sock"
[ "$CLAUDE_CODE_ENTRYPOINT" = cli ] || exit 0

wake() {
  out=$(curl -s --fail --unix-socket "$socket" --data-binary @- http://mm/wait) || exit 0
  [ -n "$out" ] || exit 0
  printf '%s\n' "$out" >&2
  exit 2
}

case "$2" in
  hook)
    [ -S "$socket" ] && curl -s -m 2 --unix-socket "$socket" --data-binary @- http://mm/hook >/dev/null
    ;;
  ask)
    [ -S "$socket" ] && curl -s -m 900 --unix-socket "$socket" --data-binary @- http://mm/ask
    ;;
  wait)
    [ -S "$socket" ] && wake
    ;;
  wait-start)
    i=0
    while [ ! -S "$socket" ] && [ "$i" -lt 20 ]; do
      sleep 1
      i=$((i + 1))
    done
    [ -S "$socket" ] && wake
    ;;
esac
exit 0

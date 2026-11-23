#!/bin/sh
# Install herdr-split for the current $HOME. Usage: ./install.sh [--uninstall]
set -eu

repo=$(dirname "$(readlink -f "$0")")
mode=install
case "${1:-}" in
	"") ;;
	--uninstall) mode=uninstall ;;
	*) echo "usage: install.sh [--uninstall]" >&2; exit 2 ;;
esac

stub="export { default } from \"$repo/pi/index.ts\";"

link() { # link <target> <path>
	if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then
		[ "$mode" = install ] && { ln -sfn "$1" "$2"; echo "link $2"; return 0; }
		rm "$2"; echo "remove $2"; return 0
	fi
	if [ -e "$2" ] || [ -L "$2" ]; then
		[ "$mode" = install ] && echo "skip $2: exists"
		return 0
	fi
	[ "$mode" = install ] || return 0
	mkdir -p "$(dirname "$2")"
	ln -s "$1" "$2"
	echo "link $2"
}

stub_file() { # stub_file <path>
	# Byte-exact ownership check: $(cat) would strip trailing newlines and claim near-copies.
	if [ -f "$1" ] && [ ! -L "$1" ] && printf '%s\n' "$stub" | cmp -s - "$1"; then
		if [ "$mode" = install ]; then printf '%s\n' "$stub" > "$1"; echo "write $1"
		else rm "$1"; rmdir "$(dirname "$1")" 2>/dev/null || true; echo "remove $1"; fi
		return 0
	fi
	if [ -e "$1" ] || [ -L "$1" ]; then
		[ "$mode" = install ] && echo "skip $1: exists"
		return 0
	fi
	[ "$mode" = install ] || return 0
	mkdir -p "$(dirname "$1")"
	printf '%s\n' "$stub" > "$1"
	echo "write $1"
}

link "$repo/bin/herdr-split" "$HOME/.local/bin/herdr-split"

seen=
for dir in "$HOME/.gentle-shell/agent" "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do
	[ -n "$dir" ] && [ -d "$dir" ] || continue
	real=$(readlink -f "$dir")
	case " $seen " in *" $real "*) continue ;; esac
	seen="$seen $real"
	stub_file "$dir/extensions/split/index.ts"
done

if [ -d "$HOME/.claude" ]; then
	link "$repo/claude/split.md" "$HOME/.claude/commands/split.md"
fi

if [ "$mode" = install ]; then
	for tool in fzf herdr; do
		command -v "$tool" >/dev/null 2>&1 || echo "warning: $tool not found on PATH" >&2
	done
fi

#!/usr/bin/env bash
# Verify generated OpenCode Android packages before upload/release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

PKG_DIR="${1:-$WORK_DIR/packages}"
TMP_DIR="${TMPDIR:-/tmp}/opencode-package-verify.$$"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

die() {
    echo "ERROR: $*" >&2
    exit 1
}

check_elf_aarch64() {
    local file="$1"
    local name="$2"
    local machine
    machine=$(od -An -t x1 -j 18 -N 2 "$file" | tr -d ' ')
    [ "$machine" = "b700" ] || die "$name is not AArch64 (e_machine=$machine)"
}

check_no_glibc_deps() {
    local file="$1"
    local name="$2"
    local needed
    needed=$(readelf -d "$file" 2>/dev/null | grep 'Shared library:' || true)
    if echo "$needed" | grep -Eq 'libc\.so\.6|libpthread\.so\.0|libdl\.so\.2|libutil\.so\.1'; then
        echo "$needed" >&2
        die "$name is linked against Linux/glibc libraries"
    fi
}

check_needed() {
    local file="$1"
    local name="$2"
    local library="$3"
    readelf -d "$file" 2>/dev/null | grep -q "Shared library: \\[$library\\]" \
        || die "$name is missing NEEDED: $library"
}

# Guard against the regression that shipped opencode 1.18.34 with a crashing
# startup: the module-graph patch in build-opencode-android.ts must rewrite
# __reExport(<ident>, undici) to __reExport(<ident>, Undici), otherwise the
# binary dies immediately with "ReferenceError: undici is not defined".
check_undici_patch() {
    local file="$1"
    local name="$2"

    if grep -qaF '__reExport(exports_Undici,undici)' "$file" \
        || grep -qaF '__reExport(exports_Undici, undici)' "$file"; then
        die "$name contains an unpatched __reExport(..., undici) reference (crashes with 'ReferenceError: undici is not defined')"
    fi

    if grep -qaF '__reExport(exports_Undici,Undici)' "$file"; then
        echo "    $name: undici reExport patch present"
    else
        echo "    WARNING: $name: patched undici marker not found (bundler output may have changed)" >&2
    fi
}

# Guard against the second startup crash: opentui calls
# normalizeLoadedFilePath() with the default export of the tree-sitter worker
# asset at module top level, but parser.worker.js is side-effect-only
# (`export {};`), so the value is undefined and the TUI dies with
# "undefined is not an object (evaluating 'loadedPath.startsWith')".
# build-opencode.sh inserts a null guard; fail the package if it is missing.
check_opentui_null_guard() {
    local file="$1"
    local name="$2"
    python3 - "$file" "$name" <<'PY' || die "opentui normalizeLoadedFilePath null-guard check failed"
import re
import sys

path, name = sys.argv[1], sys.argv[2]
data = open(path, "rb").read()
i = data.find(b"function normalizeLoadedFilePath")
if i == -1:
    print(f"    WARNING: {name}: normalizeLoadedFilePath not found (opentui layout may have changed)", file=sys.stderr)
    sys.exit(0)
brace = data.find(b"{", i)
if brace == -1 or brace - i > 200:
    raise SystemExit(f"ERROR: {name}: normalizeLoadedFilePath header looks malformed")
header = data[i:brace].decode("latin-1")
m = re.search(r"function\s+normalizeLoadedFilePath\w*\s*\(\s*([\w$]+)", header)
if not m:
    raise SystemExit(f"ERROR: {name}: could not parse normalizeLoadedFilePath parameters")
param = m.group(1)
body = data[brace + 1:brace + 121].decode("latin-1")
if not re.search(r"if\s*\(\s*" + re.escape(param) + r"\s*==\s*null", body):
    raise SystemExit(f"ERROR: {name}: normalizeLoadedFilePath lacks the null guard (crashes startup with 'loadedPath.startsWith')")
print(f"    {name}: opentui normalizeLoadedFilePath null guard present")
PY
}

check_wrapper() {
    local wrapper="$1"
    grep -q '../libexec/opencode/opencode.bin' "$wrapper" \
        || die "$wrapper does not include the package libexec opencode.bin path"
    python3 - "$wrapper" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read()
libexec = text.find('"$dir/../libexec/opencode/opencode.bin"')
flat = text.find('"$dir/opencode.bin"')
if libexec == -1 or flat == -1 or libexec > flat:
    raise SystemExit("wrapper must prefer libexec opencode.bin before flat opencode.bin")
PY
}

check_tree() {
    local root="$1"
    local prefix="$root/data/data/com.termux/files/usr"
    [ -x "$prefix/bin/opencode" ] || die "missing executable wrapper in $root"
    [ -x "$prefix/libexec/opencode/opencode.bin" ] || die "missing executable opencode.bin in $root"
    [ -f "$prefix/lib/libtagfix.so" ] || die "missing libtagfix.so in $root"
    [ -f "$prefix/lib/libopentui.so" ] || die "missing libopentui.so in $root"

    check_wrapper "$prefix/bin/opencode"
    check_elf_aarch64 "$prefix/libexec/opencode/opencode.bin" "opencode.bin"
    check_undici_patch "$prefix/libexec/opencode/opencode.bin" "opencode.bin"
    check_opentui_null_guard "$prefix/libexec/opencode/opencode.bin" "opencode.bin"
    check_elf_aarch64 "$prefix/lib/libtagfix.so" "libtagfix.so"
    check_elf_aarch64 "$prefix/lib/libopentui.so" "libopentui.so"
    check_no_glibc_deps "$prefix/lib/libopentui.so" "libopentui.so"
    check_needed "$prefix/lib/libopentui.so" "libopentui.so" "libc.so"

    if [ -f "$prefix/lib/librust_pty_arm64.so" ]; then
        check_elf_aarch64 "$prefix/lib/librust_pty_arm64.so" "librust_pty_arm64.so"
        check_no_glibc_deps "$prefix/lib/librust_pty_arm64.so" "librust_pty_arm64.so"
    fi
}

check_zip() {
    local zip_file="$1"
    local root="$TMP_DIR/zip"
    rm -rf "$root"
    mkdir -p "$root"
    unzip -q "$zip_file" -d "$root"

    [ -x "$root/opencode" ] || die "zip missing executable wrapper"
    [ -x "$root/opencode.bin" ] || die "zip missing executable opencode.bin"
    [ -f "$root/libtagfix.so" ] || die "zip missing libtagfix.so"
    [ -f "$root/libopentui.so" ] || die "zip missing libopentui.so"
    [ -f "$root/libc++_shared.so" ] || die "zip missing libc++_shared.so"

    check_wrapper "$root/opencode"
    check_elf_aarch64 "$root/opencode.bin" "zip opencode.bin"
    check_undici_patch "$root/opencode.bin" "zip opencode.bin"
    check_opentui_null_guard "$root/opencode.bin" "zip opencode.bin"
    check_elf_aarch64 "$root/libtagfix.so" "zip libtagfix.so"
    check_elf_aarch64 "$root/libopentui.so" "zip libopentui.so"
    check_elf_aarch64 "$root/libc++_shared.so" "zip libc++_shared.so"
    check_no_glibc_deps "$root/libopentui.so" "zip libopentui.so"
    check_needed "$root/libopentui.so" "zip libopentui.so" "libc.so"

    if [ -f "$root/librust_pty_arm64.so" ]; then
        check_elf_aarch64 "$root/librust_pty_arm64.so" "zip librust_pty_arm64.so"
        check_no_glibc_deps "$root/librust_pty_arm64.so" "zip librust_pty_arm64.so"
    fi
}

[ -d "$PKG_DIR" ] || die "package dir not found: $PKG_DIR"
mkdir -p "$TMP_DIR"

DEB_FILE="$PKG_DIR/opencode_${OPENCODE_VERSION}_aarch64.deb"
PACMAN_FILE="$PKG_DIR/opencode-${OPENCODE_VERSION}-1-aarch64.pkg.tar.xz"
ZIP_FILE="$PKG_DIR/opencode-${OPENCODE_VERSION}-android-aarch64.zip"

[ -f "$DEB_FILE" ] || die "missing $DEB_FILE"
[ -f "$PACMAN_FILE" ] || die "missing $PACMAN_FILE"
[ -f "$ZIP_FILE" ] || die "missing $ZIP_FILE"

echo ">>> Verifying deb package"
DEB_ROOT="$TMP_DIR/deb"
mkdir -p "$DEB_ROOT"
dpkg-deb -x "$DEB_FILE" "$DEB_ROOT"
check_tree "$DEB_ROOT"

echo ">>> Verifying pacman package"
PACMAN_ROOT="$TMP_DIR/pacman"
mkdir -p "$PACMAN_ROOT"
tar -xJf "$PACMAN_FILE" -C "$PACMAN_ROOT"
check_tree "$PACMAN_ROOT"

echo ">>> Verifying zip package"
check_zip "$ZIP_FILE"

echo "PASS: packages verified"

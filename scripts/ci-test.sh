#!/usr/bin/env bash
# GitHub's disposable Linux runners: keep temporary test database I/O off disk.
# The cap limits storage allocation, not total process RAM. Local commands do
# not use this wrapper; all real SQLite/Worker storage semantics stay enabled.
set -euo pipefail

test_tmp=$(mktemp -d)
sudo mount -t tmpfs -o "size=512m,mode=0700,uid=$(id -u),gid=$(id -g)" tmpfs "$test_tmp"
trap 'sudo umount "$test_tmp"; rmdir "$test_tmp"' EXIT
TMPDIR="$test_tmp" "$@"

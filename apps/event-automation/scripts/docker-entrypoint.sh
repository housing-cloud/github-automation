#!/bin/sh
set -eu

mkdir -p /data
chown -R bun:bun /data
exec gosu bun "$@"

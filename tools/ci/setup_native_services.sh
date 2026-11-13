#!/bin/sh
# Owned CI-only binaries; never install a global service or reuse a shared database.
set -eu
if [ "${CI:-}" != true ]; then
  echo 'This helper is for disposable CI runners only.' >&2
  exit 2
fi
ca_repo_dir=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
ca_tools_dir="$ca_repo_dir/.runtime/ci-services"
mkdir -p "$ca_tools_dir"
ca_build_dir=$(mktemp -d "$ca_tools_dir/.build-XXXXXX")
trap 'rm -rf -- "$ca_build_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ca_jobs=${CODE_ALONG_BUILD_JOBS:-2}
case "$ca_jobs" in 1|2|3|4) ;; *) echo 'Build jobs must be 1–4.' >&2; exit 2;; esac

if [ ! -x "$ca_tools_dir/postgres/bin/postgres" ] || [ "$("$ca_tools_dir/postgres/bin/postgres" --version)" != 'postgres (PostgreSQL) 18.7' ]; then
  echo 'Building checksum-pinned PostgreSQL 18.7 in the owned CI prefix.'
  curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
    https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2 -o "$ca_build_dir/postgres.tar.bz2"
  printf '441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd  %s\n' "$ca_build_dir/postgres.tar.bz2" | sha256sum --check --status
  mkdir "$ca_build_dir/postgres"
  tar -xjf "$ca_build_dir/postgres.tar.bz2" --strip-components=1 -C "$ca_build_dir/postgres"
  (
    cd "$ca_build_dir/postgres"
    ./configure --prefix="$ca_tools_dir/postgres" --without-icu --without-readline --without-zlib > "$ca_tools_dir/postgres-build.log" 2>&1
    make -j"$ca_jobs" >> "$ca_tools_dir/postgres-build.log" 2>&1
    make install >> "$ca_tools_dir/postgres-build.log" 2>&1
  )
fi

if [ ! -x "$ca_tools_dir/redis/redis-server" ] || ! "$ca_tools_dir/redis/redis-server" --version | grep -q 'v=8.4.5 '; then
  echo 'Building checksum-pinned Redis 8.4.5 in the owned CI prefix.'
  curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
    https://codeload.github.com/redis/redis/legacy.tar.gz/b20532c3bc99081bdd490e8885f747a6a616511d -o "$ca_build_dir/redis.tar.gz"
  printf '7c89ab557600dcfb9263d7c825b63746fcafc5188abfed0d81f4fcf34b1770eb  %s\n' "$ca_build_dir/redis.tar.gz" | sha256sum --check --status
  mkdir "$ca_build_dir/redis"
  tar -xzf "$ca_build_dir/redis.tar.gz" --strip-components=1 -C "$ca_build_dir/redis"
  make -C "$ca_build_dir/redis" -j"$ca_jobs" MALLOC=libc BUILD_TLS=no > "$ca_tools_dir/redis-build.log" 2>&1
  mkdir -p "$ca_tools_dir/redis"
  install -m 755 "$ca_build_dir/redis/src/redis-server" "$ca_tools_dir/redis/redis-server"
fi
"$ca_tools_dir/postgres/bin/postgres" --version
"$ca_tools_dir/redis/redis-server" --version
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CODE_ALONG_POSTGRES_BIN=%s/postgres/bin\nCODE_ALONG_REDIS_BIN=%s/redis/redis-server\n' "$ca_tools_dir" "$ca_tools_dir" >> "$GITHUB_ENV"
fi

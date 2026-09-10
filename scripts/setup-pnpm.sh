#!/usr/bin/env bash
# GitHub Actions only: isolate Corepack from the runner's global tooling.
set -euo pipefail

: "${RUNNER_TEMP:?GitHub Actions must provide RUNNER_TEMP}"
: "${GITHUB_PATH:?GitHub Actions must provide GITHUB_PATH}"
: "${GITHUB_OUTPUT:?GitHub Actions must provide GITHUB_OUTPUT}"

corepack_directory="${RUNNER_TEMP}/card-keepr-corepack"
npm install --prefix "${corepack_directory}" --no-audit --no-fund corepack@0.35.0
export PATH="${corepack_directory}/node_modules/.bin:${PATH}"
corepack enable --install-directory "${corepack_directory}/node_modules/.bin" pnpm
echo "${corepack_directory}/node_modules/.bin" >> "${GITHUB_PATH}"

# packageManager includes Corepack's integrity hash. Version selection and
# download verification belong to Corepack; pnpm's self-management is disabled.
node --version
corepack --version
command -v node corepack pnpm
pnpm_version="$(pnpm --version)"
echo "pnpm ${pnpm_version}"
echo "version=${pnpm_version}" >> "${GITHUB_OUTPUT}"
echo "store-path=$(pnpm store path --silent)" >> "${GITHUB_OUTPUT}"

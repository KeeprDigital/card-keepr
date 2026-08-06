#!/usr/bin/env bash
set +e

release_directory="${1:-/tmp/production-release}"
config="${RELEASE_STATE_CONFIG:-apps/ingestion/wrangler.jsonc}"
handler_status=0
migration_started=0
failure_recorded=0
production_releases_available=0

if test -f "${release_directory}/failure-evidence.sql"; then
  failure_result="$(npx wrangler d1 execute CATALOGUE_DB --remote --json --config "${config}" --file "${release_directory}/failure-evidence.sql")"
  failure_command_status=$?
  if test "${failure_command_status}" -eq 0; then
    migration_started="$(jq -r '.[-1].results[0].migration_started // 0' <<<"${failure_result}")"
    failure_recorded="$(jq -r '.[-1].results[0].failure_recorded // 0' <<<"${failure_result}")"
    test "${migration_started}" = 0 || test "${failure_recorded}" = 1
    test $? -eq 0 || handler_status=1
  else
    handler_status=1
  fi
fi

if test -f "${release_directory}/post-schema-status.sql"; then
  schema_result="$(npx wrangler d1 execute CATALOGUE_DB --remote --json --config "${config}" --file "${release_directory}/post-schema-status.sql")"
  schema_command_status=$?
  if test "${schema_command_status}" -eq 0; then
    production_releases_available="$(jq -r '.[-1].results[0].production_releases_available // 0' <<<"${schema_result}")"
  else
    handler_status=1
  fi
fi

if test "${migration_started}" = 1 && test "${production_releases_available}" = 1; then
  failed_result="$(npx wrangler d1 execute CATALOGUE_DB --remote --json --config "${config}" --file "${release_directory}/failed.sql")"
  failed_command_status=$?
  if test "${failed_command_status}" -eq 0; then
    test "$(jq -r '.[-1].results[0].transitioned_rows // 0' <<<"${failed_result}")" -le 1
    test $? -eq 0 || handler_status=1
    test "$(jq -r '.[-1].results[0].failed // 0' <<<"${failed_result}")" = 1
    test $? -eq 0 || handler_status=1
  else
    handler_status=1
  fi
fi

# Cleanup is deliberately independent of every earlier result.
if test -f "${release_directory}/cleanup.sql"; then
  cleanup_result="$(npx wrangler d1 execute CATALOGUE_DB --remote --json --config "${config}" --file "${release_directory}/cleanup.sql")"
  cleanup_command_status=$?
  if test "${cleanup_command_status}" -eq 0; then
    test "$(jq -r '.[-1].results[0].fence_released // 0' <<<"${cleanup_result}")" = 1
    test $? -eq 0 || handler_status=1
  else
    handler_status=1
  fi
fi

exit "${handler_status}"

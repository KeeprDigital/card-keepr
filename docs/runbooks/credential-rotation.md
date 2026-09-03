# Runbook: rotating a worker bearer key

Per ADR 0005, rotating a bearer key is an operator procedure with no
attestation. Each worker accepts a primary key and a replacement key at the
same time, so a rotation never has a gap: set the replacement, verify it with
a health call, promote it, clear the old value, then record the rotation in
the append-only log. Any operator with Wrangler access to the Cloudflare
account and the current keys can perform it; the checks below are the only
verification.

| Worker | Primary secret | Replacement secret | Wrangler config | Log `credential_class` |
| --- | --- | --- | --- | --- |
| `card-keepr-api` | `API_BEARER_KEY` | `API_BEARER_KEY_REPLACEMENT` | `apps/api/wrangler.jsonc` | `api_bearer_key` |
| `card-keepr-ingestion` | `ADMINISTRATION_KEY` | `ADMINISTRATION_KEY_REPLACEMENT` | `apps/ingestion/wrangler.jsonc` | `ingestion_admin_key` |

Both slots must always hold a value: the guarded Production Release verifies
that every expected secret name is bound, so a slot is cleared by overwriting
it, never with `wrangler secret delete`.

Provider-side credentials (the Cloudflare deployment token, the GitHub
`production` environment secrets, and the D1 export and verification tokens)
are not worker bearer keys. They are rotated in the provider consoles and are
neither observed nor logged by the worker; #76 tracks their runbook.

## Prepare

1. Authenticate Wrangler (`npx wrangler whoami`) against the production
   account, and export the deployed runtime URLs plus the current keys:

```sh
export KEEPR_API_URL='https://card.keepr.digital/api'
export KEEPR_INGESTION_URL='https://card.keepr.digital/ingest'
export KEEPR_API_KEY='<current API bearer key>'
export KEEPR_ADMINISTRATION_KEY='<current administration key>'
npm run keepr -- health --json
```

   Both runtimes must report `status: "ok"` before starting.

2. Generate the replacement. Bearer keys use token68 characters and must
   encode at least 128 bits; 48 random bytes gives a 64-character key:

```sh
REPLACEMENT="$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-64)"
```

   Keep it in the shell only. It is never pasted into an issue, a commit, or
   the rotation log.

The steps below use the ingestion worker; repeat them with the API worker's
row from the table for `API_BEARER_KEY`.

## Set the replacement

```sh
printf '%s' "$REPLACEMENT" | npx wrangler secret put ADMINISTRATION_KEY_REPLACEMENT \
  --config apps/ingestion/wrangler.jsonc
```

Wrangler binds the new secret to the live deployment immediately; the primary
key is untouched, so existing Catalogue Consumers and operators keep working.

## Verify with a health call

The health route authenticates like every other route, so a `200` proves the
replacement is live in that worker's bindings. Each worker is mounted under
the path of its base URL, so the health routes are
`https://card.keepr.digital/ingest/health` and
`https://card.keepr.digital/api/health`:

```sh
curl -fsS -H "Authorization: Bearer $REPLACEMENT" "$KEEPR_INGESTION_URL/health"
curl -fsS -H "Authorization: Bearer $KEEPR_ADMINISTRATION_KEY" "$KEEPR_INGESTION_URL/health"
```

Both calls must return `card-keepr-runtime-health@1` with `status: "ok"`.
For the API worker use `$KEEPR_API_URL/health` with the API keys. If the
replacement call fails, stop: overwrite the replacement slot again (see
"Clear the old value") and investigate before touching the primary.

## Promote

Write the replacement into the primary slot, then re-verify:

```sh
printf '%s' "$REPLACEMENT" | npx wrangler secret put ADMINISTRATION_KEY \
  --config apps/ingestion/wrangler.jsonc
curl -fsS -H "Authorization: Bearer $REPLACEMENT" "$KEEPR_INGESTION_URL/health"
```

Now distribute the key: update every operator's `KEEPR_ADMINISTRATION_KEY`
(or `KEEPR_API_KEY` and each Catalogue Consumer for the API worker). The old
key keeps working only while it still occupies a slot, which it no longer
does after this step; a Catalogue Consumer that fails from here on is one
that was not updated.

## Clear the old value

Overwrite the replacement slot with a fresh random value that is discarded
without being recorded anywhere, so the slot never holds a distributed key
outside a rotation:

```sh
openssl rand -base64 48 | tr -d '/+=' | cut -c1-64 | npx wrangler secret put \
  ADMINISTRATION_KEY_REPLACEMENT --config apps/ingestion/wrangler.jsonc
export KEEPR_ADMINISTRATION_KEY="$REPLACEMENT"
npm run keepr -- health --json
unset REPLACEMENT
```

## Record the rotation

Append one entry to the immutable rotation log. The idempotency key is the
operator's; replaying it returns the original entry, and reusing it with a
different note is refused as a conflict:

```sh
curl -fsS -X POST "$KEEPR_INGESTION_URL/v1/credential-rotation-log" \
  -H "Authorization: Bearer $KEEPR_ADMINISTRATION_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "credential_class": "ingestion_admin_key",
    "operator_note": "Scheduled quarterly rotation; verified with health calls.",
    "idempotency_key": "rotation_ingestion_admin_key_2026-09-02_1"
  }'
```

The response is `card-keepr-credential-rotation-log-entry@1` with the
worker-recorded `recorded_at`. Read the history back at any time:

```sh
curl -fsS -H "Authorization: Bearer $KEEPR_ADMINISTRATION_KEY" \
  "$KEEPR_INGESTION_URL/v1/credential-rotation-log"
```

Entries are append-only: the database refuses updates and deletes, and the
`credential_class` is limited to the two worker bearer keys.

## Failure paths

- **Replacement verification fails**: the primary is untouched and nothing
  has been distributed. Overwrite the replacement slot and retry from "Set
  the replacement".
- **Promotion fails after `secret put`**: the replacement slot still holds
  the same value, so consumers already holding it keep working. Re-run the
  promote command; do not distribute the old key again.
- **A Catalogue Consumer is locked out after clearing**: it still presents the
  old key.
  Give it the new key; do not reinstate the old value, which would extend the
  key's life past its recorded rotation.
- **A rotation was performed but not logged**: append the entry late with a
  note saying so. The log records operator intent; `recorded_at` is when the
  entry was written, not when the secret changed.

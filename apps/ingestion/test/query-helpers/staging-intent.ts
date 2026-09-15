/** Restore exactly the acknowledged protocol rows captured from the former HTTP boundary. */
export async function seedRetainedStagingIntent(
  database: D1Database,
  fixture: {
    choices: { release_id: string; idempotency_key: string };
    request_json: string;
    response: { intent: { authorized_at: string } };
  },
) {
  for (const key of [`staging-intent:${fixture.choices.release_id}`, fixture.choices.idempotency_key])
    await database
      .prepare(
        `INSERT INTO administration_idempotency
      (idempotency_key, operation, request_json, response_json, http_status, outcome, created_at)
      VALUES (?, 'prepare_staging_release', ?, ?, 201, 'success', ?)`,
      )
      .bind(key, fixture.request_json, JSON.stringify(fixture.response), fixture.response.intent.authorized_at)
      .run();
}

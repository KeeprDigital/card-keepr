// Published storage retains administrative evidence for inspection and recovery.
// Apply this projection only when serializing accepted facts for consumers.
const administrativeFields = new Set([
  "provenance",
  "curated_provenance",
  "disagreements",
  "evidence",
  "evidence_category",
  "source_lineage",
  "source_lineages",
  "source_observation_id",
  "source_observation_ids",
  "source_observation_pointer",
  "source_field_pointers",
  "relationship_evidence",
  "locator_evidence",
  "source_buckets",
  "source_freshness",
  "last_successful_checks",
  "confidence",
  "confirmation",
  "publisher_confirmation",
  "source_health",
  "admission",
  "admission_status",
  "legality",
  "legality_rules",
  "legality_status",
  "eligibility",
]);

export function consumerContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(consumerContent);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      administrativeFields.has(key)
        ? []
        : [
            [
              key,
              // Game Profiles own card attributes and their schemas; metadata names here
              // must never erase an identically named rules-level game attribute.
              key === "game_data" || key === "schema" ? item : consumerContent(item),
            ],
          ],
    ),
  );
}

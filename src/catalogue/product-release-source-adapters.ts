type ProductSourceGame = "one-piece" | "fusion-world" | "gundam";

export function productCatalogueAdapter(
  wrapper: "official_card_results" | "card_items" | "search_results",
  game: ProductSourceGame,
): (document: unknown) => readonly unknown[] {
  return (document) => {
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document) ||
      !Array.isArray((document as Record<string, unknown>)[wrapper])
    ) {
      return canonicalSourceRecords(document);
    }
    return ((document as Record<string, unknown>)[wrapper] as unknown[]).map(
      (value) => rawProductObservation(value, game),
    );
  };
}

function rawProductObservation(
  value: unknown,
  game: ProductSourceGame,
): Record<string, unknown> {
  const raw = requiredRecord(value, "Official Product record");
  const card = requiredRecord(raw.card_record, "Official card_record");
  const product = requiredRecord(
    raw.product_record,
    "Official product_record",
  );
  const distribution = requiredRecord(
    raw.distribution_record,
    "Official distribution_record",
  );
  const productCode = requiredText(product.code, "Official Product code");
  const distributionCode = requiredText(
    distribution.code,
    "Official Distribution code",
  );
  const productReference = {
    kind: "official_code",
    value: productCode,
  };
  return {
    completeness: raw.completeness,
    card: {
      game,
      official_identity: {
        kind: "card_number",
        value: requiredText(card.number, "Official Card number"),
      },
      name: requiredText(card.name, "Official Card name"),
      effective_rules_text: requiredText(
        card.rules_text,
        "Official Card rules text",
      ),
      game_data: {
        profile: requiredText(card.profile, "Official Game Profile"),
        attributes: card.attributes,
      },
    },
    memberships: {
      products: [],
      distribution_contexts: [],
      source_buckets:
        typeof raw.source_bucket === "string"
          ? [raw.source_bucket]
          : [],
    },
    product_release_catalogue: {
      products: [{
        reference: productReference,
        official_code: productCode,
        name: requiredText(product.name, "Official Product name"),
        releases: [{
          region: product.release_region,
          date: {
            precision: product.release_date_precision,
            value: product.release_date,
          },
          status: product.release_status,
        }],
      }],
      distribution_contexts: [{
        key: distributionCode,
        kind: distribution.kind,
        label: distribution.label,
        product_reference: productReference,
        evidence_category: "explicit",
      }],
      relationships: [
        {
          kind: "distribution-context-product",
          context_key: distributionCode,
          product_reference: productReference,
          evidence_category: "explicit",
          resolution: "explicit",
        },
        {
          kind: "product-card",
          product_reference: productReference,
          card_reference: { kind: "current_card" },
          evidence_category: "explicit",
          resolution: "explicit",
        },
      ],
    },
  };
}

function canonicalSourceRecords(document: unknown): readonly unknown[] {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
  ) {
    const record = document as {
      cards?: unknown;
      product_surfaces?: unknown;
    };
    if (
      Array.isArray(record.cards) ||
      Array.isArray(record.product_surfaces)
    ) {
      return [
        ...(Array.isArray(record.cards) ? record.cards : []),
        ...(Array.isArray(record.product_surfaces)
          ? record.product_surfaces
          : []),
      ];
    }
  }
  return [document];
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

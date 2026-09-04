export async function removeErrataTargetGuards(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS reconciled_card_erratum_target_is_valid"),
    database.prepare("DROP TRIGGER IF EXISTS reconciled_printing_erratum_target_is_valid"),
  ]);
}
export function erratumCount(database: D1Database, id: string): D1PreparedStatement {
  return database.prepare("SELECT COUNT(*) AS count FROM reconciled_errata WHERE id = ?").bind(id);
}
export function publishedErratumTarget(database: D1Database, kind: "card" | "printing"): D1PreparedStatement {
  return kind === "card"
    ? database.prepare("SELECT id FROM reconciled_cards WHERE supported_game = 'one-piece' LIMIT 1")
    : database.prepare(
        "SELECT printing.id FROM reconciled_printings AS printing JOIN reconciled_cards AS card ON card.id = printing.card_id WHERE card.supported_game = 'one-piece' LIMIT 1",
      );
}

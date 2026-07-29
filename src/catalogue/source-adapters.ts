import { AdministrationProblem } from "./ingestion";

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumJsonBytes: number;
  parse: (document: unknown) => readonly unknown[];
}>;

const parseOnePieceCardDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document) &&
    Array.isArray((document as { cards?: unknown }).cards)
  ) {
    return (document as { cards: unknown[] }).cards;
  }
  return [document];
};

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
      {
        adapterVersion: "one-piece-json-document@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        parse: parseOnePieceCardDocument,
      },
      {
        adapterVersion: "one-piece-json-document@2",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        parse: parseOnePieceCardDocument,
      },
    ].map((adapter) => Object.freeze(adapter)),
  );

const installedAdapters = new Map<string, SourceAdapterRegistration>(
  sourceAdapterRegistrations.map((adapter) => [
    adapter.adapterVersion,
    adapter,
  ]),
);

export function requiredSourceAdapter(
  adapterVersion: string,
): SourceAdapterRegistration {
  const adapter = installedAdapters.get(adapterVersion);
  if (adapter === undefined) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not installed.",
    );
  }
  return adapter;
}

export function assertAdapterBinding(
  adapter: SourceAdapterRegistration,
  input: {
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion?: string;
  },
): void {
  if (
    adapter.sourceLineage !== input.sourceLineage ||
    adapter.supportedGame !== input.supportedGame ||
    (input.gameProfileVersion !== undefined &&
      adapter.gameProfileVersion !== input.gameProfileVersion)
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_binding_mismatch",
      "The adapter version is not registered for this Supported Game, Game Profile, and Official Source lineage.",
    );
  }
}

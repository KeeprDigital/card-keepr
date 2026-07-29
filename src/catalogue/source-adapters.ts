import { AdministrationProblem } from "./ingestion";

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  maximumJsonBytes: number;
}>;

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
    {
      adapterVersion: "one-piece-json-document@1",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      gameProfileVersion: "one-piece@1",
      maximumJsonBytes: 1024 * 1024,
    },
    {
      adapterVersion: "one-piece-json-document@2",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      gameProfileVersion: "one-piece@1",
      maximumJsonBytes: 1024 * 1024,
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

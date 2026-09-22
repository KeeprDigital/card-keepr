import type { SourceAdapterRegistration } from "../adapters";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  admittedDiscoveryRequestsStatement,
  admittedDiscoveryRoleCountStatement,
  discoverySelectionMaximumGuardStatement,
  insertDiscoveryDeferralStatement,
} from "./discovery-selection-repository";

type DiscoveredRole = "listing" | "detail" | "product_detail" | "image";

/**
 * A plan's bounded selection of one discovered request role (#409): an image
 * tranche. Requests of `role` are admitted only when their claiming record's
 * selection group is listed (when `groups` is present) and, in the retained
 * discovery order, while the run holds fewer than `maximum_requests` of that
 * role (when present). Every other request of that role is explicitly
 * deferred: counted with its group, never acquired by this run. Other roles
 * are unaffected.
 */
export type DiscoverySelection = Readonly<{
  role: DiscoveredRole;
  groups?: readonly string[];
  maximum_requests?: number;
}>;

export const maximumSelectionGroups = 2000;
const groupPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Validate and canonicalize a plan's selection against its scope. */
export function validatedDiscoverySelection(
  adapter: Pick<SourceAdapterRegistration, "selectableDiscoveryRoles" | "requestCapacity" | "discoverySelectionGroup">,
  value: unknown,
): DiscoverySelection {
  const invalid = (detail: string) => new AdministrationProblem(422, "invalid_parameter", detail);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("discovery_selection must be an object.");
  const { role, groups, maximum_requests: maximum, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw invalid("discovery_selection has an unknown field.");
  if (typeof role !== "string" || !(adapter.selectableDiscoveryRoles ?? []).some((allowed) => allowed === role))
    throw new AdministrationProblem(
      422,
      "unsupported_discovery_selection",
      "The plan's scope does not permit selecting discovered requests of this role.",
    );
  if (groups === undefined && maximum === undefined)
    throw invalid("discovery_selection must select by groups, maximum_requests or both.");
  const selection: { role: DiscoveredRole; groups?: string[]; maximum_requests?: number } = {
    role: role as DiscoveredRole,
  };
  if (groups !== undefined) {
    if (adapter.discoverySelectionGroup === undefined)
      throw new AdministrationProblem(
        422,
        "unsupported_discovery_selection",
        "The adapter declares no selection group for discovered requests.",
      );
    if (!Array.isArray(groups) || groups.length < 1 || groups.length > maximumSelectionGroups)
      throw invalid(`discovery_selection.groups must list between 1 and ${maximumSelectionGroups} groups.`);
    if (groups.some((group) => typeof group !== "string" || !groupPattern.test(group)))
      throw invalid("discovery_selection.groups must be lowercase source group codes.");
    const sorted = [...new Set(groups as string[])].sort();
    if (sorted.length !== groups.length) throw invalid("discovery_selection.groups must be unique.");
    selection.groups = sorted;
  }
  if (maximum !== undefined) {
    if (!Number.isSafeInteger(maximum) || (maximum as number) < 1 || (maximum as number) > adapter.requestCapacity)
      throw invalid("discovery_selection.maximum_requests must be a positive integer within the Request Capacity.");
    selection.maximum_requests = maximum as number;
  }
  return selection;
}

export type SelectableRequest = Readonly<{ id: string; role: string; selectionGroup?: string | null }>;

/**
 * Partition one discovery batch under a plan's selection. Requests the run
 * already holds stay admitted without consuming the maximum, so replaying a
 * committed batch reproduces its outcome; new requests consume it in order.
 */
export function partitionDiscoveredRequests<T extends SelectableRequest>(
  selection: DiscoverySelection | undefined,
  requests: readonly T[],
  admitted: ReadonlySet<string>,
  admittedRoleCount: number,
): { selected: T[]; deferred: T[] } {
  if (selection === undefined) return { selected: [...requests], deferred: [] };
  const groups = selection.groups === undefined ? null : new Set(selection.groups);
  let held = admittedRoleCount;
  const selected: T[] = [];
  const deferred: T[] = [];
  for (const request of requests) {
    if (request.role !== selection.role || admitted.has(request.id)) {
      selected.push(request);
    } else if (groups !== null && (request.selectionGroup == null || !groups.has(request.selectionGroup))) {
      deferred.push(request);
    } else if (selection.maximum_requests !== undefined && held >= selection.maximum_requests) {
      deferred.push(request);
    } else {
      held++;
      selected.push(request);
    }
  }
  return { selected, deferred };
}

/** The group a deferral is counted under; ungrouped requests share one key. */
export const ungroupedSelectionKey = "-";

/**
 * Select one normalized discovery batch under its plan's selection. Returns
 * the requests to admit, the deferral receipt to write in the same atomic
 * batch (null when nothing is deferred), and, under a maximum, a guard that
 * aborts the batch if a concurrent admission filled the maximum first.
 */
export async function selectedDiscoveryRequests<T extends SelectableRequest>(
  database: CatalogueStore,
  runId: string,
  plan: Readonly<{ source_lineage: string; discovery_selection?: DiscoverySelection }>,
  parentRequestId: string,
  requests: readonly T[],
): Promise<{
  selected: T[];
  deferral: { statement: D1PreparedStatement } | null;
  maximumGuard: { statement: D1PreparedStatement; exceeded: () => Promise<boolean> } | null;
}> {
  const selection = plan.discovery_selection;
  const candidates = selection === undefined ? [] : requests.filter(({ role }) => role === selection.role);
  if (selection === undefined || candidates.length === 0)
    return { selected: [...requests], deferral: null, maximumGuard: null };
  const lineagePattern = `${plan.source_lineage}:%`;
  const counted = { runId, role: selection.role, lineagePattern };
  // Only a maximum depends on what the run already holds; a group decision is
  // a pure function of the request, so replays reproduce it without reads.
  const [admittedRows, roleCount] =
    selection.maximum_requests === undefined
      ? [{ results: [] }, { count: 0 }]
      : await Promise.all([
          admittedDiscoveryRequestsStatement(database, runId, JSON.stringify(candidates.map(({ id }) => id))).all<{
            request_id: string;
          }>(),
          admittedDiscoveryRoleCountStatement(database, counted).first<{ count: number }>(),
        ]);
  if (roleCount === null) throw new Error("The admitted discovery count is unavailable.");
  const admitted = new Set(admittedRows.results.map(({ request_id }) => request_id));
  const { selected, deferred } = partitionDiscoveredRequests(selection, requests, admitted, roleCount.count);
  const newlySelected = selected.filter(({ role, id }) => role === selection.role && !admitted.has(id)).length;
  const maximum = selection.maximum_requests;
  const maximumGuard =
    maximum === undefined || newlySelected === 0
      ? null
      : {
          statement: discoverySelectionMaximumGuardStatement(database, { ...counted, maximum }),
          exceeded: async () => {
            const recount = await admittedDiscoveryRoleCountStatement(database, counted).first<{ count: number }>();
            return recount === null || recount.count + newlySelected > maximum;
          },
        };
  if (deferred.length === 0) return { selected, deferral: null, maximumGuard };
  const ids = deferred.map(({ id }) => id).sort();
  const groupCounts: Record<string, number> = {};
  for (const request of deferred) {
    const group = request.selectionGroup ?? ungroupedSelectionKey;
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
  }
  return {
    selected,
    maximumGuard,
    deferral: {
      statement: insertDiscoveryDeferralStatement(database, {
        runId,
        parentRequestId,
        // The same deferred identities from the same parent are one receipt,
        // so a replayed batch never counts its deferrals twice.
        deferralKey: await sha256Text(canonicalJson(ids)),
        sourceLineage: plan.source_lineage,
        role: selection.role,
        deferredCount: ids.length,
        groupCountsJson: canonicalJson(groupCounts),
        recordedAt: new Date().toISOString(),
      }),
    },
  };
}

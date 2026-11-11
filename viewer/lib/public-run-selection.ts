export interface PublicRunRef {
  id: string;
}

export function selectPublicRunId(
  runs: PublicRunRef[],
  requestedRunId: string | undefined,
  latestRunId: string | null,
): string | null {
  if (requestedRunId && runs.some((run) => run.id === requestedRunId)) {
    return requestedRunId;
  }

  if (latestRunId && runs.some((run) => run.id === latestRunId)) {
    return latestRunId;
  }

  return runs[0]?.id ?? null;
}

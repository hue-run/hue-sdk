/** Finish every isolated check before failing or allowing an archive to be copied. */
export async function waitForChecks(checks, message) {
  const results = await Promise.allSettled(checks);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, message);
}

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HueApiError, type EvaluationClient } from "./client.js";
import { rescore, type RescoreOptions, type RunnerReport } from "./runner.js";
import type { LocalScorer, ScoringJob } from "./types.js";

/** Options for {@link serveScoringJobs}. */
export interface ServeScoringJobsOptions {
  /** Evaluation API client for the project; its key needs write access. */
  client: EvaluationClient;
  /** Local scorers this worker runs, bound to the published versions by digest. */
  scorers: LocalScorer[];
  /** Worker-executed evaluator versions (`executor: "worker"`) this worker serves, 1–32. */
  evaluatorVersionIds: string[];
  /** Parent of the per-job working directories; each is removed when its job finishes. */
  checkpointRoot: string;
  /** Whether explanations, evidence and error messages are stored in Hue. Required. */
  persistResultContent: boolean;
  /** Passed to `rescore` for scorers that read environment evidence. */
  environmentEvidence?: RescoreOptions["environmentEvidence"];
  /** Jobs scored at once, 1–64. Default 4. */
  concurrency?: number;
  /** Lease length in seconds, 30–3600. Default 300. */
  leaseSeconds?: number;
  /** How often a held lease is renewed, in milliseconds. Default a third of the lease. */
  renewMillis?: number;
  /** Wait between claims while the queue is empty, in milliseconds. Default 2000. */
  idleMillis?: number;
  /** Return once the queue is empty instead of waiting for jobs until aborted. */
  once?: boolean;
  /** Stops claiming; jobs already held are finished before the call returns. */
  signal?: AbortSignal;
  /** Receives one line per job outcome. Lines carry IDs and error types, never scored content. */
  log?: (line: string) => void;
  /** Scores one leased item. Default `rescore`. */
  score?: (options: RescoreOptions) => Promise<RunnerReport>;
}
/** Outcome of a {@link serveScoringJobs} call. */
export interface ScoringWorkerReport {
  /** Jobs whose result was recorded. */
  completed: number;
  /** Jobs handed back to the queue, or left for their lease to lapse. */
  requeued: number;
  /** Jobs that ended with an error result. */
  failed: number;
}

// Errors cross into Hue as a type name only; messages can quote scored documents.
function errorType(error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}
// A request Hue refused outright fails the same way on every attempt.
function permanent(error: unknown) {
  return (
    error instanceof HueApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}
async function pause(millis: number, signal?: AbortSignal) {
  try {
    await sleep(millis, undefined, signal ? { signal } : undefined);
  } catch {
    // Aborted: the loop checks the signal next.
  }
}

/**
 * Leases scoring jobs from Hue and scores them with local scorers, `concurrency` at a time. Hue
 * queues a job for every completed item that pins one of `evaluatorVersionIds`, so a client running
 * the agent only uploads outputs. Any number of workers can serve the same versions: each claim
 * leases different jobs, and a job whose worker stops is claimed again once its lease lapses. On
 * abort the loop stops claiming and finishes the jobs it holds.
 */
export async function serveScoringJobs(
  options: ServeScoringJobsOptions,
): Promise<ScoringWorkerReport> {
  const concurrency = options.concurrency ?? 4;
  const leaseSeconds = options.leaseSeconds ?? 300;
  const idleMillis = options.idleMillis ?? 2000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new RangeError("concurrency must be 1–64");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600)
    throw new RangeError("leaseSeconds must be 30–3600");
  const renewMillis = options.renewMillis ?? (leaseSeconds * 1000) / 3;
  if (!(renewMillis > 0 && renewMillis < leaseSeconds * 1000))
    throw new RangeError("renewMillis must be shorter than the lease");
  if (!options.evaluatorVersionIds.length || options.evaluatorVersionIds.length > 32)
    throw new RangeError("Serve 1–32 evaluator versions");
  const log = options.log ?? (() => undefined);
  const score = options.score ?? rescore;
  const report: ScoringWorkerReport = { completed: 0, requeued: 0, failed: 0 };
  const inFlight = new Set<Promise<void>>();

  const run = async (job: ScoringJob) => {
    const directory = join(options.checkpointRoot, `job-${job.id}`);
    const renew = setInterval(() => {
      options.client
        .extendScoringJob(job.id, { leaseToken: job.leaseToken, leaseSeconds })
        .catch((error: unknown) =>
          log(`job ${job.id}: lease renewal failed (${errorType(error)})`),
        );
    }, renewMillis);
    renew.unref?.();
    try {
      const scored = await score({
        client: options.client,
        runId: job.scoringId,
        itemIds: [job.itemId],
        checkpointDirectory: directory,
        persistResultContent: options.persistResultContent,
        scorers: options.scorers,
        deferUnboundLocalScorers: true,
        ...(options.environmentEvidence
          ? { environmentEvidence: options.environmentEvidence }
          : {}),
      });
      await options.client.completeScoringJob(job.id, { leaseToken: job.leaseToken });
      report.completed += 1;
      log(`job ${job.id}: item ${job.itemId} scored (${scored.resultIds.length} result(s))`);
    } catch (cause) {
      try {
        const { state } = await options.client.releaseScoringJob(job.id, {
          leaseToken: job.leaseToken,
          retryable: !permanent(cause),
          error: { type: errorType(cause) },
        });
        if (state === "completed") report.completed += 1;
        else if (state === "queued") report.requeued += 1;
        else report.failed += 1;
        log(`job ${job.id}: ${state} after ${errorType(cause)}`);
      } catch (error) {
        report.requeued += 1;
        log(`job ${job.id}: release failed (${errorType(error)}); its lease will lapse`);
      }
    } finally {
      clearInterval(renew);
      await rm(directory, { recursive: true, force: true });
    }
  };

  while (!options.signal?.aborted) {
    const capacity = concurrency - inFlight.size;
    let claimed = 0;
    if (capacity > 0) {
      try {
        const { jobs } = await options.client.claimScoringJobs({
          evaluatorVersionIds: options.evaluatorVersionIds,
          limit: capacity,
          leaseSeconds,
        });
        claimed = jobs.length;
        for (const job of jobs) {
          const task: Promise<void> = run(job).finally(() => inFlight.delete(task));
          inFlight.add(task);
        }
      } catch (error) {
        log(`claim failed (${errorType(error)})`);
      }
    }
    if (claimed === capacity && capacity > 0) continue;
    if (options.once && claimed === 0 && inFlight.size === 0) break;
    await Promise.race([pause(idleMillis, options.signal), ...inFlight]);
  }
  await Promise.allSettled(inFlight);
  return report;
}

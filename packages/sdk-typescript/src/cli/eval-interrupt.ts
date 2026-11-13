import { EvaluationClient } from "../evals/client.js";
import type { Execution, ExperimentItem } from "../evals/types.js";
import { createEnvironmentClient } from "../world/client.js";

/** Every Hue call of a close ends this long after the first interrupt: inside the 7.5 seconds
 * GitHub Actions waits between a cancelled job's SIGINT and its SIGTERM. */
const CLOSE_MS = 6_000;
/** How long a close first waits for the runner to stop, saving the outcomes it holds and sealing
 * the worlds of the agents it stopped. An agent that ignores SIGTERM holds the runner longer. */
const SETTLE_MS = 2_000;
/** The close stops waiting for outcomes the runner is still saving this long before its end. */
const FINISH_MS = 1_000;
/** One request's timeout. */
const REQUEST_MS = 2_000;
const POLL_MS = 250;
/** Cases cancelled at a time. */
const PARALLEL = 16;
/** How long a forced exit waits for a close underway. */
const FORCED_CLOSE_MS = 2_000;
const OMISSION = "The run was interrupted before this case finished";

/** Where one execution's agent call stands: still running, answered (or failed before the
 * interrupt, so the runner saves that outcome) or stopped by the interrupt. */
type Agent = "running" | "answered" | "stopped";

/** A run the close finished, and the cases it cancelled. */
export interface ClosedRun {
  id: string;
  url: string;
  cancelled: number;
}

export function closedMessage({ url, cancelled }: ClosedRun): string {
  return cancelled
    ? `Interrupted. Cancelled ${cancelled} unfinished ${cancelled === 1 ? "case" : "cases"} and closed the run: ${url}\n`
    : `Interrupted. Closed the run: ${url}\n`;
}

/**
 * `--on-interrupt cancel`: closes an interrupted one-shot run instead of leaving it open for the
 * same command to resume. It starts at the first interrupt, while the agents stop, and waits up
 * to two seconds for the runner to save what it holds. It then cancels every case whose latest
 * attempt is still started (sealing its world first if still open) and every case that
 * never started, waits for the outcomes of agents that answered, and finishes the run. Every
 * Hue call ends six seconds after the interrupt; a close that fails leaves the run open, as
 * `resume` does.
 */
export class RunCloser {
  readonly #connection: { apiKey: string; baseUrl: string };
  readonly #agents = new Map<string, Agent>();
  /** The open world of each execution that has one. */
  readonly #worlds = new Map<string, string>();
  #run: { id: string; url: string } | undefined;
  #interruptedAt: number | undefined;
  /** The runner returned or threw: it saves nothing more, and a close not begun never begins. */
  #settled = false;
  /** The runner finished the run itself. */
  #finished = false;
  #forced = false;
  #closing: Promise<ClosedRun | undefined> | undefined;
  #wake: (() => void) | undefined;

  constructor(connection: { apiKey: string; baseUrl: string }) {
    this.#connection = connection;
  }

  /** The close underway, once begun; it never rejects. */
  get closing(): Promise<ClosedRun | undefined> | undefined {
    return this.#closing;
  }

  /** The run Hue created; an interrupt that came first closes it now. */
  created(id: string, url: string): void {
    this.#run = { id, url };
    this.#begin();
  }

  /** The first interrupt: closes the run, once it exists. */
  interrupt(): void {
    this.#interruptedAt ??= performance.now();
    this.#begin();
  }

  /** The runner returned (`finished`: it finished the run) or threw. */
  settled(finished = false): void {
    this.#settled = true;
    this.#finished ||= finished;
    this.#wake?.();
  }

  /** An execution's world was created (`world` names it) or sealed (undefined). */
  world(executionId: string, world: string | undefined): void {
    if (world) this.#worlds.set(executionId, world);
    else this.#worlds.delete(executionId);
  }

  /** Runs one execution's agent, recording whether the runner saves its outcome. */
  async agent<T>(executionId: string, call: () => T | Promise<T>): Promise<T> {
    this.#agents.set(executionId, "running");
    try {
      const result = await call();
      this.#agents.set(executionId, "answered");
      return result;
    } catch (error) {
      // Before the interrupt the runner saves the failure; after it, the case stays open.
      this.#agents.set(executionId, this.#interruptedAt === undefined ? "answered" : "stopped");
      throw error;
    }
  }

  /**
   * A forced exit: the runner ends with the process, so the close stops waiting for it and
   * cancels the outcomes it was still saving. Resolves within two seconds with the close's
   * outcome; undefined when no close is underway.
   */
  force(): Promise<ClosedRun | undefined> | undefined {
    this.#forced = true;
    this.#wake?.();
    const closing = this.#closing;
    if (!closing) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), FORCED_CLOSE_MS);
      void closing.then((closed) => {
        clearTimeout(timer);
        resolve(closed);
      });
    });
  }

  #begin(): void {
    if (this.#closing || this.#settled || !this.#run || this.#interruptedAt === undefined) return;
    this.#closing = this.#close(this.#run, this.#interruptedAt).catch(() => undefined);
  }

  async #close(run: { id: string; url: string }, interruptedAt: number) {
    const end = interruptedAt + CLOSE_MS;
    const left = () => Math.floor(end - performance.now());
    // Node.js takes whole milliseconds only.
    const deadline = AbortSignal.timeout(Math.max(1, left()));
    const client = new EvaluationClient({
      ...this.#connection,
      timeoutMillis: REQUEST_MS,
      maxAttempts: 2,
      signal: deadline,
    });
    await this.#until(interruptedAt + SETTLE_MS, () => this.#settled);
    if (this.#finished) return undefined;
    let cancelled = 0;
    const cancel = async (execution: Execution) => {
      // Hue completes no execution whose world is open. A world the runner has not sealed yet
      // (its agent still stopping, or not started) is sealed abandoned here, under the key the
      // runner seals it with.
      const world = this.#worlds.get(execution.id);
      // The World client's shortest timeout is 100 ms.
      if (world && left() >= 100)
        await createEnvironmentClient({
          ...this.#connection,
          timeoutMillis: Math.min(REQUEST_MS, left()),
          maxAttempts: 1,
        })
          .finishRun(world, {
            idempotencyKey: `execution:${execution.id}:abandoned`,
            status: "abandoned",
          })
          .catch(() => undefined);
      await client.completeExecution(execution.id, {
        idempotencyKey: `interrupted:${execution.id}`,
        state: "cancelled",
        // The case's trace is still open and may never be exported.
        ...(execution.traceExternalId
          ? { traceEvidence: "omit" as const, omissionReason: OMISSION }
          : {}),
      });
      cancelled++;
    };
    const answered: Execution[] = [];
    await each(deadline, await runItems(client, run.id), async ({ id, execution }) => {
      // Hue finishes a run once every case's latest attempt has ended, so a case that never
      // started gets an attempt, cancelled at once.
      if (!execution)
        return cancel(
          await client.startExecution(run.id, id, {
            idempotencyKey: `interrupted:${run.id}:${id}`,
          }),
        );
      if (execution.state !== "started") return;
      if (this.#agents.get(execution.id) === "answered") answered.push(execution);
      else await cancel(execution);
    });
    // The runner is still saving the outcome of an agent that answered: wait for it, then cancel
    // what is left so the run can finish.
    let saving = answered;
    while (saving.length && !this.#forced && performance.now() < end - FINISH_MS) {
      await this.#until(Math.min(performance.now() + POLL_MS, end - FINISH_MS), () => false);
      const read = await Promise.all(
        saving.map((execution) => client.getExecution(execution.id).catch(() => execution)),
      );
      saving = read.filter((execution) => execution.state === "started");
    }
    await each(deadline, saving, cancel);
    await client.finishExperiment(run.id, `interrupted:${run.id}`);
    return { id: run.id, url: run.url, cancelled };
  }

  /** Waits until `time` (a `performance.now()` value), `done()` or a forced exit. */
  async #until(time: number, done: () => boolean): Promise<void> {
    while (!done() && !this.#forced) {
      const wait = time - performance.now();
      if (wait <= 0) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, wait);
        this.#wake = wake;
      });
    }
  }
}

async function runItems(client: EvaluationClient, id: string): Promise<ExperimentItem[]> {
  const items: ExperimentItem[] = [];
  let after: string | undefined;
  do {
    const page = await client.listExperimentItems(id, { after });
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after);
  return items;
}

/** Runs `work` over the items, `PARALLEL` at a time, starting none after the deadline. A case
 * that cannot be cancelled leaves the finish to refuse, so its failure stops nothing else. */
async function each<T>(
  deadline: AbortSignal,
  items: T[],
  work: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length && !deadline.aborted)
        await work(items[next++]!).catch(() => undefined);
    }),
  );
}

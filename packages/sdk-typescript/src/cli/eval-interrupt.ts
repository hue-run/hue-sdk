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

/** The agent call of one execution: its world, and whether the agent is still running, answered
 * (or failed before the interrupt, so the runner saves that outcome) or was stopped. */
interface Agent {
  world: string | undefined;
  state: "running" | "answered" | "stopped";
}

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
 * attempt is still started (sealing the world of an agent still stopping) and every case that
 * never started, waits for the outcomes of agents that answered, and finishes the run. Every
 * Hue call ends six seconds after the interrupt; a close that fails leaves the run open, as
 * `resume` does.
 */
export class RunCloser {
  readonly #connection: { apiKey: string; baseUrl: string };
  readonly #agents = new Map<string, Agent>();
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

  /** Runs one execution's agent, recording whether the runner saves its outcome. */
  async agent<T>(
    executionId: string,
    world: string | undefined,
    call: () => T | Promise<T>,
  ): Promise<T> {
    const agent: Agent = { world, state: "running" };
    this.#agents.set(executionId, agent);
    try {
      const result = await call();
      agent.state = "answered";
      return result;
    } catch (error) {
      // Before the interrupt the runner saves the failure; after it, the case stays open.
      agent.state = this.#interruptedAt === undefined ? "answered" : "stopped";
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
    const client = new EvaluationClient({
      ...this.#connection,
      timeoutMillis: REQUEST_MS,
      maxAttempts: 2,
      // Node.js takes whole milliseconds only.
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(end - performance.now()))),
    });
    const worlds = createEnvironmentClient({
      ...this.#connection,
      timeoutMillis: REQUEST_MS,
      maxAttempts: 1,
    });
    await this.#until(interruptedAt + SETTLE_MS, () => this.#settled);
    if (this.#finished) return undefined;
    let cancelled = 0;
    const cancel = async (execution: Execution) => {
      // Hue completes no execution whose world is open. An agent still stopping keeps its world
      // open: seal it abandoned, under the key the runner seals it with once the agent ends.
      const world = this.#agents.get(execution.id)?.world;
      if (world)
        await worlds
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
    await each(await runItems(client, run.id), async ({ id, execution }) => {
      // Hue finishes a run once every case's latest attempt has ended, so a case that never
      // started gets an attempt, cancelled at once.
      if (!execution)
        return cancel(
          await client.startExecution(run.id, id, {
            idempotencyKey: `interrupted:${run.id}:${id}`,
          }),
        );
      if (execution.state !== "started") return;
      if (this.#agents.get(execution.id)?.state === "answered") answered.push(execution);
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
    await each(saving, cancel);
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

/** Runs `work` over every item, `PARALLEL` at a time. A case that cannot be cancelled leaves the
 * finish to refuse, so its failure stops nothing else. */
async function each<T>(items: T[], work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!).catch(() => undefined);
    }),
  );
}

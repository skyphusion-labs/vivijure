// Test shim for the `cloudflare:workers` runtime module so plain-node Vitest can import module workers
// that extend WorkflowEntrypoint. The Workflow's run() is exercised in the Workers runtime, not here;
// these tests cover the fetch handler (submit/poll), which only needs the class to be constructible.
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env: Env;
  protected ctx: unknown;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export type WorkflowEvent<T> = { payload: T };
export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

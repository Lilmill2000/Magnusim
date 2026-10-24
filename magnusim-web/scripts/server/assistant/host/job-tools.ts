/**
 * The job tools (spec 06 C4): compute, wait and jobs, over the app's own routes (host-call.ts,
 * their entries in host-routes.ts). defaultHostTools registers them with the rest.
 */
import type { HostCall } from '../host-call.ts';
import type { ToolDef } from '../registry.ts';
import { createComputeTool } from './compute.ts';
import { paced } from './common.ts';
import { jsonCall, type JobToolDeps } from './job-common.ts';
import { createJobsTool } from './jobs.ts';
import { createWaitTool } from './wait.ts';

export function createJobTools(deps: Omit<JobToolDeps, 'call'> & {
  call: HostCall;
  /** How a call held back by the turn's rate waits (tests pass a fake one; wait's own polls use `sleep`). */
  pace?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): ToolDef[] {
  // Each call waits for the turn's rate rather than failing halfway: the same pacing as the
  // other host tools (common.ts paced: up to 15 s, a Stop ends the wait). wait's polls of up to
  // 4 jobs read several routes each, more than the turn's 5 calls a second.
  const { call, pace, ...rest } = deps;
  const d: JobToolDeps = { ...rest, call: jsonCall(paced(call, pace)) };
  return [createComputeTool(d), createWaitTool(d), createJobsTool(d)];
}

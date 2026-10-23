/**
 * The job tools (spec 06 C4): compute, wait and jobs, over the app's own routes (host-call.ts,
 * their entries in host-routes.ts). defaultHostTools registers them with the rest.
 */
import type { HostCall } from '../host-call.ts';
import type { ToolDef } from '../registry.ts';
import { createComputeTool } from './compute.ts';
import { jsonCall, paced, type JobToolDeps } from './job-common.ts';
import { createJobsTool } from './jobs.ts';
import { createWaitTool } from './wait.ts';

export function createJobTools(deps: Omit<JobToolDeps, 'call'> & { call: HostCall }): ToolDef[] {
  // Each call waits for the turn's rate rather than failing halfway (paced).
  const { call, ...rest } = deps;
  const d: JobToolDeps = { ...rest, call: paced(jsonCall(call)) };
  return [createComputeTool(d), createWaitTool(d), createJobsTool(d)];
}

// Who carries out an approved action that isn't Google's or the phone's.
//
// pending_actions holds anything waiting for a YES; approveAction
// (google/assistant.ts) runs it once approved. It knew two kinds: phone actions
// (the app already did them) and Google tools. Newer blocks (a form the browser
// will submit, a campaign that will run) register here instead of teaching that
// file about each of them.

import type { Env } from "./types";

/** Does the approved thing. Returns the one line the person is told ("Done: ..." or why not). */
export type Approver = (env: Env, userId: string, args: Record<string, unknown>, summary: string) => Promise<string>;

const approvers = new Map<string, Approver>();

export function registerApprover(tool: string, run: Approver) {
  approvers.set(tool, run);
}

export const approverFor = (tool: string): Approver | undefined => approvers.get(tool);

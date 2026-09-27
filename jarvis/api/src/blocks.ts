// OVOA's general building blocks, in one place so the chat loop (index.ts) wires
// them once: saved lists (lists.ts), the vault (vault.ts), the browser
// (browser.ts), campaigns (campaigns.ts), and later approval rules. Each block is additive; a block whose key or binding is
// missing leaves its tools out entirely.

import { Hono } from "hono";
import { browserAssistant, isBrowserTool } from "./browser";
import { campaignRoutes, campaignsAssistant, isCampaignTool } from "./campaigns";
import type { PendingAction } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { inboundAssistant, isInboundTool } from "./inbound";
import { isListTool, listsAssistant } from "./lists";
import type { Env, Vars } from "./types";
import { isRuleTool, ruleRoutes, rulesAssistant } from "./rules";
import { siteSessionRoutes } from "./sitesessions";
import { isVaultTool, vaultAssistant, vaultRoutes } from "./vault";
import { isWatchTool, watchesAssistant } from "./watches";

type Block = { tools: ToolSpec[]; callTool: CallTool; prompt: string };

export function blocksAssistant(env: Env, userId: string, _timeZone: string) {
  // Actions a block parked for approval this turn, handed to the app with the reply.
  const pending: PendingAction[] = [];
  const blocks: Block[] = [
    listsAssistant(env, userId),
    vaultAssistant(env, userId),
    browserAssistant(env, userId, (action) => pending.push(action)),
    campaignsAssistant(env, userId, (action) => pending.push(action)),
    rulesAssistant(env, userId),
    inboundAssistant(env, userId),
    watchesAssistant(env, userId),
  ];
  const owner = new Map<string, Block>();
  for (const block of blocks) for (const tool of block.tools) owner.set(tool.name, block);

  const callTool: CallTool = async (name, args) => {
    const block = owner.get(name);
    return block ? block.callTool(name, args) : { error: `Unknown tool ${name}` };
  };

  return {
    tools: blocks.flatMap((b) => b.tools),
    callTool,
    pending,
    prompt: blocks
      .map((b) => b.prompt)
      .filter(Boolean)
      .join("\n"),
  };
}

/** Every name a block can offer, whether or not it's switched on for this person. */
export const isBlockTool = (name: string) =>
  isListTool(name) || isVaultTool(name) || isBrowserTool(name) || isCampaignTool(name) || isRuleTool(name) || isInboundTool(name) || isWatchTool(name);

/** The blocks' app routes, mounted once on the signed-in router (index.ts). */
export const blockRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();
blockRoutes.route("/", vaultRoutes);
blockRoutes.route("/", campaignRoutes);
blockRoutes.route("/", ruleRoutes);
blockRoutes.route("/", siteSessionRoutes);

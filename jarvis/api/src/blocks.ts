// OVOA's general building blocks, in one place so the chat loop (index.ts) wires
// them once: saved lists (lists.ts), the vault (vault.ts), the browser
// (browser.ts), and later campaigns and approval rules. Each block is additive; a block whose key or binding is
// missing leaves its tools out entirely.

import { Hono } from "hono";
import { browserAssistant, isBrowserTool } from "./browser";
import type { CallTool, ToolSpec } from "./llm";
import { isListTool, listsAssistant } from "./lists";
import type { Env, Vars } from "./types";
import { isVaultTool, vaultAssistant, vaultRoutes } from "./vault";

type Block = { tools: ToolSpec[]; callTool: CallTool; prompt: string };

export function blocksAssistant(env: Env, userId: string, _timeZone: string) {
  const blocks: Block[] = [listsAssistant(env, userId), vaultAssistant(env, userId), browserAssistant(env, userId)];
  const owner = new Map<string, Block>();
  for (const block of blocks) for (const tool of block.tools) owner.set(tool.name, block);

  const callTool: CallTool = async (name, args) => {
    const block = owner.get(name);
    return block ? block.callTool(name, args) : { error: `Unknown tool ${name}` };
  };

  return {
    tools: blocks.flatMap((b) => b.tools),
    callTool,
    prompt: blocks
      .map((b) => b.prompt)
      .filter(Boolean)
      .join("\n"),
  };
}

/** Every name a block can offer, whether or not it's switched on for this person. */
export const isBlockTool = (name: string) => isListTool(name) || isVaultTool(name) || isBrowserTool(name);

/** The blocks' app routes, mounted once on the signed-in router (index.ts). */
export const blockRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();
blockRoutes.route("/", vaultRoutes);

// OVOA's general building blocks, in one place so the chat loop (index.ts) wires
// them once: saved lists (lists.ts), and later the vault, campaigns and approval
// rules. Each block is additive; a block whose key or binding is missing leaves
// its tools out entirely.

import type { CallTool, ToolSpec } from "./llm";
import { isListTool, listsAssistant } from "./lists";
import type { Env } from "./types";

type Block = { tools: ToolSpec[]; callTool: CallTool; prompt: string };

export function blocksAssistant(env: Env, userId: string, _timeZone: string) {
  const blocks: Block[] = [listsAssistant(env, userId)];
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
export const isBlockTool = (name: string) => isListTool(name);

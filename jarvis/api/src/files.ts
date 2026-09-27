// Files people hand OVOA, as text: a PDF texted to the line, a document at a
// link, an email attachment.
//
// Plain text formats are decoded here. PDFs and Office documents go through the
// Workers AI binding's toMarkdown (env.AI, already bound for the reply engine;
// converting documents is free). Photos aren't handled here: they're described
// by a vision model (llm.ts describeImage), which is paid and gated.
//
// What a file says is information, never instructions: every caller wraps it
// that way before a model reads it.

import type { Env } from "./types";

/** Past this a file isn't read. */
export const FILE_MAX_BYTES = 8 * 1024 * 1024;

/** Readable formats by extension, and the type sent to toMarkdown. */
const CONVERTED: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  numbers: "application/vnd.apple.numbers",
};
const PLAIN = new Set(["txt", "csv", "tsv", "md", "json", "ics", "vcf"]);
const PLAIN_TYPE = /^text\/(plain|csv|tab-separated-values|markdown|calendar|vcard|x-vcard)|^application\/json/i;

/** The extension OVOA reads a file as, from its type or name, or null when it can't read it. */
export function readableAs(type: string, name: string): string | null {
  const t = type.toLowerCase().split(";")[0]!.trim();
  const ext = /\.([a-z0-9]{2,7})(?:[?#]|$)/i.exec(name)?.[1]?.toLowerCase() ?? "";
  for (const [e, mime] of Object.entries(CONVERTED)) if (t === mime) return e;
  if (PLAIN_TYPE.test(t)) return t.includes("csv") ? "csv" : "txt";
  // A generic type ("application/octet-stream", or none) says nothing: the name decides.
  if (CONVERTED[ext] || PLAIN.has(ext)) return ext;
  return null;
}

/** Is this the kind of type fetch_url should hand to fileToText rather than read as a page? */
export const isDocumentType = (type: string) => {
  const t = type.toLowerCase().split(";")[0]!.trim();
  return Object.values(CONVERTED).includes(t);
};

/**
 * A file's text, or null when it can't be read (a format OVOA doesn't read, too
 * big, empty, or the converter said no). Never throws.
 */
export async function fileToText(env: Pick<Env, "AI">, bytes: Uint8Array, name: string, type: string): Promise<string | null> {
  try {
    if (!bytes.length || bytes.length > FILE_MAX_BYTES) return null;
    const as = readableAs(type, name);
    if (!as) return null;
    if (PLAIN.has(as)) return new TextDecoder().decode(bytes).trim() || null;
    const ai = env.AI as Ai | undefined;
    if (!ai?.toMarkdown) return null;
    const safeName = /\.[a-z0-9]{2,7}$/i.test(name) ? name.replace(/^.*[\\/]/, "") : `file.${as}`;
    const out = await ai.toMarkdown({ name: safeName, blob: new Blob([bytes], { type: CONVERTED[as] }) });
    if (!out || out.format === "error") return null;
    const text = out.data.replace(/\n{3,}/g, "\n\n").trim();
    return text || null;
  } catch (err) {
    console.error("fileToText failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The last part of an address's path, as a file name ("" when there's none or it won't decode). Pure. */
export function fileNameOf(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    // "sale-50%-off" isn't valid percent-encoding: the name as it stands.
    return last;
  }
}

/** A long text in parts, for a tool that reads it: what fetch_url does for pages. Pure. */
export function part(text: string, offset: unknown, max: number) {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const slice = text.slice(from, from + max);
  return { totalChars: text.length, offset: from, nextOffset: from + slice.length < text.length ? from + slice.length : null, text: slice };
}

/** "Base64" as Gmail (url-safe) and Graph (standard) send it, to bytes. Pure. */
export function base64Bytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

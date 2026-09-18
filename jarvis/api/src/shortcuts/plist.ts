/** Serializes plain JSON-like values as an XML property list. */

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue | undefined };

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function write(value: PlistValue, indent: string): string {
  const next = `${indent}\t`;
  if (typeof value === "string") return `${indent}<string>${escape(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}<array/>`;
    return [`${indent}<array>`, ...value.map((v) => write(v, next)), `${indent}</array>`].join("\n");
  }
  const entries = Object.entries(value).filter((e): e is [string, PlistValue] => e[1] !== undefined);
  if (!entries.length) return `${indent}<dict/>`;
  return [
    `${indent}<dict>`,
    ...entries.flatMap(([k, v]) => [`${next}<key>${escape(k)}</key>`, write(v, next)]),
    `${indent}</dict>`,
  ].join("\n");
}

export function toXmlPlist(value: PlistValue) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    write(value, ""),
    "</plist>",
    "",
  ].join("\n");
}

import { ACTION_PREFIX, getAction, sensitivity, shortActionId, type ParamSpec } from "./catalog";
import { toXmlPlist, type PlistValue } from "./plist";

/**
 * Compiles the assistant's shortcut program (JSON) into an Apple Shortcuts
 * workflow plist. File format notes come from the Cherri compiler
 * (github.com/electrikmilk/cherri).
 *
 * A program is a list of steps. Each step is one of:
 *   { "action": "gettext", "params": { ... }, "id": "greeting" }
 *   { "if": { "input": "{{x}}", "condition": "contains", "value": "hi" }, "then": [...], "else": [...] }
 *   { "repeat": 3, "do": [...] }
 *   { "repeat_each": "{{list}}", "do": [...] }
 *   { "menu": "Pick one", "options": [{ "label": "A", "do": [...] }] }
 *   { "set": "name", "to": "value" }       { "add_to": "name", "value": "..." }
 *   { "comment": "..." }
 * Text can reference earlier results with {{id}}, variables with {{name}},
 * dictionary keys with {{id.key}}, and the globals below.
 */

export type Program = { name: string; color?: string; steps: unknown[] };

export class CompileError extends Error {}

type Dict = { [key: string]: PlistValue };

export const MAX_ACTIONS = 150;
const MAX_DEPTH = 8;
const CLIENT_VERSION = "4528.0.4.2";
const GLYPH_MAGIC_WAND = 59511;

export const COLORS: Record<string, number> = {
  red: 4282601983,
  orange: 4271458815,
  yellow: 4274264319,
  green: 4292093695,
  teal: 431817727,
  lightblue: 1440408063,
  blue: 463140863,
  darkblue: 946986751,
  violet: 2071128575,
  purple: 3679049983,
  pink: 3980825855,
  gray: 3031607807,
};

const GLOBALS: Record<string, Dict> = {
  ShortcutInput: { Type: "ExtensionInput" },
  Clipboard: { Type: "Clipboard" },
  CurrentDate: { Type: "CurrentDate" },
  Ask: { Type: "Ask" },
  DeviceDetails: { Type: "DeviceDetails" },
  RepeatItem: { Type: "Variable", VariableName: "Repeat Item" },
  RepeatIndex: { Type: "Variable", VariableName: "Repeat Index" },
};
export const GLOBAL_NAMES = Object.keys(GLOBALS);
const LOOP_GLOBALS = new Set(["RepeatItem", "RepeatIndex"]);

const INPUT_CLASSES = [
  "WFAppContentItem",
  "WFAppStoreAppContentItem",
  "WFArticleContentItem",
  "WFContactContentItem",
  "WFDateContentItem",
  "WFEmailAddressContentItem",
  "WFFolderContentItem",
  "WFGenericFileContentItem",
  "WFImageContentItem",
  "WFiTunesProductContentItem",
  "WFLocationContentItem",
  "WFDCMapsLinkContentItem",
  "WFAVAssetContentItem",
  "WFPDFContentItem",
  "WFPhoneNumberContentItem",
  "WFRichTextContentItem",
  "WFSafariWebPageContentItem",
  "WFStringContentItem",
  "WFURLContentItem",
];

// Built from structured steps, never from { "action": ... }.
const STRUCTURED: Record<string, string> = {
  conditional: "if",
  "repeat.count": "repeat",
  "repeat.each": "repeat_each",
  choosefrommenu: "menu",
  setvariable: "set",
  appendvariable: "add_to",
  comment: "comment",
};

const CONDITIONS: Record<string, number> = {
  is: 4,
  equals: 4,
  "==": 4,
  "is not": 5,
  "not equals": 5,
  "!=": 5,
  contains: 99,
  "does not contain": 999,
  "begins with": 8,
  "ends with": 9,
  ">": 2,
  "is greater than": 2,
  ">=": 3,
  "is greater than or equal to": 3,
  "<": 0,
  "is less than": 0,
  "<=": 1,
  "is less than or equal to": 1,
  "is between": 1003,
  between: 1003,
  "has any value": 100,
  "does not have any value": 101,
};
const NUMERIC_CONDITIONS = new Set([0, 1, 2, 3, 1003]);
const NO_VALUE_CONDITIONS = new Set([100, 101]);

const NAME_RE = /^[A-Za-z][A-Za-z0-9_ ]{0,39}$/;
const REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_REF_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const OBJECT_REPLACEMENT = "￼";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = () => crypto.randomUUID().toUpperCase();
const preview = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

class Compiler {
  actions: Dict[] = [];
  outputs = new Map<string, string>();
  variables = new Set<string>();
  usesInput = false;
  warnings = new Set<string>();
  lines: string[] = [];
  loopDepth = 0;

  fail(path: string, message: string): never {
    throw new CompileError(`${path}: ${message}`);
  }

  emit(id: string, params: Dict) {
    if (this.actions.length >= MAX_ACTIONS) {
      throw new CompileError(`Too many actions (max ${MAX_ACTIONS}). Make the shortcut simpler.`);
    }
    this.actions.push({ WFWorkflowActionIdentifier: ACTION_PREFIX + id, WFWorkflowActionParameters: params });
  }

  line(depth: number, text: string) {
    this.lines.push(`${"   ".repeat(depth)}- ${text}`);
  }

  /** Registers a step id so later steps can use {{id}}. Returns the params that name the output. */
  claimId(path: string, id: unknown): Dict {
    const UUID = uuid();
    if (id === undefined) return { UUID };
    if (typeof id !== "string" || !NAME_RE.test(id)) {
      this.fail(path, `"id" must be a short name of letters, numbers, spaces, or _ starting with a letter`);
    }
    if (this.outputs.has(id) || this.variables.has(id) || id in GLOBALS) this.fail(path, `the name "${id}" is already used`);
    this.outputs.set(id, UUID);
    return { UUID, CustomOutputName: id };
  }

  variableName(path: string, name: unknown) {
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      this.fail(path, "variable names are letters, numbers, spaces, or _ and start with a letter");
    }
    if (this.outputs.has(name) || name in GLOBALS) this.fail(path, `the name "${name}" is already used by a step or global`);
    return name;
  }

  // ---------- Values ----------

  ref(path: string, expr: string): Dict {
    const [name, ...keys] = expr.split(".").map((s) => s.trim());
    let value: Dict;
    if (name in GLOBALS) {
      if (LOOP_GLOBALS.has(name) && !this.loopDepth) this.fail(path, `{{${name}}} only works inside repeat steps`);
      if (name === "ShortcutInput") this.usesInput = true;
      value = { ...GLOBALS[name] };
    } else if (this.outputs.has(name)) {
      value = { Type: "ActionOutput", OutputUUID: this.outputs.get(name)!, OutputName: name };
    } else if (this.variables.has(name)) {
      value = { Type: "Variable", VariableName: name };
    } else {
      this.fail(
        path,
        `{{${name}}} isn't defined. Give an earlier step "id": "${name}", set it with a "set" step first, or use one of ${GLOBAL_NAMES.join(", ")}.`,
      );
    }
    if (keys.length) {
      if (keys.some((k) => !k)) this.fail(path, `bad reference {{${expr}}}`);
      value.Aggrandizements = [{ Type: "WFDictionaryValueVariableAggrandizement", DictionaryKey: keys.join(".") }];
    }
    return value;
  }

  attachment(path: string, expr: string): Dict {
    return { Value: this.ref(path, expr), WFSerializationType: "WFTextTokenAttachment" };
  }

  wholeRef(v: unknown) {
    return typeof v === "string" ? v.match(WHOLE_REF_RE)?.[1] : undefined;
  }

  /** Text that may contain {{refs}}. Plain strings stay plain unless `wrap`. */
  text(path: string, s: string, wrap = false): PlistValue {
    if (s.length > 20_000) this.fail(path, "text is too long");
    const attachmentsByRange: Dict = {};
    let out = "";
    let last = 0;
    for (const m of s.matchAll(REF_RE)) {
      out += s.slice(last, m.index);
      // Ranges count UTF-16 code units, which is what JS string length measures.
      attachmentsByRange[`{${out.length}, 1}`] = this.ref(path, m[1]);
      out += OBJECT_REPLACEMENT;
      last = m.index! + m[0].length;
    }
    out += s.slice(last);
    const hasRefs = Object.keys(attachmentsByRange).length > 0;
    if (!hasRefs && !wrap) return s;
    return {
      Value: hasRefs ? { string: out, attachmentsByRange } : { string: out },
      WFSerializationType: "WFTextTokenString",
    };
  }

  /** A variable-picker value: a {{ref}}, or a literal turned into a Text/Number/Dictionary/List step first. */
  materialize(path: string, value: unknown, depth: number): Dict {
    const ref = this.wholeRef(value);
    if (ref) return this.attachment(path, ref);
    const UUID = uuid();
    let name: string;
    if (typeof value === "number" || typeof value === "boolean") {
      name = "Number";
      this.emit("number", { UUID, WFNumberActionNumber: typeof value === "boolean" ? Number(value) : value });
    } else if (typeof value === "string") {
      name = "Text";
      this.emit("gettext", { UUID, WFTextActionText: this.text(path, value) });
    } else if (isObj(value)) {
      name = "Dictionary";
      this.emit("dictionary", { UUID, WFItems: this.dictionary(path, value) });
    } else if (Array.isArray(value)) {
      name = "List";
      this.emit("list", { UUID, WFItems: this.listItems(path, value) });
    } else {
      this.fail(path, "expected a value");
    }
    this.line(depth, `${name}: ${preview(value)}`);
    return { Value: { Type: "ActionOutput", OutputUUID: UUID, OutputName: name }, WFSerializationType: "WFTextTokenAttachment" };
  }

  dictionary(path: string, obj: Record<string, unknown>): Dict {
    return {
      Value: { WFDictionaryFieldValueItems: Object.entries(obj).map(([k, v]) => this.dictItem(path, k, v)) },
      WFSerializationType: "WFDictionaryFieldValue",
    };
  }

  dictItem(path: string, key: string | null, v: unknown): Dict {
    const item = (type: number, WFValue: PlistValue): Dict => ({
      WFItemType: type,
      ...(key !== null && { WFKey: this.text(path, key, true) }),
      WFValue,
    });
    if (typeof v === "string") return item(0, this.text(path, v, true));
    if (typeof v === "number") return item(3, this.text(path, String(v), true));
    if (typeof v === "boolean") return item(4, { Value: v, WFSerializationType: "WFNumberSubstitutableState" });
    if (Array.isArray(v)) {
      return item(2, { Value: v.map((x) => this.dictItem(path, null, x)), WFSerializationType: "WFArrayParameterState" });
    }
    if (isObj(v)) return item(1, { Value: this.dictionary(path, v), WFSerializationType: "WFDictionaryFieldValue" });
    this.fail(path, `dictionary value for "${key}" can't be null`);
  }

  listItems(path: string, items: unknown[]): PlistValue[] {
    return items.map((x) => {
      if (typeof x !== "string" && typeof x !== "number") this.fail(path, "list items must be text or numbers");
      return { WFItemType: 0, WFValue: this.text(path, String(x)) };
    });
  }

  contacts(path: string, value: unknown, kind: "email" | "phone" | "either"): Dict {
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) this.fail(path, "add at least one recipient");
    const entries = list.map((x) => {
      if (typeof x !== "string" || !x.trim() || x.includes("{{")) {
        this.fail(path, "recipients must be written-out phone numbers or email addresses, not {{references}}");
      }
      const isEmail = kind === "email" || (kind === "either" && x.includes("@"));
      return isEmail
        ? { EntryType: 2, SerializedEntry: { "link.contentkit.emailaddress": x.trim() } }
        : { EntryType: 1, SerializedEntry: { "link.contentkit.phonenumber": x.trim() } };
    });
    return { Value: { WFContactFieldValues: entries }, WFSerializationType: "WFContactFieldValue" };
  }

  quantity(path: string, value: unknown): Dict {
    if (!isObj(value) || typeof value.unit !== "string") {
      this.fail(path, 'expected an amount like {"magnitude": 5, "unit": "min"}');
    }
    const ref = this.wholeRef(value.magnitude);
    let Magnitude: PlistValue;
    if (ref) Magnitude = this.ref(path, ref);
    else if (Number.isFinite(Number(value.magnitude))) Magnitude = String(Number(value.magnitude));
    else this.fail(path, "magnitude must be a number or a {{reference}}");
    return { Value: { Magnitude, Unit: value.unit }, WFSerializationType: "WFQuantityFieldValue" };
  }

  /** Arbitrary JSON as a plist value, for {"$raw": ...} escapes and unknown picker objects. */
  raw(path: string, v: unknown): PlistValue {
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((x) => this.raw(path, x));
    if (isObj(v)) {
      return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, this.raw(path, x)]));
    }
    this.fail(path, "unsupported value");
  }

  param(path: string, spec: ParamSpec, value: unknown, depth: number): PlistValue {
    if (isObj(value) && "$raw" in value) return this.raw(path, value.$raw);
    const ref = this.wholeRef(value);
    const t = spec.type;
    switch (t) {
      case "Bool":
        if (ref) return this.attachment(path, ref);
        if (typeof value === "boolean") return value;
        if (value === "true" || value === "false") return value === "true";
        this.fail(path, "expected true or false");
      case "Integer":
      case "Float":
      case "NSNumber":
        if (ref) return this.attachment(path, ref);
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
        this.fail(path, "expected a number or a {{reference}}");
      case "Enum":
        if (ref) return this.attachment(path, ref);
        if (typeof value !== "string") this.fail(path, `expected one of: ${spec.enum?.join(", ") ?? "text"}`);
        if (spec.enum && !spec.enum.includes(value)) this.fail(path, `"${value}" isn't allowed. Use one of: ${spec.enum.join(", ")}`);
        return value;
      case "String":
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        if (typeof value !== "string") this.fail(path, "expected text");
        return this.text(path, value);
      case "WFVariablePickerParameter":
        return this.materialize(path, value, depth);
      case "WFDictionaryParameter":
        if (ref) return this.attachment(path, ref);
        if (!isObj(value)) this.fail(path, "expected an object of keys and values");
        return this.dictionary(path, value);
      case "WFContentArrayParameter":
        if (ref) return this.attachment(path, ref);
        if (!Array.isArray(value)) this.fail(path, "expected a list");
        return this.listItems(path, value);
      case "WFEmailAddressFieldParameter":
        return this.contacts(path, value, "email");
      case "WFPhoneNumberFieldParameter":
        return this.contacts(path, value, "phone");
      case "WFContactHandleFieldParameter":
        return this.contacts(path, value, "either");
      case "WFAppPickerParameter":
      case "WFIntentAppPickerParameter":
        if (typeof value === "string" && !ref) return { BundleIdentifier: value };
        break;
    }
    if (t.includes("Quantity") && !ref) return this.quantity(path, value);
    if (ref) return this.attachment(path, ref);
    if (typeof value === "string") return this.text(path, value);
    return this.raw(path, value);
  }

  // ---------- Steps ----------

  steps(path: string, list: unknown, depth: number) {
    if (!Array.isArray(list)) this.fail(path, "expected a list of steps");
    if (depth > MAX_DEPTH) this.fail(path, "steps are nested too deeply");
    list.forEach((s, i) => this.step(`${path}[${i}]`, s, depth));
  }

  step(path: string, s: unknown, depth: number) {
    if (!isObj(s)) this.fail(path, "each step must be an object");
    if ("action" in s) return this.actionStep(path, s, depth);
    if ("if" in s) return this.ifStep(path, s, depth);
    if ("repeat" in s) return this.repeatStep(path, s, depth);
    if ("repeat_each" in s) return this.repeatEachStep(path, s, depth);
    if ("menu" in s) return this.menuStep(path, s, depth);
    if ("set" in s) return this.setStep(path, s, depth, "setvariable");
    if ("add_to" in s) return this.setStep(path, s, depth, "appendvariable");
    if ("comment" in s) {
      if (typeof s.comment !== "string") this.fail(path, "comment must be text");
      this.emit("comment", { WFCommentActionText: s.comment.slice(0, 2000) });
      return;
    }
    this.fail(path, "unknown step. Use action, if, repeat, repeat_each, menu, set, add_to, or comment");
  }

  actionStep(path: string, s: Record<string, unknown>, depth: number) {
    if (typeof s.action !== "string") this.fail(path, '"action" must be an action id like "gettext"');
    const id = shortActionId(s.action);
    if (id in STRUCTURED) this.fail(path, `don't use "${id}" as an action; write a "${STRUCTURED[id]}" step instead`);
    const spec = getAction(id);
    if (!spec) this.fail(path, `unknown action "${s.action}". Find actions with shortcut_actions_search.`);
    const given = s.params ?? {};
    if (!isObj(given)) this.fail(path, '"params" must be an object');

    const params: Dict = {};
    const shown: string[] = [];
    for (const [name, value] of Object.entries(given)) {
      if (value === null || value === undefined) continue;
      const pspec = spec.params[name];
      if (!pspec) {
        const known = Object.keys(spec.params);
        this.fail(path, `${id} has no parameter "${name}". Its parameters: ${known.join(", ") || "none"}`);
      }
      params[name] = this.param(`${path}.params.${name}`, pspec, value, depth);
      if (shown.length < 2 && (typeof value === "string" || typeof value === "number")) shown.push(preview(value));
    }
    if (id === "openapp" && typeof params.WFAppIdentifier === "string" && !params.WFSelectedApp) {
      params.WFSelectedApp = { BundleIdentifier: params.WFAppIdentifier };
    }
    Object.assign(params, this.claimId(path, s.id));
    this.emit(id, params);

    const risk = sensitivity(id);
    if (risk) this.warnings.add(risk);
    this.line(depth, `${spec.title}${shown.length ? `: ${shown.join(", ")}` : ""}`);
  }

  ifStep(path: string, s: Record<string, unknown>, depth: number) {
    const cond = s.if;
    if (!isObj(cond)) this.fail(path, '"if" must be an object like {"input": "{{x}}", "condition": "is", "value": "yes"}');
    const code = CONDITIONS[String(cond.condition ?? "").toLowerCase().trim()];
    if (code === undefined) this.fail(path, `unknown condition. Use one of: ${Object.keys(CONDITIONS).join(", ")}`);
    const input = this.materialize(`${path}.if.input`, cond.input, depth);

    const group = uuid();
    const params: Dict = {
      GroupingIdentifier: group,
      WFControlFlowMode: 0,
      WFInput: { Type: "Variable", Variable: input },
      WFCondition: code,
    };
    if (!NO_VALUE_CONDITIONS.has(code)) {
      const numeric = NUMERIC_CONDITIONS.has(code) || ((code === 4 || code === 5) && typeof cond.value === "number");
      const operand = (key: "value" | "value2", v: unknown): PlistValue => {
        if (v === undefined) this.fail(`${path}.if.${key}`, "this condition needs a value");
        if (!numeric) return this.text(`${path}.if.${key}`, String(v));
        const ref = this.wholeRef(v);
        if (ref) return this.attachment(`${path}.if.${key}`, ref);
        if (!Number.isFinite(Number(v))) this.fail(`${path}.if.${key}`, "expected a number");
        return Number(v);
      };
      if (numeric) params.WFNumberValue = operand("value", cond.value);
      else params.WFConditionalActionString = operand("value", cond.value);
      if (code === 1003) params.WFAnotherNumber = operand("value2", cond.value2);
    }
    this.emit("conditional", params);
    this.line(depth, `If ${preview(cond.input)} ${cond.condition}${cond.value !== undefined ? ` ${preview(cond.value)}` : ""}`);
    this.steps(`${path}.then`, s.then ?? [], depth + 1);
    if (s.else !== undefined) {
      this.emit("conditional", { GroupingIdentifier: group, WFControlFlowMode: 1 });
      this.line(depth, "Otherwise");
      this.steps(`${path}.else`, s.else, depth + 1);
    }
    this.emit("conditional", { GroupingIdentifier: group, WFControlFlowMode: 2, ...this.claimId(path, s.id) });
  }

  repeatStep(path: string, s: Record<string, unknown>, depth: number) {
    const ref = this.wholeRef(s.repeat);
    let count: PlistValue;
    if (ref) count = this.attachment(`${path}.repeat`, ref);
    else if (Number.isInteger(Number(s.repeat)) && Number(s.repeat) > 0 && Number(s.repeat) <= 1000) count = Number(s.repeat);
    else this.fail(`${path}.repeat`, "expected a whole number from 1 to 1000 or a {{reference}}");
    const group = uuid();
    this.emit("repeat.count", { GroupingIdentifier: group, WFControlFlowMode: 0, WFRepeatCount: count });
    this.line(depth, `Repeat ${preview(s.repeat)} times`);
    this.loop(() => this.steps(`${path}.do`, s.do, depth + 1));
    this.emit("repeat.count", { GroupingIdentifier: group, WFControlFlowMode: 2, ...this.claimId(path, s.id) });
  }

  repeatEachStep(path: string, s: Record<string, unknown>, depth: number) {
    const input = this.materialize(`${path}.repeat_each`, s.repeat_each, depth);
    const group = uuid();
    this.emit("repeat.each", { GroupingIdentifier: group, WFControlFlowMode: 0, WFInput: input });
    this.line(depth, `Repeat with each item in ${preview(s.repeat_each)}`);
    this.loop(() => this.steps(`${path}.do`, s.do, depth + 1));
    this.emit("repeat.each", { GroupingIdentifier: group, WFControlFlowMode: 2, ...this.claimId(path, s.id) });
  }

  loop(fn: () => void) {
    this.loopDepth++;
    try {
      fn();
    } finally {
      this.loopDepth--;
    }
  }

  menuStep(path: string, s: Record<string, unknown>, depth: number) {
    if (typeof s.menu !== "string") this.fail(`${path}.menu`, "the menu prompt must be text");
    if (!Array.isArray(s.options) || !s.options.length) this.fail(`${path}.options`, 'add options like [{"label": "A", "do": [...]}]');
    const labels = s.options.map((o, i) => {
      if (!isObj(o) || typeof o.label !== "string" || !o.label.trim() || o.label.includes("{{")) {
        this.fail(`${path}.options[${i}]`, "each option needs a plain-text label");
      }
      return o.label.trim();
    });
    if (new Set(labels).size !== labels.length) this.fail(`${path}.options`, "option labels must be different");

    const group = uuid();
    this.emit("choosefrommenu", {
      GroupingIdentifier: group,
      WFControlFlowMode: 0,
      WFMenuPrompt: this.text(`${path}.menu`, s.menu),
      WFMenuItems: labels.map((l) => ({ WFItemType: 0, WFValue: l })),
    });
    this.line(depth, `Menu: ${preview(s.menu)}`);
    (s.options as Record<string, unknown>[]).forEach((o, i) => {
      this.emit("choosefrommenu", {
        GroupingIdentifier: group,
        WFControlFlowMode: 1,
        WFMenuItemTitle: labels[i],
        WFMenuItemAttributedTitle: labels[i],
      });
      this.line(depth + 1, `“${labels[i]}”`);
      this.steps(`${path}.options[${i}].do`, o.do ?? [], depth + 2);
    });
    this.emit("choosefrommenu", { GroupingIdentifier: group, WFControlFlowMode: 2, ...this.claimId(path, s.id) });
  }

  setStep(path: string, s: Record<string, unknown>, depth: number, id: "setvariable" | "appendvariable") {
    const append = id === "appendvariable";
    const name = this.variableName(path, append ? s.add_to : s.set);
    const value = append ? s.value : s.to;
    if (value === undefined) this.fail(path, append ? 'add "value"' : 'add "to"');
    const input = this.materialize(path, value, depth);
    this.variables.add(name);
    this.emit(id, { WFVariableName: name, WFInput: input });
    this.line(depth, `${append ? "Add to" : "Set"} variable ${name}`);
  }
}

export type Compiled = { xml: string; summary: string; warnings: string[]; actionCount: number };

export function compileShortcut(program: Program): Compiled {
  const name = typeof program.name === "string" ? program.name.trim() : "";
  if (!name || name.length > 60 || /[/\\:]/.test(name)) {
    throw new CompileError("name: give the shortcut a name of up to 60 characters without / \\ or :");
  }
  const color = program.color ? COLORS[program.color] : COLORS.blue;
  if (color === undefined) throw new CompileError(`color: use one of ${Object.keys(COLORS).join(", ")}`);
  if (!Array.isArray(program.steps) || !program.steps.length) throw new CompileError("steps: add at least one step");

  const c = new Compiler();
  c.steps("steps", program.steps, 0);

  const workflow: Dict = {
    WFWorkflowActions: c.actions,
    WFWorkflowClientVersion: CLIENT_VERSION,
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowIcon: { WFWorkflowIconStartColor: color, WFWorkflowIconGlyphNumber: GLYPH_MAGIC_WAND },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ["Watch", "WFWorkflowTypeShowInSearch"],
    WFWorkflowInputContentItemClasses: INPUT_CLASSES,
    WFWorkflowOutputContentItemClasses: [],
    WFQuickActionSurfaces: [],
    WFWorkflowHasShortcutInputVariables: c.usesInput,
    WFWorkflowHasOutputFallback: false,
  };

  const MAX_LINES = 40;
  const lines = c.lines.length > MAX_LINES
    ? [...c.lines.slice(0, MAX_LINES), `…and ${c.lines.length - MAX_LINES} more steps`]
    : c.lines;
  return { xml: toXmlPlist(workflow), summary: lines.join("\n"), warnings: [...c.warnings], actionCount: c.actions.length };
}

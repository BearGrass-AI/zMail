// Settings: reading and changing appearance and mail settings (AI model settings are out of scope).
import type { ToolModule } from "./types";
import { extOf } from "./types";
import { useAssistant } from "../state";
import { useSettings } from "@/lib/settings";
import { useMail } from "@/lib/store";
import { enableMacContacts } from "@/lib/mac-contacts";

type Which = "new" | "reply";
type Sig = { id: string; name: string };
type Acct = { id: string; address: string };
type Defaults = Record<string, { new?: string | null; reply?: string | null }>;

export interface SettingsDeps {
  getSettings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;
  enableMacContacts(): Promise<"granted" | "denied" | "unavailable">;
  signatures(): Sig[];
  accounts(): Acct[];
  signatureDefaults(): Defaults;
  setSignatureDefault(accountId: string, which: Which, id: string | null): void;
}

type Spec = { label: string; check: (v: unknown) => boolean; desc: string };
const oneOf = (...o: string[]) => (v: unknown) => typeof v === "string" && o.includes(v);
const bool = (v: unknown) => typeof v === "boolean";

const ALLOWED: Record<string, Spec> = {
  theme: { label: "theme", check: oneOf("system", "light", "dark", "translucent"), desc: "system | light | dark | translucent" },
  palette: { label: "color palette", check: oneOf("glacier", "ember", "grove", "aurora", "mono"), desc: "glacier | ember | grove | aurora | mono" },
  messageBackground: { label: "message background", check: oneOf("theme", "light"), desc: "theme | light" },
  findDatesEverywhere: { label: "find dates everywhere", check: bool, desc: "true | false" },
  peoplePhotos: { label: "people photos", check: bool, desc: "true | false" },
  senderLogos: { label: "sender logos", check: bool, desc: "true | false" },
  macContactsPhotos: { label: "Mac Contacts photos", check: bool, desc: "true | false" },
  suggestThreshold: { label: "suggestion confidence", check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.4 && v <= 0.98, desc: "number 0.4 to 0.98" },
};

const step = (text: string) => useAssistant.getState().push({ kind: "step", text });

export const settingsModule: ToolModule = {
  id: "settings",
  prompt: [
    "- You can change appearance and mail settings with change_setting and signatures with set_default_signature. AI model choices are made by the user in Settings → AI providers / AI Assistant.",
  ],
  tools: [
    { name: "get_settings", description: "Read the current appearance and mail settings, signature names and each account's default signatures.", parameters: { type: "object", properties: {} } },
    {
      name: "change_setting",
      description: `Change one setting at once (the user gets an Undo). Keys: ${Object.entries(ALLOWED).map(([k, s]) => `${k} (${s.desc})`).join("; ")}.`,
      parameters: { type: "object", properties: { key: { type: "string" }, value: {} }, required: ["key", "value"] },
    },
    {
      name: "set_default_signature",
      description: "Set which signature is used by default for new mail or replies, by signature name, or \"none\". Applies to all accounts unless one is given by address.",
      parameters: {
        type: "object",
        properties: { account: { type: "string", description: "Account address; omit for all accounts" }, which: { type: "string", enum: ["new", "reply"] }, signature: { type: "string", description: "Signature name or \"none\"" } },
        required: ["which", "signature"],
      },
    },
  ],
  handlers: {
    async get_settings(_a, deps) {
      const d = extOf<SettingsDeps>(deps, "settings");
      const s = d.getSettings();
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(ALLOWED)) out[k] = s[k];
      const sigs = d.signatures();
      const name = (id: string | null | undefined) => (id ? (sigs.find((x) => x.id === id)?.name ?? null) : null);
      const defs = d.signatureDefaults();
      step("Read your settings");
      return {
        settings: out,
        signatures: sigs.map((x) => x.name),
        signatureDefaults: d.accounts().map((a) => ({ account: a.address, new: name(defs[a.id]?.new), reply: name(defs[a.id]?.reply) })),
      };
    },

    async change_setting(a, deps) {
      const d = extOf<SettingsDeps>(deps, "settings");
      const key = a.key;
      if (typeof key !== "string" || !Object.hasOwn(ALLOWED, key)) throw new Error(`bad_query: "${String(key)}" can't be changed. Allowed: ${Object.keys(ALLOWED).join(", ")}`);
      const spec = ALLOWED[key];
      if (!spec.check(a.value)) throw new Error(`bad_query: invalid value for ${key}; expected ${spec.desc}`);
      const old = d.getSettings()[key];
      let result: string | undefined;
      if (key === "macContactsPhotos" && a.value === true) {
        result = await d.enableMacContacts();
        if (result !== "granted") {
          return { changed: false, result, note: result === "denied" ? "macOS Contacts access is denied; the user can allow it in System Settings." : "Mac Contacts isn't available here." };
        }
      }
      d.setSetting(key, a.value);
      step(`Changed ${spec.label}`);
      deps.toast(`Changed ${spec.label}`, () => d.setSetting(key, old));
      return { changed: true, key, from: old, to: a.value, ...(result ? { result } : {}) };
    },

    async set_default_signature(a, deps) {
      const d = extOf<SettingsDeps>(deps, "settings");
      if (a.which !== "new" && a.which !== "reply") throw new Error('bad_query: which must be "new" or "reply"');
      if (typeof a.signature !== "string") throw new Error('bad_query: signature must be a name or "none"');
      const wanted = a.signature.trim().toLowerCase();
      let id: string | null = null;
      if (wanted !== "none") {
        const sigs = d.signatures();
        const hit = sigs.find((x) => x.name.trim().toLowerCase() === wanted);
        if (!hit) throw new Error(`bad_query: no signature named "${a.signature}". Available: ${sigs.map((x) => x.name).join(", ") || "none"}`);
        id = hit.id;
      }
      let accts = d.accounts();
      if (typeof a.account === "string" && a.account) {
        const q = a.account.trim().toLowerCase();
        accts = accts.filter((x) => x.address.toLowerCase() === q);
        if (!accts.length) throw new Error(`bad_query: no account "${a.account}"`);
      }
      const which = a.which as Which;
      const defs = d.signatureDefaults();
      const prev = accts.map((x) => ({ id: x.id, was: defs[x.id]?.[which] ?? null }));
      for (const x of accts) d.setSignatureDefault(x.id, which, id);
      const text = `Set ${which === "new" ? "new mail" : "reply"} signature to ${id ? a.signature : "none"}`;
      step(text);
      deps.toast(text, () => {
        for (const p of prev) d.setSignatureDefault(p.id, which, p.was);
      });
      return { changed: true, accounts: accts.map((x) => x.address), which, signature: id ? a.signature : "none" };
    },
  },
  realDeps: (): SettingsDeps => ({
    getSettings: () => useSettings.getState() as unknown as Record<string, unknown>,
    setSetting: (k, v) => useSettings.getState().set({ [k]: v } as never),
    enableMacContacts,
    signatures: () => useMail.getState().signatures,
    accounts: () => useMail.getState().accounts,
    signatureDefaults: () => useMail.getState().signatureDefaults,
    setSignatureDefault: (acc, which, id) => useMail.getState().setSignatureDefault(acc, which, id),
  }),
};

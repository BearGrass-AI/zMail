// Settings → Signatures: the signature list, its editor, and each account's defaults.

import { useState } from "react";
import { Minus, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SignatureEditor } from "./signature-editor";
import { Group } from "./settings-ui";

export function SignaturesPage() {
  const accounts = useMail((s) => s.accounts);
  const signatures = useMail((s) => s.signatures);
  const defaults = useMail((s) => s.signatureDefaults);
  const { addSignature, updateSignature, removeSignature, setSignatureDefault } = useMail.getState();
  const [selected, setSelected] = useState<string | null>(signatures[0]?.id ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = signatures.find((x) => x.id === selected) ?? signatures[0];

  const add = () => {
    const id = addSignature(`Signature ${signatures.length + 1}`);
    setSelected(id);
    setRenaming(id);
  };

  const remove = () => {
    if (!current) return;
    const i = signatures.indexOf(current);
    removeSignature(current.id);
    setSelected(signatures[i + 1]?.id ?? signatures[i - 1]?.id ?? null);
    toast(`Deleted “${current.name}”`, { action: { label: "Undo", onClick: () => setSelected(addSignature(current.name, current.html)) } });
  };

  const pick = (accountId: string, which: "new" | "reply") => (
    <select
      value={defaults[accountId]?.[which] ?? ""}
      onChange={(e) => setSignatureDefault(accountId, which, e.target.value || null)}
      className="h-7 w-[180px] rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12px] outline-none"
    >
      <option value="">(none)</option>
      {signatures.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <p className="mb-4 px-1 text-[12.5px] leading-snug text-foreground/55">
        Add or edit signatures, then choose which one each account uses for new messages and for replies &amp; forwards. Paste a signature from Outlook
        or Word and its formatting comes with it.
      </p>
      <section className="mb-6">
        <div className="overflow-hidden rounded-xl bg-pane-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <div className="max-h-[168px] min-h-[84px] overflow-auto p-1.5">
            {signatures.map((x) => (
              <div
                key={x.id}
                onClick={() => setSelected(x.id)}
                onDoubleClick={() => setRenaming(x.id)}
                className={cn(
                  "flex h-8 cursor-default items-center rounded-md px-2.5 text-[13px]",
                  current?.id === x.id ? "bg-foreground/[0.09] font-medium" : "hover:bg-foreground/[0.04]",
                )}
              >
                {renaming === x.id ? (
                  <input
                    autoFocus
                    defaultValue={x.name}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => {
                      updateSignature(x.id, { name: e.target.value.trim() || x.name });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="selectable h-6 w-full rounded border border-hairline bg-[var(--pane)] px-1.5 outline-none"
                  />
                ) : (
                  x.name
                )}
              </div>
            ))}
            {!signatures.length && <div className="px-2.5 py-6 text-center text-[12.5px] text-foreground/40">No signatures yet. Click + to add one.</div>}
          </div>
          <div className="flex items-center gap-1 border-t border-hairline px-2 py-1.5">
            <div className="flex items-center rounded-md bg-foreground/[0.05]">
              <button onClick={add} aria-label="Add signature" className="grid size-7 place-items-center rounded-md text-foreground/70 hover:bg-foreground/10">
                <Plus className="size-4" />
              </button>
              <span className="h-4 w-px bg-hairline" />
              <button
                onClick={remove}
                disabled={!current}
                aria-label="Delete signature"
                className="grid size-7 place-items-center rounded-md text-foreground/70 hover:bg-foreground/10 disabled:opacity-30"
              >
                <Minus className="size-4" />
              </button>
            </div>
            <button
              onClick={() => current && setRenaming(current.id)}
              disabled={!current}
              aria-label="Rename signature"
              title="Rename"
              className="ml-auto grid size-7 place-items-center rounded-md text-foreground/60 hover:bg-foreground/10 disabled:opacity-30"
            >
              <Pencil className="size-3.5" />
            </button>
          </div>
        </div>
      </section>
      {current && (
        <section className="mb-6">
          <SignatureEditor docKey={current.id} value={current.html} onChange={(html) => updateSignature(current.id, { html })} />
        </section>
      )}
      <Group title="Set default signatures" footer="Replies and forwards get their own choice, like Outlook, so you can keep them short.">
        {accounts.map((a) => (
          <div key={a.id} className="px-4 py-2.5">
            <div className="mb-2 text-[13px] font-medium">
              {a.address}
              {a.kind === "mock" && <span className="text-foreground/40"> · demo</span>}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-foreground/60">
              <label className="flex items-center gap-2">New messages {pick(a.id, "new")}</label>
              <label className="flex items-center gap-2">Replies &amp; forwards {pick(a.id, "reply")}</label>
            </div>
          </div>
        ))}
      </Group>
    </>
  );
}

import { Check, ChevronDown } from "lucide-react";
import { AccountIcon, accountLabel } from "../account-switcher";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { defaultSignatureLabel } from "@/lib/send-as";
import { useMail } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Account } from "@/lib/types";

/** App-styled "send as" picker. `compact` is the short "From <label>" pill used inside the prompt box. */
export function FromPicker({
  accounts,
  value,
  onChange,
  isReply,
  compact,
  finalFocus,
}: {
  accounts: Account[];
  value: string | undefined;
  onChange: (id: string) => void;
  isReply: boolean;
  compact?: boolean;
  /** Where focus goes when the menu closes (default: the trigger). */
  finalFocus?: () => HTMLElement | null;
}) {
  const signatures = useMail((s) => s.signatures);
  const defaults = useMail((s) => s.signatureDefaults);
  const from = accounts.find((a) => a.id === value);
  if (!from) return null;
  const demo = (a: Account) => (a.kind === "mock" ? " (demo)" : "");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="From account"
        className={cn(
          "inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg bg-foreground/[0.06] py-[3px] pr-2 pl-1 text-[13px] ring-1 ring-hairline outline-none hover:bg-foreground/[0.1] focus-visible:ring-2 focus-visible:ring-ring/40 data-popup-open:bg-foreground/[0.1]",
          compact && "text-[12.5px]",
        )}
      >
        <AccountIcon account={from} size={compact ? 18 : 20} />
        {compact && <span className="text-foreground/50">From</span>}
        <span className="truncate">
          {accountLabel(from, accounts)}
          {demo(from)}
        </span>
        {!compact && <span className="truncate text-foreground/45">· {from.address}</span>}
        <ChevronDown className="size-3 shrink-0 text-foreground/45" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-[300px]" finalFocus={finalFocus}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[9.5px] font-medium tracking-[0.06em] text-foreground/40 uppercase">Send as</DropdownMenuLabel>
          {accounts.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => onChange(a.id)} className="gap-2.5 px-2 py-1.5">
              <AccountIcon account={a} size={20} />
              <span className="flex min-w-0 flex-col leading-tight">
                <b className="text-[12.5px] font-semibold">
                  {accountLabel(a, accounts)}
                  {demo(a)}
                </b>
                <span className="truncate text-[11px] text-foreground/50">
                  {a.address} · {defaultSignatureLabel(a.id, isReply, defaults, signatures)}
                </span>
              </span>
              {a.id === value && <Check className="ml-auto size-3.5 text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

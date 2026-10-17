// Keeps one crashing part of the window from blanking the whole app: that part shows a small
// error with Try again, and everything else keeps working.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface Props {
  /** Where it happened, for the message and the console ("the mail list"). */
  label: string;
  /** When this changes (another email, view or set), try rendering again. */
  resetKey?: unknown;
  /** Overlays (dialogs, pickers): close quietly and toast instead of drawing a panel. */
  quiet?: boolean;
  /** Called once after a crash (e.g. close the overlay so it can be opened again). */
  onError?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[zMail] ${this.props.label} crashed`, error, info.componentStack);
    if (this.props.quiet) toast.error(`Something went wrong in ${this.props.label}`, { description: error.message });
    this.props.onError?.();
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div role="alert" className="grid h-full min-h-32 place-items-center p-6">
        <div className="flex max-w-xs flex-col items-center gap-2 text-center">
          <AlertTriangle className="size-5 text-foreground/40" />
          <div className="text-[13px] font-medium">Something went wrong in {this.props.label}.</div>
          <div className="selectable line-clamp-3 text-[11.5px] break-words text-foreground/45">{error.message}</div>
          <div className="mt-1 flex gap-1.5">
            <button
              onClick={() => this.setState({ error: null })}
              className="h-7 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground"
            >
              Try again
            </button>
            <button onClick={() => window.location.reload()} className="h-7 rounded-lg px-3 text-[12px] text-foreground/60 hover:bg-foreground/[0.07]">
              Reload zMail
            </button>
          </div>
        </div>
      </div>
    );
  }
}

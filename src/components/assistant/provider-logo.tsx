// Provider marks (bundled SVGs, see src/assets/providers/provider-branding.md). Monochrome marks
// render in currentColor through a CSS mask; vLLM and Gemini keep their own colors.

import type { CSSProperties } from "react";
import { Bot, Gauge } from "lucide-react";
import type { ProviderTypeId } from "@/lib/ai/catalog";
import { cn } from "@/lib/utils";
import ollama from "@/assets/providers/ollama.svg?inline";
import vllm from "@/assets/providers/vllm.svg?inline";
import openai from "@/assets/providers/openai.svg?inline";
import anthropic from "@/assets/providers/anthropic.svg?inline";
import gemini from "@/assets/providers/gemini.svg?inline";
import xai from "@/assets/providers/xai.svg?inline";
import perplexity from "@/assets/providers/perplexity.svg?inline";
import openrouter from "@/assets/providers/openrouter.svg?inline";

const MARKS: Partial<Record<ProviderTypeId, { src: string; monochrome: boolean }>> = {
  ollama: { src: ollama, monochrome: true },
  vllm: { src: vllm, monochrome: false },
  openai: { src: openai, monochrome: true },
  anthropic: { src: anthropic, monochrome: true },
  gemini: { src: gemini, monochrome: false },
  xai: { src: xai, monochrome: true },
  perplexity: { src: perplexity, monochrome: true },
  openrouter: { src: openrouter, monochrome: true },
};

/** Decorative provider mark; the surrounding control supplies its accessible name. */
export function ProviderLogo({ provider, className = "size-3.5" }: { provider: ProviderTypeId; className?: string }) {
  const mark = MARKS[provider];
  if (!mark) {
    const Icon = provider === "jev" ? Gauge : Bot;
    return <Icon className={className} aria-hidden />;
  }
  if (!mark.monochrome) return <img src={mark.src} alt="" aria-hidden draggable={false} className={cn("inline-block shrink-0 object-contain", className)} />;
  const mask = `url("${mark.src}") center / contain no-repeat`;
  const style: CSSProperties = { backgroundColor: "currentColor", mask, WebkitMask: mask };
  return <span aria-hidden className={cn("inline-block shrink-0", className)} style={style} />;
}

# Provider marks

These locally bundled marks identify AI providers. They are trademarks of their respective owners and do not indicate affiliation with zMail. No logo requests leave the app at runtime: Vite's `?inline` imports embed every asset in the bundle.

Sources checked September 9, 2026:

| Provider | Bundled asset | Source and treatment |
| --- | --- | --- |
| Ollama | `ollama.svg` | [Official repository asset](https://github.com/ollama/ollama/blob/main/docs/ollama-logo.svg). Original llama silhouette, unchanged. |
| vLLM | `vllm.svg` | [Official media kit compact mark](https://github.com/vllm-project/media-kit/blob/main/vLLM-Logo.svg). Original yellow/blue SVG, unchanged. The [media kit](https://github.com/vllm-project/media-kit) recommends the compact version for small spaces. |
| OpenAI | `openai.svg` | `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` from the [official logo archive](https://cdn.openai.com/brand/openai-logos.zip); [brand guidelines](https://openai.com/brand/). The surrounding artboard whitespace is trimmed with a viewBox of `178 178 360 360`; the blossom path is unchanged. |
| Anthropic | `anthropic.svg` | The compact `viewBox="0 0 35 24"` AI monogram embedded in the mobile home navigation of [Anthropic's official site](https://www.anthropic.com/). Paths and original `currentColor` fills are unchanged; the SVG namespace is added for standalone use. This is Anthropic's company mark. |
| Google Gemini | `gemini.svg` | Original colored sparkle [served by Google](https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg), referenced by [the official Gemini app](https://gemini.google.com/). The SVG, including its embedded gradient image, is unchanged. This matches the Google Gemini provider label. |
| xAI | `xai.svg` | Original xAI monogram [archived on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:XAI-Logo.svg), [SVG download](https://upload.wikimedia.org/wikipedia/commons/5/57/XAI-Logo.svg), attributed there to X.AI Corp. and sourced from x.ai. Geometry is unchanged. The current [official site](https://x.ai/legal/brand-guidelines) uses SpaceXAI branding. |
| Perplexity | `perplexity.svg` | Compact mark extracted from the first path of the [official Perplexity model repository logo](https://huggingface.co/perplexity-ai/pplx-embed-v1-0.6b/blob/main/assets/logo.svg), [SVG download](https://huggingface.co/perplexity-ai/pplx-embed-v1-0.6b/resolve/main/assets/logo.svg). The original path and fill are unchanged; background and wordmark are omitted, with a `395 412 218 254` viewBox around the compact mark. |
| OpenRouter | `openrouter.svg` | [Official current glyph](https://openrouter.ai/brand/v2/openrouter-glyph-light.svg), referenced by [OpenRouter's official site](https://openrouter.ai/). SVG unchanged. This is the OR identity introduced in the [July 2026 brand refresh](https://openrouter.ai/blog/announcements/brand-refresh/); the monochrome presentation matches the site's compact navigation mark. |

`ProviderLogo({ provider, className })` (`src/components/assistant/provider-logo.tsx`) is decorative (`aria-hidden`); its adjacent provider name or containing control must supply an accessible name. A CSS alpha mask renders the monochrome marks in the surrounding text color, making them legible on light and dark surfaces. Gemini and vLLM keep their source colors. The decision types without a brand mark use lucide icons: Jev API → `Gauge`, Custom (SystemOne) and OpenAI-compatible → `Bot`.

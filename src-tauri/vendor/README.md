# Vendored crates

## llama-cpp-sys-2

Used through `[patch.crates-io]` in `../Cargo.toml` so `llama-cpp-2` can run the
meaning-based search model, EmbeddingGemma 2.

**Why:** `llama-cpp-2` 0.1.159 (and 0.1.160) bundles a llama.cpp from before the
`gemma-embedding2` architecture existed (added in llama.cpp b11452), so it can't load
the model.

**What it is:**

- The published crate `llama-cpp-sys-2` **0.1.159** (crates.io), unchanged except:
  - `llama.cpp/` replaced with llama.cpp tag **b11461**
    (https://github.com/ggml-org/llama.cpp/releases/tag/b11461), the same tag the
    reference vectors were made with.
  - `wrapper_common.cpp`: `llama_rs_mtp_speculative_process` is stubbed to return
    `LLAMA_RS_STATUS_EXCEPTION`. `common_speculative_process` takes a
    `common_batch` from b11452 on, so the old wrapper no longer compiles. zMail never
    uses speculative decoding.
- One patch to llama.cpp itself, `llama.cpp/src/llama-context.cpp` (from DigUp):
  `has_logits` is false for a non-causal embedding context. Without it, every
  embedding batch reserves and clears `n_vocab` floats per token, about 1 MiB per
  token with Gemma's 262k vocabulary. Upstream fixes this in b11630.

**Trimmed** to what the macOS build (Metal + CPU) needs, from about 177 MB for the
whole b11461 tree (the published crate ships about 39 MB) to about 14 MB:

- Kept: `CMakeLists.txt`, `cmake/`, `include/`, `src/`, `common/`, `ggml/`,
  `vendor/`, `licenses/`, `LICENSE`.
- Left out: models, docs, tests, examples, tools, scripts, gguf-py, the web UI and
  CI files; the ggml backends this build never enables (CUDA, HIP, MUSA, Vulkan,
  SYCL, OpenCL, CANN, Hexagon, OpenVINO, ET, WebGPU, VirtGPU, RPC, zDNN, ZenDNN);
  ggml-cpu's code for other architectures (LoongArch, PowerPC, RISC-V, s390,
  WebAssembly, SpacemiT); and `vendor/miniaudio/miniaudio.h` and
  `vendor/stb/stb_image.h`, which only the multimodal tools use. Their CMake
  targets stay, so configuring still works; turning on the crate's `mtmd`
  feature would need them back.
- Every LICENSE file in the kept tree is kept.

**Checks:** `semantic::embed::tests::reference_vectors` compares this build's
vectors with DigUp's references for the same model file and llama.cpp tag (cosine
at least 0.9999). It needs the model file, so it's ignored by default:

```
ZMAIL_EMBED_MODEL=/path/to/embeddinggemma-2-Q8_0.gguf \
  cargo test --lib reference_vectors -- --ignored --nocapture
```

Run it after any change here.

**When to drop this fork:** once a `llama-cpp-2` release bundles llama.cpp
b11452 or newer (so it loads `gemma-embedding2`). Then remove the
`[patch.crates-io]` entry and this folder, bump `llama-cpp-2`, and run the
reference-vector test. If the newer llama.cpp is b11630 or later, the
`has_logits` patch is upstream already. If the vectors move, bump
`semantic::index::INDEX_VERSION` so existing indexes rebuild.

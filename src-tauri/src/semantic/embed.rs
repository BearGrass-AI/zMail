//! The embedding model, EmbeddingGemma 2 on llama.cpp (Metal), behind one worker thread.
//!
//! Inputs are framed as the reference frames them, `<bos> text <eos>` (cut to `MAX_TOKENS`
//! keeping both), mean-pooled and L2-normalised; the vector kept is the first `DIMS` of the 768
//! (Matryoshka) renormalised. These choices are pinned by the reference-vector test below.
//!
//! The model and its context live on a worker thread that loads them on the first job and exits
//! after `IDLE` without one, so the ~350 MB they take is only held while search or indexing uses
//! them. Jobs are answered in order; the indexer keeps its jobs small and sends one at a time, so a
//! search waits behind at most one of them.

use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::token::LlamaToken;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Dimensions kept per vector.
pub const DIMS: usize = 256;
/// Longest input, in tokens with `<bos>` and `<eos>`: documents, passages and queries alike.
pub const MAX_TOKENS: usize = 512;
/// Tokens per decode (several inputs share one), and inputs per decode.
const N_BATCH: usize = 1024;
const N_SEQ: usize = 64;
/// CPU threads llama.cpp may use; the model itself runs on the GPU.
const N_THREADS: i32 = 2;
/// The worker frees the model after this long without a job.
const IDLE: Duration = Duration::from_secs(180);

/// What a job is for: a search someone is waiting on, or background indexing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Query,
    Index,
}

/// Turns framed texts into vectors: `DIMS` long, unit length, one per text in order, `None` for
/// one whose vector came out non-finite. Tests use a fake.
pub trait Embed: Send + Sync {
    fn embed(&self, texts: &[String], priority: Priority) -> Result<Vec<Option<Vec<f32>>>, String>;
}

/// The first `DIMS` values of a vector, renormalised to unit length.
pub fn truncate(v: &[f32]) -> Option<Vec<f32>> {
    let head = &v[..DIMS.min(v.len())];
    let norm = head.iter().map(|x| x * x).sum::<f32>().sqrt();
    (norm.is_finite() && norm > 0.0).then(|| head.iter().map(|x| x / norm).collect())
}

/// llama.cpp's process-wide setup happens once. Its logs (and ggml's, which start while the
/// backend initialises the GPU) are silenced first.
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            llama_cpp_2::send_logs_to_tracing(
                llama_cpp_2::LogOptions::default().with_logs_enabled(false),
            );
            LlamaBackend::init().map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn load_model(path: &Path) -> Result<LlamaModel, String> {
    // Checked here: llama-cpp-2 asserts it in debug builds instead of returning an error.
    if !path.is_file() {
        return Err(format!(
            "couldn't load the search model: {} is missing",
            path.display()
        ));
    }
    let params = LlamaModelParams::default().with_n_gpu_layers(999);
    LlamaModel::load_from_file(backend()?, path, &params)
        .map_err(|e| format!("couldn't load the search model: {e}"))
}

/// A context over a loaded model that embeds batches of texts.
pub struct Encoder<'m> {
    model: &'m LlamaModel,
    ctx: LlamaContext<'m>,
    batch: LlamaBatch<'m>,
    max_tokens: usize,
    n_batch: usize,
}

impl<'m> Encoder<'m> {
    /// `max_tokens` per input; `n_batch` (at least `max_tokens`) tokens per decode.
    pub fn new(model: &'m LlamaModel, max_tokens: usize, n_batch: usize) -> Result<Self, String> {
        let n_batch = n_batch.max(max_tokens);
        let n = u32::try_from(n_batch).map_err(|e| e.to_string())?;
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n))
            .with_n_batch(n)
            .with_n_ubatch(n)
            .with_n_seq_max(N_SEQ as u32)
            // Each input may use the whole context, as in llama-embedding.
            .with_kv_unified(true)
            .with_embeddings(true)
            .with_pooling_type(LlamaPoolingType::Mean)
            .with_n_threads(N_THREADS)
            .with_n_threads_batch(N_THREADS);
        let ctx = model
            .new_context(backend()?, params)
            .map_err(|e| format!("couldn't start the search model: {e}"))?;
        Ok(Self {
            model,
            ctx,
            batch: LlamaBatch::new(n_batch, N_SEQ as i32),
            max_tokens,
            n_batch,
        })
    }

    /// `<bos> text <eos>`, cut to `max_tokens` keeping both special tokens.
    fn tokenize(&self, text: &str) -> Vec<LlamaToken> {
        let vocab = self.model.vocab();
        let (bos, eos) = (vocab.bos(), vocab.eos());
        let mut t = vocab.tokenize(text.as_bytes(), true, false);
        if t.first() != Some(&bos) {
            t.insert(0, bos);
        }
        if t.last() == Some(&eos) {
            t.pop();
        }
        t.truncate(self.max_tokens - 1);
        t.push(eos);
        t
    }

    /// Unit-length vectors at the model's full size (768), one per text in order.
    pub fn embed_full(&mut self, texts: &[String]) -> Result<Vec<Option<Vec<f32>>>, String> {
        let mut out = Vec::with_capacity(texts.len());
        let mut pending: Vec<Vec<LlamaToken>> = Vec::new();
        let mut pending_tokens = 0;
        for text in texts {
            let toks = self.tokenize(text);
            if !pending.is_empty()
                && (pending.len() == N_SEQ || pending_tokens + toks.len() > self.n_batch)
            {
                self.flush(&mut pending, &mut out)?;
                pending_tokens = 0;
            }
            pending_tokens += toks.len();
            pending.push(toks);
        }
        self.flush(&mut pending, &mut out)?;
        Ok(out)
    }

    fn flush(
        &mut self,
        pending: &mut Vec<Vec<LlamaToken>>,
        out: &mut Vec<Option<Vec<f32>>>,
    ) -> Result<(), String> {
        if pending.is_empty() {
            return Ok(());
        }
        self.batch.clear();
        for (s, toks) in pending.iter().enumerate() {
            self.batch
                .add_sequence(toks, s as i32, true)
                .map_err(|e| e.to_string())?;
        }
        self.ctx.clear_kv_cache();
        self.ctx
            .decode(&mut self.batch)
            .map_err(|e| format!("the search model failed: {e}"))?;
        for s in 0..pending.len() {
            let e = self
                .ctx
                .embeddings_seq_ith(s as i32)
                .map_err(|e| e.to_string())?;
            let norm = e.iter().map(|x| x * x).sum::<f32>().sqrt();
            let v: Vec<f32> = e.iter().map(|x| x / norm).collect();
            out.push(
                (norm.is_finite() && norm > 0.0 && v.iter().all(|x| x.is_finite())).then_some(v),
            );
        }
        pending.clear();
        Ok(())
    }
}

/// Lower the calling thread's priority for background work, or raise it for a search.
fn set_qos(priority: Priority) {
    let class = match priority {
        Priority::Query => libc::qos_class_t::QOS_CLASS_USER_INITIATED,
        Priority::Index => libc::qos_class_t::QOS_CLASS_UTILITY,
    };
    // SAFETY: changes only the calling thread's own QoS class; no pointers are involved.
    unsafe {
        libc::pthread_set_qos_class_self_np(class, 0);
    }
}

type Reply = mpsc::Sender<Result<Vec<Option<Vec<f32>>>, String>>;

struct Job {
    texts: Vec<String>,
    priority: Priority,
    reply: Reply,
}

/// The real embedder: one worker thread over the model file at `path`.
pub struct Embedder {
    path: PathBuf,
    /// The running worker's queue; None when no worker runs. Held while sending, and by the worker
    /// while it decides to exit, so a job is never sent to a worker that's leaving.
    queue: std::sync::Arc<Mutex<Option<mpsc::Sender<Job>>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Set by `shutdown`: no worker starts after it.
    closed: AtomicBool,
}

impl Embedder {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            queue: Default::default(),
            worker: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }

    fn spawn(&self) -> Result<mpsc::Sender<Job>, String> {
        let (tx, rx) = mpsc::channel::<Job>();
        let path = self.path.clone();
        let queue = self.queue.clone();
        let handle = std::thread::Builder::new()
            .name("embedder".into())
            .spawn(move || worker(&path, &rx, &queue))
            .map_err(|e| e.to_string())?;
        // A previous worker has left already (that's why there was no queue).
        if let Ok(mut w) = self.worker.lock() {
            *w = Some(handle);
        }
        Ok(tx)
    }

    /// Stop the worker and free the model, waiting for the job it's on. Needed before the process
    /// exits: Metal asserts if GPU buffers are still allocated then. Later jobs are refused.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut q) = self.queue.lock() {
            // The worker sees its queue close once it has answered what's queued.
            *q = None;
        }
        let handle = self.worker.lock().ok().and_then(|mut w| w.take());
        if let Some(h) = handle {
            let _ = h.join();
        }
    }
}

impl Drop for Embedder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Embed for Embedder {
    fn embed(&self, texts: &[String], priority: Priority) -> Result<Vec<Option<Vec<f32>>>, String> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        let (reply, answer) = mpsc::channel();
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            if self.closed.load(Ordering::SeqCst) {
                return Err("the search model has shut down".into());
            }
            if queue.is_none() {
                *queue = Some(self.spawn()?);
            }
            let job = Job {
                texts: texts.to_vec(),
                priority,
                reply,
            };
            queue
                .as_ref()
                .ok_or("no embedder")?
                .send(job)
                .map_err(|_| "the search model stopped".to_string())?;
        }
        answer
            .recv()
            .map_err(|_| "the search model stopped".to_string())?
    }
}

fn worker(path: &Path, rx: &mpsc::Receiver<Job>, queue: &Mutex<Option<mpsc::Sender<Job>>>) {
    // Leaving: no new job can arrive once the queue slot is cleared under its lock.
    let leave = |err: Option<&str>| {
        if let Ok(mut slot) = queue.lock() {
            *slot = None;
            while let Ok(job) = rx.try_recv() {
                let _ = job
                    .reply
                    .send(Err(err.unwrap_or("the search model stopped").into()));
            }
        }
    };
    let model = match load_model(path) {
        Ok(m) => m,
        Err(e) => return leave(Some(&e)),
    };
    let mut enc = match Encoder::new(&model, MAX_TOKENS, N_BATCH) {
        Ok(enc) => enc,
        Err(e) => return leave(Some(&e)),
    };
    loop {
        let job = match rx.recv_timeout(IDLE) {
            Ok(job) => job,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let Ok(mut slot) = queue.lock() else { return };
                match rx.try_recv() {
                    Ok(job) => job,
                    Err(_) => {
                        *slot = None;
                        return;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        set_qos(job.priority);
        let res = enc.embed_full(&job.texts).map(|vs| {
            vs.into_iter()
                .map(|v| v.and_then(|v| truncate(&v)))
                .collect()
        });
        let _ = job.reply.send(res);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_model_fails_and_shutdown_refuses_later_jobs() {
        let e = Embedder::new(std::env::temp_dir().join("zmail-no-such-model.gguf"));
        let err = e.embed(&["hi".into()], Priority::Query).unwrap_err();
        assert!(err.contains("couldn't load"), "{err}");
        // The failed worker left; the next job starts another (and fails the same way).
        assert!(e.embed(&["hi".into()], Priority::Index).is_err());
        e.shutdown();
        assert_eq!(
            e.embed(&["hi".into()], Priority::Query).unwrap_err(),
            "the search model has shut down"
        );
        assert!(e.embed(&[], Priority::Query).unwrap().is_empty());
    }

    #[test]
    fn truncate_keeps_the_head_at_unit_length() {
        let mut v = vec![0.0f32; 768];
        v[0] = 3.0;
        v[1] = 4.0;
        v[500] = 100.0;
        let t = truncate(&v).unwrap();
        assert_eq!(t.len(), DIMS);
        assert!((t[0] - 0.6).abs() < 1e-6 && (t[1] - 0.8).abs() < 1e-6);
        assert!(truncate(&[0.0; 768]).is_none());
        assert!(truncate(&[f32::NAN; 768]).is_none());
    }

    /// The vectors this build makes against DigUp's references (same model file, same llama.cpp
    /// tag): every llama.cpp update must pass this before it ships. Needs the model file, so it's
    /// ignored by default: `ZMAIL_EMBED_MODEL=/path/to/embeddinggemma-2-Q8_0.gguf cargo test
    /// reference_vectors -- --ignored`.
    #[test]
    #[ignore = "needs the 310 MB model file; set ZMAIL_EMBED_MODEL"]
    fn reference_vectors() {
        let path = std::env::var("ZMAIL_EMBED_MODEL").expect("set ZMAIL_EMBED_MODEL");
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("testdata/reference_vectors.json")).unwrap();
        let query = |q: &str| format!("task: search result | query: {q}");
        let doc = |title: Option<&str>, text: &str| {
            format!("title: {} | text: {text}", title.unwrap_or("none"))
        };
        let long = (1..=60)
            .map(|n| {
                format!(
                    "Note {n}: the review moved to room {} because the projector in the main hall failed again, and the team agreed to send the slides the night before.",
                    n % 7 + 2
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        let inputs = [
            ("query", query("payment declined error")),
            ("query-bn", query("ইলিশ মাছ রান্না")),
            ("query-ar", query("متى تغلق المكتبة")),
            (
                "document",
                doc(
                    Some("Tokyo itinerary"),
                    "Flight to Tokyo Haneda on November 3. Then the train to Kamakura to see the Great Buddha, and back for dinner in Shibuya.",
                ),
            ),
            // About 2,000 tokens, past the sliding attention window: the reference cuts at 2048.
            ("document-long", doc(None, &long)),
        ];
        let model = load_model(Path::new(&path)).unwrap();
        let mut enc = Encoder::new(&model, 2048, 2048).unwrap();
        let texts: Vec<String> = inputs.iter().map(|(_, t)| t.clone()).collect();
        let made = enc.embed_full(&texts).unwrap();
        for ((name, _), v) in inputs.iter().zip(made) {
            let v = v.expect("finite vector");
            let want: Vec<f32> = reference["vectors"][name]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap() as f32)
                .collect();
            assert_eq!(v.len(), want.len());
            let cos: f32 = v.iter().zip(&want).map(|(a, b)| a * b).sum();
            eprintln!("{name}: cosine {cos:.6}");
            assert!(cos >= 0.9999, "{name}: cosine {cos}");
        }
    }
}

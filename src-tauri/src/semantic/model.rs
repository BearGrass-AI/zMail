//! The search model file: where it comes from (pinned), and its download.
//!
//! The download writes `<name>.part` in the models folder, resumes it with a Range request, checks
//! the exact size and SHA-256, and only then renames it into place. So the model file exists only
//! once it's verified, and "ready" means exactly that file being there at its pinned size.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// A pinned file: one revision of one repo, its exact size and digest.
#[derive(Debug, Clone, Copy)]
pub struct Pin {
    pub file: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// The model revision vectors are made with; indexes record it, so a different one rebuilds them.
pub const MODEL_REVISION: &str = "bfcd298762cc34d0357ece5ebdd31791a3a374d8";

/// EmbeddingGemma 2 (Q8_0 GGUF) from llama.cpp's own Hugging Face org: Apache-2.0, no login.
pub const MODEL: Pin = Pin {
    file: "embeddinggemma-2-Q8_0.gguf",
    // The revision above, spelled out: `concat!` takes only literals.
    url: "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf",
    size: 309_855_456,
    sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
};

pub fn models_dir(app_data: &Path) -> PathBuf {
    app_data.join("models")
}

pub fn model_path(dir: &Path, pin: &Pin) -> PathBuf {
    dir.join(pin.file)
}

pub fn part_path(dir: &Path, pin: &Pin) -> PathBuf {
    dir.join(format!("{}.part", pin.file))
}

/// The verified model file, if it's in place (only a verified download is ever renamed there).
pub fn ready_path(dir: &Path, pin: &Pin) -> Option<PathBuf> {
    let path = model_path(dir, pin);
    let len = std::fs::metadata(&path).ok()?.len();
    (len == pin.size).then_some(path)
}

/// Bytes of an unfinished download kept for resuming.
pub fn partial_len(dir: &Path, pin: &Pin) -> u64 {
    std::fs::metadata(part_path(dir, pin)).map_or(0, |m| m.len())
}

/// Delete the model and any unfinished download.
pub fn remove(dir: &Path, pin: &Pin) -> Result<(), String> {
    for path in [model_path(dir, pin), part_path(dir, pin)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("couldn't delete {}: {e}", path.display())),
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum DownloadError {
    Cancelled,
    /// The file arrived but isn't the pinned one; what was downloaded is deleted.
    Mismatch(String),
    Failed(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "cancelled"),
            Self::Mismatch(m) | Self::Failed(m) => write!(f, "{m}"),
        }
    }
}

/// A client for one long download: no overall timeout (a slow connection may need minutes), but
/// connecting and every read must make progress.
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Download `pin` into `dir`, resuming a `.part` left by an earlier try. Reports (bytes so far,
/// total) as data arrives; stops between chunks once `cancel` is set, keeping the `.part`. Returns
/// the verified file's path, after it's renamed into place.
pub async fn download(
    client: &reqwest::Client,
    pin: &Pin,
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf, DownloadError> {
    let fail = |e: &dyn std::fmt::Display| DownloadError::Failed(e.to_string());
    std::fs::create_dir_all(dir).map_err(|e| fail(&e))?;
    let part = part_path(dir, pin);
    let mut have = partial_len(dir, pin);
    if have > pin.size {
        std::fs::remove_file(&part).map_err(|e| fail(&e))?;
        have = 0;
    }
    if have < pin.size {
        let mut req = client.get(pin.url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut res = req
            .send()
            .await
            .map_err(|e| fail(&format!("couldn't reach the download server: {e}")))?;
        let status = res.status();
        let open = || {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part)
                .map_err(|e| fail(&e))
        };
        let mut file;
        if status == reqwest::StatusCode::PARTIAL_CONTENT && have > 0 {
            // Appending only if the server resumed where we asked.
            let start = res
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("bytes "))
                .and_then(|v| v.split('-').next())
                .and_then(|v| v.parse::<u64>().ok());
            if start != Some(have) {
                return Err(fail(&"the server resumed at the wrong place"));
            }
            file = open()?;
        } else if status == reqwest::StatusCode::OK {
            // A whole file (the server ignored the range, or there was nothing to resume).
            file = open()?;
            file.set_len(0).map_err(|e| fail(&e))?;
            have = 0;
        } else {
            return Err(fail(&format!("the download server answered {status}")));
        }
        progress(have, pin.size);
        loop {
            if cancel.load(Ordering::Relaxed) {
                file.flush().map_err(|e| fail(&e))?;
                return Err(DownloadError::Cancelled);
            }
            let chunk = res
                .chunk()
                .await
                .map_err(|e| fail(&format!("the download stopped: {e}")))?;
            let Some(chunk) = chunk else { break };
            have += chunk.len() as u64;
            if have > pin.size {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(DownloadError::Mismatch(
                    "The download was bigger than the model should be, so it was deleted.".into(),
                ));
            }
            file.write_all(&chunk).map_err(|e| fail(&e))?;
            progress(have, pin.size);
        }
        file.sync_all().map_err(|e| fail(&e))?;
        if have < pin.size {
            return Err(fail(&"the download ended early"));
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(DownloadError::Cancelled);
    }
    progress(pin.size, pin.size);
    let sha = {
        let part = part.clone();
        tauri::async_runtime::spawn_blocking(move || sha256_file(&part))
            .await
            .map_err(|e| fail(&e))?
            .map_err(|e| fail(&e))?
    };
    if sha != pin.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(DownloadError::Mismatch(
            "The download didn't match the model's checksum, so it was deleted.".into(),
        ));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(DownloadError::Cancelled);
    }
    let dest = model_path(dir, pin);
    std::fs::rename(&part, &dest).map_err(|e| fail(&e))?;
    Ok(dest)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::Mutex;

    fn body() -> Vec<u8> {
        (0..200_000u32).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn sha_hex(b: &[u8]) -> String {
        Sha256::digest(b)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// A loopback server for one file. `honor_range`: answer a Range request with 206 from that
    /// byte; otherwise with the whole file. Records each request's Range header.
    fn serve(data: Vec<u8>, honor_range: bool) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.gguf", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(vec![]));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut range = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        range = v.trim().trim_end_matches('-').parse::<usize>().ok();
                    }
                }
                log.lock().unwrap().push(range.map(|r| r.to_string()));
                let (status, start) = match range {
                    Some(r) if honor_range => ("206 Partial Content", r),
                    _ => ("200 OK", 0),
                };
                let part = &data[start..];
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                    part.len(),
                    data.len() - 1,
                    data.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(part);
            }
        });
        (url, seen)
    }

    fn pin_for(url: String, data: &[u8]) -> Pin {
        Pin {
            file: "model.gguf",
            url: Box::leak(url.into_boxed_str()),
            size: data.len() as u64,
            sha256: Box::leak(sha_hex(data).into_boxed_str()),
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zmail-model-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn run(pin: &Pin, dir: &Path, cancel: &AtomicBool) -> Result<PathBuf, DownloadError> {
        let client = client().unwrap();
        tauri::async_runtime::block_on(download(&client, pin, dir, cancel, |_, _| {}))
    }

    #[test]
    fn pinned_model_constants_agree() {
        assert!(MODEL.url.contains(MODEL_REVISION));
        assert!(MODEL.url.ends_with(MODEL.file));
        assert_eq!(MODEL.sha256.len(), 64);
        assert_eq!(MODEL.size, 309_855_456);
    }

    #[test]
    fn downloads_verifies_and_renames() {
        let data = body();
        let (url, _) = serve(data.clone(), true);
        let pin = pin_for(url, &data);
        let dir = tmp("full");
        let got = run(&pin, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(&got).unwrap(), data);
        assert_eq!(ready_path(&dir, &pin), Some(got));
        assert!(!part_path(&dir, &pin).exists());
        remove(&dir, &pin).unwrap();
        assert!(ready_path(&dir, &pin).is_none());
    }

    #[test]
    fn resumes_a_partial_download_with_range() {
        let data = body();
        let (url, seen) = serve(data.clone(), true);
        let pin = pin_for(url, &data);
        let dir = tmp("resume");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(part_path(&dir, &pin), &data[..70_000]).unwrap();
        assert!(ready_path(&dir, &pin).is_none());
        let got = run(&pin, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(got).unwrap(), data);
        assert_eq!(*seen.lock().unwrap(), vec![Some("70000".to_string())]);
    }

    #[test]
    fn a_server_ignoring_range_restarts_cleanly() {
        let data = body();
        let (url, _) = serve(data.clone(), false);
        let pin = pin_for(url, &data);
        let dir = tmp("norange");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(part_path(&dir, &pin), &data[..50_000]).unwrap();
        let got = run(&pin, &dir, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(got).unwrap(), data);
    }

    #[test]
    fn a_checksum_mismatch_deletes_the_file() {
        let data = body();
        let (url, _) = serve(data.clone(), true);
        let mut pin = pin_for(url, &data);
        pin.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        let dir = tmp("sha");
        let err = run(&pin, &dir, &AtomicBool::new(false)).unwrap_err();
        assert!(matches!(err, DownloadError::Mismatch(_)));
        assert!(!part_path(&dir, &pin).exists());
        assert!(!model_path(&dir, &pin).exists());
        assert!(ready_path(&dir, &pin).is_none());
    }

    #[test]
    fn a_bigger_file_than_pinned_is_refused() {
        let data = body();
        let (url, _) = serve(data.clone(), true);
        let mut pin = pin_for(url, &data);
        pin.size = 100_000;
        let dir = tmp("big");
        let err = run(&pin, &dir, &AtomicBool::new(false)).unwrap_err();
        assert!(matches!(err, DownloadError::Mismatch(_)));
        assert!(!part_path(&dir, &pin).exists());
        assert!(!model_path(&dir, &pin).exists());
    }

    #[test]
    fn cancel_keeps_the_partial_file_and_no_model() {
        let data = body();
        let (url, _) = serve(data.clone(), true);
        let pin = pin_for(url, &data);
        let dir = tmp("cancel");
        let err = run(&pin, &dir, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err, DownloadError::Cancelled);
        assert!(!model_path(&dir, &pin).exists());
        assert!(part_path(&dir, &pin).exists());
    }

    #[test]
    fn an_http_error_is_reported_and_writes_no_model() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let data = body();
        let pin = pin_for(url, &data);
        let dir = tmp("404");
        let err = run(&pin, &dir, &AtomicBool::new(false)).unwrap_err();
        assert!(
            matches!(err, DownloadError::Failed(ref m) if m.contains("404")),
            "{err:?}"
        );
        assert!(ready_path(&dir, &pin).is_none());
    }
}

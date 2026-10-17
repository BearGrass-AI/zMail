//! Saving attachments to disk and opening/revealing them.

use base64::{Engine, engine::general_purpose::STANDARD};
use std::fs::{DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Bidi overrides and zero-width characters: they let `invoice\u{202E}fdp.command`
/// display as "invoicecommand.pdf".
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}'
    )
}

/// Strip path separators, control and invisible characters from a provider-supplied name.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() || invisible(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed
    }
}

/// Write `bytes` to a new file `name` in `dir` (`report.pdf` → `report (2).pdf` if taken).
/// Creating the file reserves the name, so saves of the same name at once each get their own
/// file, and a symlink already at the name (even a dangling one) counts as taken, not followed.
pub fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let path = match n {
            1 => dir.join(name),
            _ => dir.join(format!("{stem} ({n}){ext}")),
        };
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes) {
                    let _ = std::fs::remove_file(&path);
                    return Err(e);
                }
                return Ok(path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

/// A new directory under `parent` that no other call shares (owner-only on Unix).
fn private_dir(parent: &Path) -> std::io::Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(parent)?;
    loop {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = parent.join(format!("{}-{n}", std::process::id()));
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(&dir) {
            Ok(()) => return Ok(dir),
            // Left by an earlier run with the same process id.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
}

#[tauri::command(async)]
pub fn save_attachment(
    app: AppHandle,
    filename: String,
    base64: String,
    to: String,
) -> Result<String, String> {
    let dir = match to.as_str() {
        "downloads" => app.path().download_dir().map_err(|e| e.to_string())?,
        _ => app
            .path()
            .temp_dir()
            .map_err(|e| e.to_string())?
            .join("zmail-attachments"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bytes = STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("bad attachment data: {e}"))?;
    let path = write_new(&dir, &safe_name(&filename), &bytes).map_err(|e| e.to_string())?;
    quarantine(&path);
    Ok(path.to_string_lossy().into_owned())
}

/// Mark the file as downloaded so Gatekeeper checks it when it's opened.
/// Best effort: a failure is logged, not fatal to the save.
#[cfg(target_os = "macos")]
fn quarantine(path: &Path) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let value = format!("0083;{secs:x};zMail;");
    match std::process::Command::new("/usr/bin/xattr")
        .args(["-w", "com.apple.quarantine", &value])
        .arg(path)
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => eprintln!(
            "[files] quarantine failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => eprintln!("[files] quarantine failed for {}: {e}", path.display()),
    }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_path: &Path) {}

pub const RISKY_MESSAGE: &str =
    "This file type can run code, so zMail showed it in Finder instead.";

/// File types that run code or launch something when opened. These are revealed, never opened.
pub fn risky(name: &str) -> bool {
    let lower = name.to_lowercase();
    let Some((stem, ext)) = lower.rsplit_once('.') else {
        return false;
    };
    if ext == "zip" {
        // A zipped app; `write_new` turns a second `x.app.zip` into `x.app (2).zip`.
        let stem = match stem.rsplit_once(" (") {
            Some((s, n))
                if n.len() > 1
                    && n.ends_with(')')
                    && n[..n.len() - 1].chars().all(|c| c.is_ascii_digit()) =>
            {
                s
            }
            _ => stem,
        };
        return stem.ends_with(".app");
    }
    matches!(
        ext,
        "app"
            | "command"
            | "sh"
            | "bash"
            | "zsh"
            | "csh"
            | "tool"
            | "terminal"
            | "workflow"
            | "scpt"
            | "scptd"
            | "applescript"
            | "pkg"
            | "mpkg"
            | "dmg"
            | "jar"
            | "webloc"
            | "inetloc"
            | "fileloc"
            | "url"
    )
}

/// The real path of `path` if it lies inside one of `roots`; anything else is refused.
pub fn confine(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let refused = || "not an attachment path".to_string();
    let real = path.canonicalize().map_err(|_| refused())?;
    let inside = roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| real.starts_with(r));
    if inside { Ok(real) } else { Err(refused()) }
}

/// Where `save_attachment` writes: the only places the webview may open or reveal.
fn attachment_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(t) = app.path().temp_dir() {
        roots.push(t.join("zmail-attachments"));
    }
    if let Ok(d) = app.path().download_dir() {
        roots.push(d);
    }
    roots
}

/// Whether textutil can turn this file name's extension into text.
pub fn extractable(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some("doc" | "docx" | "rtf" | "rtfd" | "odt")
    )
}

/// Plain text of a Word, RTF or OpenDocument file, via macOS textutil.
#[tauri::command(async)]
pub fn extract_text(app: AppHandle, filename: String, base64: String) -> Result<String, String> {
    let name = safe_name(&filename);
    if !extractable(&name) {
        return Err("unsupported file type".into());
    }
    let bytes = STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("bad file data: {e}"))?;
    // Its own directory per call: extractions running at once never read or delete each other's file.
    let parent = app
        .path()
        .temp_dir()
        .map_err(|e| e.to_string())?
        .join("zmail-extract");
    let dir = private_dir(&parent).map_err(|e| e.to_string())?;
    let out = write_new(&dir, &name, &bytes).and_then(|path| {
        std::process::Command::new("/usr/bin/textutil")
            .args(["-convert", "txt", "-stdout"])
            .arg(&path)
            .output()
    });
    let _ = std::fs::remove_dir_all(&dir);
    let out = out.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err
            .lines()
            .next()
            .unwrap_or("could not read this file")
            .to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command(async)]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    let real = confine(Path::new(&path), &attachment_roots(&app))?;
    // Check both names: a symlink called x.pdf could point at x.command.
    let named_risky = |p: &Path| p.file_name().is_some_and(|n| risky(&n.to_string_lossy()));
    if named_risky(Path::new(&path)) || named_risky(&real) {
        return Err(RISKY_MESSAGE.into());
    }
    app.opener()
        .open_path(real.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    let real = confine(Path::new(&path), &attachment_roots(&app))?;
    app.opener()
        .reveal_item_in_dir(real)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("  .hidden "), "hidden");
        assert_eq!(safe_name(""), "attachment");
        assert_eq!(safe_name("Q3 Budget: final.xlsx"), "Q3 Budget_ final.xlsx");
    }

    #[test]
    fn strips_bidi_and_invisible_characters() {
        assert_eq!(
            safe_name("invoice\u{202E}fdp.command"),
            "invoice_fdp.command"
        );
        assert_eq!(
            safe_name("a\u{200B}b\u{2066}c\u{061C}d\u{FEFF}.pdf"),
            "a_b_c_d_.pdf"
        );
        assert_eq!(safe_name("Résumé 2026.pdf"), "Résumé 2026.pdf");
    }

    #[test]
    fn flags_risky_types() {
        for name in [
            "run.command",
            "x.APP",
            "install.sh",
            "a.bash",
            "a.zsh",
            "a.csh",
            "a.tool",
            "a.terminal",
            "a.workflow",
            "a.scpt",
            "a.scptd",
            "a.applescript",
            "a.pkg",
            "a.mpkg",
            "a.dmg",
            "a.jar",
            "a.webloc",
            "a.inetloc",
            "a.fileloc",
            "a.url",
            "Thing.app.zip",
            "Thing.app (2).zip",
        ] {
            assert!(risky(name), "{name} should be risky");
        }
        for name in [
            "report.pdf",
            "photos.zip",
            "a (2).zip",
            "notes.txt",
            "command",
            "shapp",
            "budget.xlsx",
        ] {
            assert!(!risky(name), "{name} should be safe");
        }
    }

    #[test]
    fn confines_paths_to_roots() {
        let base = std::env::temp_dir().join(format!("zmail-confine-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.pdf"), b"x").unwrap();
        std::fs::write(outside.join("b.pdf"), b"x").unwrap();
        let roots = vec![root.clone(), base.join("missing")];

        assert_eq!(
            confine(&root.join("a.pdf"), &roots).unwrap(),
            root.join("a.pdf").canonicalize().unwrap()
        );
        assert!(confine(&outside.join("b.pdf"), &roots).is_err());
        // `..` can't climb out once canonicalized.
        assert!(confine(&root.join("../outside/b.pdf"), &roots).is_err());
        assert!(confine(&root.join("nope.pdf"), &roots).is_err());
        assert!(confine(Path::new("/etc/hosts"), &roots).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("b.pdf"), root.join("link.pdf")).unwrap();
            assert!(confine(&root.join("link.pdf"), &roots).is_err());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn only_word_like_files_are_extractable() {
        assert!(extractable("Report.DOCX"));
        assert!(extractable("a.rtf"));
        assert!(!extractable("x.pdf"));
        assert!(!extractable("docx"));
        assert_eq!(safe_name("../../a.docx"), "_.._a.docx");
        assert!(extractable(&safe_name("../../a.docx")));
    }

    #[test]
    fn concurrent_same_name_saves_get_their_own_files() {
        let dir = std::env::temp_dir().join(format!("zmail-race-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = 16;
        let start = std::sync::Arc::new(std::sync::Barrier::new(n));
        // All started before any is joined: they wait for each other at the barrier.
        let mut saves = Vec::new();
        for i in 0..n {
            let (dir, start) = (dir.clone(), start.clone());
            saves.push(std::thread::spawn(move || {
                let bytes = vec![i as u8; 64 * 1024];
                start.wait();
                (write_new(&dir, "a.pdf", &bytes).unwrap(), bytes)
            }));
        }
        let saved: Vec<_> = saves.into_iter().map(|t| t.join().unwrap()).collect();
        let paths: std::collections::HashSet<_> = saved.iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(paths.len(), n, "each save needs its own file");
        for (path, bytes) in &saved {
            assert_eq!(&std::fs::read(path).unwrap(), bytes, "{}", path.display());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_at_the_name_is_not_followed() {
        let base = std::env::temp_dir().join(format!("zmail-link-{}", std::process::id()));
        let dir = base.join("dir");
        std::fs::create_dir_all(&dir).unwrap();
        let target = base.join("elsewhere.txt");
        std::os::unix::fs::symlink(&target, dir.join("a.pdf")).unwrap();
        let path = write_new(&dir, "a.pdf", b"mail").unwrap();
        assert_eq!(path, dir.join("a (2).pdf"));
        assert_eq!(std::fs::read(&path).unwrap(), b"mail");
        assert!(!target.exists(), "the write went through the symlink");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dedupes_paths() {
        let dir = std::env::temp_dir().join(format!("zmail-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), b"x").unwrap();
        assert_eq!(
            write_new(&dir, "a.pdf", b"y").unwrap(),
            dir.join("a (2).pdf")
        );
        assert_eq!(write_new(&dir, "b.pdf", b"y").unwrap(), dir.join("b.pdf"));
        assert_eq!(write_new(&dir, "README", b"y").unwrap(), dir.join("README"));
        assert_eq!(
            write_new(&dir, "README", b"y").unwrap(),
            dir.join("README (2)")
        );
        assert_eq!(std::fs::read(dir.join("a.pdf")).unwrap(), b"x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn each_extraction_gets_its_own_directory() {
        let parent =
            std::env::temp_dir().join(format!("zmail-extract-test-{}", std::process::id()));
        let (a, b) = (private_dir(&parent).unwrap(), private_dir(&parent).unwrap());
        assert_ne!(a, b);
        assert!(a.is_dir() && b.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&a).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir_all(&parent).unwrap();
    }
}

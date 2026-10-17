//! Relaunching after an update.
//!
//! Tauri's restart opens the app with `open -n` while this copy is still running, so for a
//! moment there are two, and the Dock gives the second its own icon beside the pinned one. Here
//! a small helper waits until this copy has quit and then opens the bundle normally, the way
//! the user would, so the new version comes up in the pinned icon.

use std::path::{Path, PathBuf};

/// Longest the helper waits for this copy to quit before opening the bundle anyway.
const WAIT_TENTHS: u32 = 300;

/// The `.app` bundle an executable at `Foo.app/Contents/MacOS/foo` belongs to.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |p: &Path, name: &str| p.file_name().is_some_and(|n| n == name);
    let is_app = bundle.extension().is_some_and(|e| e == "app");
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| bundle.to_path_buf())
}

/// Quits zMail and opens it again once it has quit. Errors (and keeps running) when the helper
/// can't be started, so the user is never left with zMail closed and nothing reopening it.
#[tauri::command]
pub fn relaunch(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = bundle_of(&exe).ok_or("zMail isn't running from an app bundle.")?;
        // The pid and path go in as arguments, never into the script text.
        Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"i=0; while /bin/kill -0 "$1" 2>/dev/null && [ "$i" -lt "$3" ]; do /bin/sleep 0.1; i=$((i+1)); done; exec /usr/bin/open "$2""#)
            .arg("zmail-relaunch")
            .arg(std::process::id().to_string())
            .arg(&bundle)
            .arg(WAIT_TENTHS.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Its own process group, so it outlives this copy quitting.
            .process_group(0)
            .spawn()
            .map_err(|e| format!("Couldn't start the relaunch: {e}"))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::bundle_of;
    use std::path::Path;

    #[test]
    fn finds_the_bundle_of_an_app_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/zMail.app/Contents/MacOS/zmail")).as_deref(),
            Some(Path::new("/Applications/zMail.app"))
        );
    }

    #[test]
    fn a_bare_executable_has_no_bundle() {
        assert_eq!(bundle_of(Path::new("/Users/jane/zmail/target/debug/zmail")), None);
        assert_eq!(bundle_of(Path::new("/tmp/Contents/MacOS/zmail")), None);
    }
}

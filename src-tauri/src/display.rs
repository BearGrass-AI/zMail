//! macOS display settings the web view can't see on its own.
//!
//! WebKit answers `prefers-contrast` and `prefers-reduced-motion` from System Settings, but it
//! doesn't implement `prefers-reduced-transparency`, so the page asks here for Accessibility ›
//! Display › Reduce transparency.

/// True when the user turned on Reduce transparency.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn reduce_transparency() -> bool {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};

    let Some(class) = AnyClass::get(c"NSWorkspace") else {
        return false;
    };
    // SAFETY: +[NSWorkspace sharedWorkspace] takes no arguments and returns the shared
    // workspace object (autoreleased, so msg_send! retains it for us).
    let workspace: Option<Retained<AnyObject>> = unsafe { msg_send![class, sharedWorkspace] };
    let Some(workspace) = workspace else {
        return false;
    };
    // SAFETY: accessibilityDisplayShouldReduceTransparency is a read-only BOOL property of
    // NSWorkspace (macOS 10.10+) that takes no arguments.
    unsafe { msg_send![&*workspace, accessibilityDisplayShouldReduceTransparency] }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn reduce_transparency() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_transparency_reads_the_setting_without_failing() {
        // The answer depends on this Mac's settings; reading it must work and be stable.
        #[cfg(target_os = "macos")]
        assert!(objc2::runtime::AnyClass::get(c"NSWorkspace").is_some(), "AppKit isn't loaded");
        let first = reduce_transparency();
        assert_eq!(first, reduce_transparency());
    }
}

/// The full name of the Mac's user account ("Jane Appleseed"), which zMail greets you by.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn full_user_name() -> String {
    objc2_foundation::NSFullUserName().to_string()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn full_user_name() -> String {
    String::new()
}

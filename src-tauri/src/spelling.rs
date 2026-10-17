//! Spell checking while typing in the web view (composer body, subject, every text field).
//!
//! WKWebView underlines misspellings only when the app's `WebContinuousSpellCheckingEnabled`
//! default is on: WebKit's TextCheckerMac reads it, and Safari turns it on for itself, but
//! other apps start with it off. It's *registered* rather than set, so it sits under anything
//! the user chooses later (the Spelling and Grammar items in a text field's context menu).
//! Autocorrect (`WebAutomaticSpellingCorrectionEnabled`) is left unset on purpose: WebKit then
//! follows System Settings › Keyboard › "Correct spelling automatically".

/// The WebKit default that turns on spell checking while typing.
#[cfg(target_os = "macos")]
const CONTINUOUS_SPELL_CHECKING: &str = "WebContinuousSpellCheckingEnabled";

/// Turn spell checking on by default. Call before the first web view is created.
#[cfg(target_os = "macos")]
pub fn enable() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let key = NSString::from_str(CONTINUOUS_SPELL_CHECKING);
    let on = NSNumber::new_bool(true);
    let value: &AnyObject = &on;
    let defaults = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value]);
    // SAFETY: registerDefaults requires property-list keys and values; this dictionary holds
    // one NSString key and one NSNumber value, both property-list types.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

#[cfg(not(target_os = "macos"))]
pub fn enable() {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2_foundation::{NSString, NSUserDefaults};

    #[test]
    fn enable_turns_on_spell_checking_while_typing() {
        // Registered defaults live only in this process, so the test leaves nothing behind.
        enable();
        let key = NSString::from_str(CONTINUOUS_SPELL_CHECKING);
        assert!(NSUserDefaults::standardUserDefaults().boolForKey(&key));
    }
}

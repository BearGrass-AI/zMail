# Contributing to zMail

Thanks for taking a look. zMail is a personal project that I use every day, so I'm happy to get bug reports and fixes. For bigger features, open an issue first so we can talk about whether it fits before you spend time on it.

## Reporting a bug

Open an issue with what you did, what you expected and what happened instead. A screenshot helps a lot for anything visual. Please leave real email content out of screenshots and logs.

If it's a security problem (anything that could leak mail, tokens or keys), don't open a public issue. Use GitHub's **Report a vulnerability** button on the Security tab instead, which keeps it private.

## Getting set up

You need macOS 26 or later on Apple silicon, Node with pnpm, a Rust toolchain and Xcode's command line tools.

```sh
pnpm install
pnpm tauri dev   # the app
pnpm dev         # just the UI, in a browser, on the demo mailbox
```

You don't need real accounts or AI keys to work on most things. Without them zMail runs on a built-in demo mailbox and mock models.

## Before you open a pull request

Run the whole check and make sure it passes:

```sh
pnpm verify
```

That's the TypeScript typecheck, ESLint, the Vitest suite, `cargo test` and `cargo clippy` with warnings as errors.

A few house rules:

- **Add a test** for any fix or feature. Look at the tests in `src/lib/__tests__/` for the style.
- **Lint warnings only go down.** `pnpm lint` has a warning cap; never raise it.
- **Rust:** no `unwrap()` or `expect()` outside tests, `#[expect(..., reason = "...")]` instead of `#[allow]`, and a `// SAFETY:` comment on every `unsafe` block.
- **Untrusted input gets checked.** Mail, server responses and anything from the webview can be malformed or hostile. Validate it, and keep anything zMail saves bounded.
- **Report success only after it happened.** A toast that says "Saved" or "Sent" should come after the write or the send actually worked.
- **Secrets stay in the Keychain.** API keys and tokens never go into settings, the database, logs or the repo.
- **No real people in test data.** Use example.com and example.org addresses and made-up names.
- **Match what's around you.** Follow the style, naming and comment density of the file you're in.

Keep pull requests focused on one thing. Write the commit message as a sentence or two about what changed for someone using zMail, not just which files moved.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

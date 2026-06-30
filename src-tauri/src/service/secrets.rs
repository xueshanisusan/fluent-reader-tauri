//! OS-keychain storage for sync-service bearer credentials.
//!
//! The Fever `api_key` is `md5(username:password)` — a bearer token equal in
//! sensitivity to the password itself, so it lives in the OS keychain (Windows
//! Credential Manager / macOS Keychain / Linux Secret Service) rather than the
//! plaintext settings store. Only one sync service is configured at a time, so
//! a single fixed slot suffices.
//!
//! TODO(fever-sync PR1+): on headless Linux without a Secret Service, `keyring`
//! errors; add a plaintext-store fallback with a user-facing warning there.

use keyring::Entry;

const SERVICE: &str = "fluent-reader-tauri";
const FEVER_ACCOUNT: &str = "fever-api-key";

fn entry() -> keyring::Result<Entry> {
    Entry::new(SERVICE, FEVER_ACCOUNT)
}

pub fn store_fever_api_key(api_key: &str) -> keyring::Result<()> {
    entry()?.set_password(api_key)
}

pub fn load_fever_api_key() -> keyring::Result<String> {
    entry()?.get_password()
}

pub fn delete_fever_api_key() -> keyring::Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

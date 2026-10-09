//! Content hashing for documents (`spec/spec.md` §4.6): `sha256(raw)` over the
//! exact string stored in the artifact, trailing newline included.
//! Port of `packages/core/src/hash.ts`.

use sha2::{Digest, Sha256};

/// `sha256` of `raw`, lowercase hex. The single hashing site in the compiler.
pub fn hash_document(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// `sha256` of arbitrary bytes, lowercase hex (the schema hash uses the same shape).
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_empty_is_known() {
        assert_eq!(hash_document(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}

//! The acceptance test in Rust: the compiler reproduces the frozen TypeScript tree
//! byte for byte and its diagnostics exactly, on the PoC fixture project (the seven
//! documents of `research/pokedex-example-spec.md` C).
//!
//! The expectation is `tests/fixtures/frozen/parity_poc.json`, one verbatim run of
//! the TypeScript compiler over the fixture, captured before `packages/core/src` was
//! deleted. The compiler under test is the Rust port.

mod support;

use support::{assert_frozen, fixture, frozen};

#[test]
fn poc_tree_and_diagnostics_match_the_frozen_expectation() {
    let snapshot = frozen("parity_poc");
    let (tree, diagnostics) = assert_frozen(&fixture("poc"), &[], &snapshot["poc"]);
    assert_eq!(tree.len(), 16, "the PoC tree has 16 files");
    assert_eq!(diagnostics.len(), 1, "the PoC project reports one warning");
}

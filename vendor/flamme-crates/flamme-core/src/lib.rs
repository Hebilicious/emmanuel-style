//! The Flamme compiler, in Rust.
//!
//! [`compile`] takes a [`CompileRequest`] carrying the resolved config, the SDL and
//! every discovered source file with its text; [`compile_project`] takes the same
//! request without the file list and walks, stats and reads the project itself
//! ([`session`]). Both return the tree the run has to land plus the diagnostics, the
//! artifact metadata and the cache state the next run continues from. Reading is all
//! the crate does to the filesystem; the TypeScript side keeps everything that is
//! orchestration (config loading, the plugin host, the atomic writer with its
//! rollback and tombstones, and route planning), and `packages/core` keeps the
//! TypeScript compiler as the parity oracle.

pub mod companion;
pub mod config;
pub mod contract;
pub mod depth;
pub mod diagnostics;
pub mod emit;
pub mod extract;
pub mod generate;
pub mod glob;
pub mod graphql;
pub mod hash;
pub mod ir;
pub mod js;
pub mod naming;
pub mod offsets;
pub mod page_module;
pub mod paginate;
pub mod persisted;
pub mod props;
pub mod request;
pub mod schema;
pub mod session;
pub mod sfc;
pub mod validate;

pub use config::RustConfig;
pub use contract::{ArtifactKind, CachePolicy, GraphQLValue, IrDocument};
pub use diagnostics::{Diagnostic, Severity, SourceLocation};
pub use generate::{compile, compile_project};
pub use request::{
    CompileOptions, CompileRequest, CompileResponse, CompiledArtifact, ExtractedDocument,
    OutFile, SchemaInput,
};
pub use session::{SessionCache, SessionOutcome, SessionRequest, compile_session};

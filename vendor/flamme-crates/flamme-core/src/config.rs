//! The resolved compiler config the native entry point receives.
//!
//! Config-file loading is orchestration and stays in TypeScript (`loadConfig` reads
//! a `.ts` config through the Node loader and runs the `config` plugin hooks); the
//! resolved object crosses the boundary as JSON and is deserialized here. Only the
//! fields the pipeline reads are declared, and every one of them is required
//! because `ResolvedConfig` has no `undefined` left after resolution.

use serde::{Deserialize, Serialize};

use crate::contract::CachePolicy;
use crate::js::{JsObject, de_object};
use crate::offsets::to_posix;

/// Custom scalar mapping.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScalarConfig {
    /// TypeScript type of a parsed value.
    #[serde(rename = "type", default)]
    pub type_name: Option<String>,
    /// Module to import the type from.
    #[serde(default)]
    pub module: Option<String>,
    /// Import as a default export.
    #[serde(default)]
    pub default: Option<bool>,
}

/// Per-type cache-key configuration.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TypeConfig {
    /// Fields that make up the record id, in order.
    #[serde(default)]
    pub keys: Option<Vec<String>>,
}

/// Filesystem routing conventions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingConfig {
    /// Directory that holds the pages, relative to `projectDir`.
    #[serde(default = "default_pages_dir")]
    pub pages_dir: String,
    /// The colocated page document file name.
    #[serde(default = "default_page_document_file")]
    pub document_file: String,
    /// The colocated layout document file name.
    #[serde(default = "default_layout_document_file")]
    pub layout_document_file: String,
    /// Which surface a page's query comes from when it declares more than one.
    #[serde(default = "default_document_surface")]
    pub document: String,
    /// Every extension the compiler treats as a document (`.gql`, `.graphql`).
    #[serde(default = "default_document_extensions")]
    pub document_extensions: Vec<String>,
    /// Per-route param renames, keyed by the route's path pattern.
    #[serde(default)]
    pub params: JsObject<JsObject<String>>,
}

fn default_pages_dir() -> String {
    "src/pages".into()
}
fn default_page_document_file() -> String {
    "+page.gql".into()
}
fn default_layout_document_file() -> String {
    "+layout.gql".into()
}
fn default_document_surface() -> String {
    "auto".into()
}
/// The extensions a project gets without configuring any (`DEFAULT_DOCUMENT_EXTENSIONS`).
pub fn default_document_extensions() -> Vec<String> {
    vec![".gql".into(), ".graphql".into()]
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            pages_dir: default_pages_dir(),
            document_file: default_page_document_file(),
            layout_document_file: default_layout_document_file(),
            document: default_document_surface(),
            document_extensions: default_document_extensions(),
            params: JsObject::new(),
        }
    }
}

/// One extension in its canonical spelling: lowercased and dotted (`gql` -> `.gql`).
fn normalize_document_extension(value: &str) -> Option<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    let dotted = if trimmed.starts_with('.') { trimmed } else { format!(".{trimmed}") };
    let rest = dotted.strip_prefix('.')?;
    if rest.is_empty() || !rest.chars().all(|character| character.is_ascii_alphanumeric()) {
        return None;
    }
    Some(dotted)
}

impl RoutingConfig {
    /// Every document extension in effect, canonical, de-duplicated and in order.
    ///
    /// This mirrors `documentExtensionsOf` in `packages/core/src/config.ts`: an absent or unusable
    /// list is the default pair, because a project with no document extension has no documents at
    /// all, and the TypeScript resolver rejects that before it reaches the native side.
    pub fn document_extensions(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for value in &self.document_extensions {
            if let Some(extension) = normalize_document_extension(value) {
                if !out.contains(&extension) {
                    out.push(extension);
                }
            }
        }
        if out.is_empty() {
            return default_document_extensions();
        }
        out
    }

    /// The document file names one routing role accepts, in the order they are tried.
    ///
    /// `document_file` supplies the stem and each configured extension one name (`+page.gql` ->
    /// `+page.gql`, `+page.graphql`); mirrors `documentFileNames` in `packages/core/src/config.ts`.
    pub fn document_file_names(&self, role: &str) -> Vec<String> {
        let value = if role == "page" { &self.document_file } else { &self.layout_document_file };
        let fallback =
            if role == "page" { DEFAULT_PAGE_DOCUMENT_FILE } else { DEFAULT_LAYOUT_DOCUMENT_FILE };
        let name = if value.is_empty() || value.contains('/') { fallback } else { value.as_str() };
        let stem = match name.rfind('.') {
            Some(at) if at > 0 => &name[..at],
            _ => name,
        };
        self.document_extensions().iter().map(|extension| format!("{stem}{extension}")).collect()
    }

    /// `true` when `path`'s extension is one of the configured document extensions.
    pub fn has_document_extension(&self, path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        self.document_extensions().iter().any(|extension| lower.ends_with(extension))
    }
}

/// The default colocated page document file name (`page_module.rs` keeps the public spellings).
const DEFAULT_PAGE_DOCUMENT_FILE: &str = "+page.gql";
/// The default colocated layout document file name.
const DEFAULT_LAYOUT_DOCUMENT_FILE: &str = "+layout.gql";

/// The resolved config, mirroring `ResolvedConfig` (`packages/core/src/config.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustConfig {
    /// Absolute project root.
    pub project_dir: String,
    /// Absolute generated directory.
    pub runtime_dir: String,
    /// Discovery globs.
    pub include: Vec<String>,
    /// Exclusion globs.
    pub exclude: Vec<String>,
    /// Custom scalar mapping.
    #[serde(default, deserialize_with = "de_object")]
    pub scalars: JsObject<ScalarConfig>,
    /// Per-type key configuration.
    #[serde(default, deserialize_with = "de_object")]
    pub types: JsObject<TypeConfig>,
    /// Fallback key fields for every type.
    pub default_keys: Vec<String>,
    /// Cache policy baked into every query artifact.
    pub default_cache_policy: CachePolicy,
    /// `partial` baked into every query artifact.
    pub default_partial: bool,
    /// `mode` for a bare `@paginate` (`Infinite`, Houdini's default).
    pub default_paginate_mode: String,
    /// Position of a generated list insert without `@prepend`/`@append`.
    pub default_list_position: String,
    /// Target of a generated list operation without `@listTarget`.
    pub default_list_target: String,
    /// Project-wide fragment masking default.
    pub default_fragment_masking: String,
    /// Verbosity of the compiler's own reporting.
    pub log_level: String,
    /// Filesystem routing conventions.
    #[serde(default)]
    pub routing: RoutingConfig,
}

impl RustConfig {
    /// The runtime directory relative to the project root, for display.
    pub fn runtime_dir_name(&self) -> String {
        let runtime = to_posix(&self.runtime_dir);
        let project = to_posix(&self.project_dir);
        match runtime.strip_prefix(&format!("{project}/")) {
            Some(relative) => relative.to_string(),
            None => runtime,
        }
    }
}

impl Default for RustConfig {
    fn default() -> Self {
        Self {
            project_dir: String::new(),
            runtime_dir: String::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            scalars: JsObject::new(),
            types: JsObject::new(),
            default_keys: vec!["id".into()],
            default_cache_policy: CachePolicy::CacheOrNetwork,
            default_partial: false,
            default_paginate_mode: "Infinite".into(),
            // The resolved defaults (`packages/core/src/config.ts:352-357`): a test that builds a
            // `RustConfig::default()` must see the config a project's `resolveConfig` produces, or
            // an assertion about a defaulted position/target pins a config no project can have
            // (`review-f5f`).
            default_list_position: "last".into(),
            default_list_target: "single".into(),
            default_fragment_masking: "enable".into(),
            log_level: "info".into(),
            routing: RoutingConfig::default(),
        }
    }
}

/// True when `path` (project-relative posix) is discovered by `config.include` and
/// not by `config.exclude`. Port of `isIncluded` in `extract.ts`: `resolveConfig`
/// has already substituted `<runtimeDir>` in the exclude globs.
pub fn is_included(config: &RustConfig, path: &str) -> bool {
    crate::glob::matches_any(&config.include, path) && !crate::glob::matches_any(&config.exclude, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_extensions_default_to_both_spellings() {
        let routing = RoutingConfig::default();
        assert_eq!(routing.document_extensions(), vec![".gql".to_string(), ".graphql".to_string()]);
        assert_eq!(
            routing.document_file_names("page"),
            vec!["+page.gql".to_string(), "+page.graphql".to_string()]
        );
        assert_eq!(
            routing.document_file_names("layout"),
            vec!["+layout.gql".to_string(), "+layout.graphql".to_string()]
        );
        assert!(routing.has_document_extension("src/pages/index/+page.graphql"));
        assert!(!routing.has_document_extension("src/pages/index/+page.vue"));
    }

    #[test]
    fn document_extensions_normalize_and_narrow() {
        let routing = RoutingConfig {
            document_extensions: vec!["GQL".into(), ".graphql".into(), "graphql".into()],
            ..RoutingConfig::default()
        };
        // lowercased, dotted, de-duplicated
        assert_eq!(routing.document_extensions(), vec![".gql".to_string(), ".graphql".to_string()]);

        let narrowed = RoutingConfig {
            document_extensions: vec![".gql".into()],
            ..RoutingConfig::default()
        };
        assert_eq!(narrowed.document_file_names("page"), vec!["+page.gql".to_string()]);
        assert!(!narrowed.has_document_extension("src/pages/index/+page.graphql"));

        // a document file whose own extension is not configured still contributes its stem
        let custom = RoutingConfig {
            document_file: "query.gql".into(),
            document_extensions: vec![".graphqls".into()],
            ..RoutingConfig::default()
        };
        assert_eq!(custom.document_file_names("page"), vec!["query.graphqls".to_string()]);
    }

    #[test]
    fn an_unusable_extension_list_falls_back_to_the_default_pair() {
        // the TypeScript resolver rejects an empty list; the native side never sees "no documents",
        // because a project with no document extension has no documents at all
        let routing = RoutingConfig {
            document_extensions: vec!["not an extension".into(), String::new()],
            ..RoutingConfig::default()
        };
        assert_eq!(routing.document_extensions(), default_document_extensions());
    }

    #[test]
    fn a_routing_config_without_the_field_deserializes_to_the_default_pair() {
        // the shape an older config file (or an older compiler's resolved config) produces
        let routing: RoutingConfig =
            serde_json::from_str(r#"{"pagesDir":"src/pages","documentFile":"+page.gql"}"#)
                .expect("routing deserializes");
        assert_eq!(routing.document_extensions(), default_document_extensions());
    }
}

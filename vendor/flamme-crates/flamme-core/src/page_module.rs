//! The `+page.ts`/`+layout.ts` page-module convention.
//! Port of `packages/core/src/page-module.ts`.
//!
//! OWNER: the extraction port.

use crate::config::RustConfig;
use crate::diagnostics::{Diagnostic, DiagnosticInput, create_diagnostic};
use crate::extract::{RawDocument, ScanBinding, document_name_of, scan_code};
use crate::offsets::{location_at, to_posix};

/// The page-query module file name.
pub const PAGE_MODULE_FILE: &str = "+page.ts";
/// The layout-query module file name.
pub const LAYOUT_MODULE_FILE: &str = "+layout.ts";
/// The default colocated page document file name.
pub const DEFAULT_PAGE_DOCUMENT_FILE: &str = "+page.gql";
/// The default colocated layout document file name.
pub const DEFAULT_LAYOUT_DOCUMENT_FILE: &str = "+layout.gql";
/// The export a page module declares its query with.
pub const PAGE_EXPORT_NAME: &str = "Page";

/// Extensions an import specifier may resolve to, in the order they are tried.
const MODULE_EXTENSIONS: [&str; 10] =
    [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".gql", ".graphql"];

/// Resolution depth limit for alias chains and re-exports.
const MAX_DEPTH: usize = 8;

/// Which routing role a file name has, or `None` when it is not a page module.
pub fn page_module_role(relative_path: &str) -> Option<&'static str> {
    let file = relative_path.rsplit('/').next().unwrap_or(relative_path);
    match file {
        PAGE_MODULE_FILE => Some("page"),
        LAYOUT_MODULE_FILE => Some("layout"),
        _ => None,
    }
}

/// The routing pages prefix, as a project-relative posix path.
pub fn routing_pages_prefix(config: &RustConfig) -> String {
    let value = config.routing.pages_dir.as_str();
    let directory = if value.is_empty() {
        "src/pages".to_string()
    } else {
        let posix = to_posix(value);
        let without_dot = posix.strip_prefix("./").map(str::to_string).unwrap_or(posix);
        without_dot.trim_end_matches('/').to_string()
    };
    if directory.is_empty() || directory.starts_with('/') || directory.starts_with("..") {
        return "src/pages/".to_string();
    }
    format!("{directory}/")
}

/// The document name a routing role's own module declares.
pub fn routing_document_name(config: &RustConfig, role: &str) -> String {
    let value = if role == "page" {
        config.routing.document_file.as_str()
    } else {
        config.routing.layout_document_file.as_str()
    };
    let fallback = if role == "page" { DEFAULT_PAGE_DOCUMENT_FILE } else { DEFAULT_LAYOUT_DOCUMENT_FILE };
    if value.is_empty() || value.contains('/') {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

/// The document a raw page-module resolution produced.
///
/// The routing layer's view of one page module: the document the module declares
/// in its own file, as an index into `documents`. A module whose `Page` comes from
/// an import, and a module with no document of its own, both answer `None`; the
/// compiler resolves those through [`resolve_page_module_source`] instead.
pub fn resolve_page_module_document(
    relative_path: &str,
    documents: &[RawDocument],
) -> Option<usize> {
    documents.iter().position(|document| document.relative_path == relative_path)
}

/// A resolution attempt over one binding, with the reason it failed.
struct Attempt {
    /// The index of the resolved document, when one resolved.
    document: Option<usize>,
    /// Why the attempt failed, for the FLM1029 detail.
    detail: String,
}

impl Attempt {
    fn failure(detail: impl Into<String>) -> Self {
        Self { document: None, detail: detail.into() }
    }
}

/// Resolves the `Page` export of one page module to a document index.
///
/// `source` is the module's text, `file` its absolute path and `relative_path` its
/// project-relative posix path; `documents` is the extraction result, so the
/// compiler and the route generator can never disagree about which document a page
/// runs. `document_extensions` is the project's `routing.documentExtensions`: an
/// extensionless specifier has to be probed with the extensions the project declared,
/// not only the built-in pair. The returned diagnostic is FLM1028 or FLM1029 when
/// `Page` does not resolve, and `None` when the module does not parse (the scan's
/// FLM1011 is the actionable diagnostic).
pub(crate) fn resolve_page_module_source(
    source: &str,
    file: &str,
    relative_path: &str,
    documents: &[RawDocument],
    document_extensions: &[String],
) -> crate::extract::PageModuleResolution {
    use crate::diagnostics::Severity;

    let text = crate::offsets::SourceText::new(source);
    let scanned = scan_code(source, file, relative_path, 0, &text, "ts");
    if scanned.diagnostics.iter().any(|entry| entry.severity == Severity::Error) {
        return crate::extract::PageModuleResolution::default();
    }
    let Some(exported) = scanned.exports.iter().find(|entry| entry.name == PAGE_EXPORT_NAME) else {
        return crate::extract::PageModuleResolution {
            document: None,
            diagnostic: Some(problem(
                "FLM1028",
                &text,
                relative_path,
                0,
                format!(
                    "\"{relative_path}\" has no \"{PAGE_EXPORT_NAME}\" export; export the page's query as `export const {PAGE_EXPORT_NAME} = graphql`…``, import it from a shared module, or delete the file."
                ),
            )),
        };
    };
    let local = exported.local.clone();
    let offset = exported.offset;
    let mut seen = Vec::new();
    let attempt =
        resolve_binding(&scanned, &local, file, documents, document_extensions, &mut seen, 0);
    if let Some(document) = attempt.document {
        return crate::extract::PageModuleResolution { document: Some(document), diagnostic: None };
    }
    crate::extract::PageModuleResolution {
        document: None,
        diagnostic: Some(problem(
            "FLM1029",
            &text,
            relative_path,
            offset,
            format!(
                "\"{relative_path}\" exports \"{PAGE_EXPORT_NAME}\" but it does not resolve to a document: {}.",
                attempt.detail
            ),
        )),
    }
}

/// Builds one page-module diagnostic at `offset` of the module.
fn problem(
    code: &str,
    source: &crate::offsets::SourceText,
    relative_path: &str,
    offset: u32,
    detail: String,
) -> Diagnostic {
    let where_ = location_at(source, relative_path, offset, 1);
    create_diagnostic(DiagnosticInput::error(
        code,
        format!("{}:{}:{} {detail}", where_.file, where_.line, where_.column),
        where_,
    ))
}

/// Resolves one local binding, following aliases and imports.
fn resolve_binding(
    scanned: &crate::extract::ScanResult,
    name: &str,
    file: &str,
    documents: &[RawDocument],
    document_extensions: &[String],
    seen: &mut Vec<String>,
    depth: usize,
) -> Attempt {
    if depth > MAX_DEPTH || seen.iter().any(|entry| entry == name) {
        return Attempt::failure(format!("\"{name}\" is a cycle"));
    }
    seen.push(name.to_string());
    let Some(binding) = scanned.binding(name) else {
        return Attempt::failure(format!("\"{name}\" is not declared in the module"));
    };
    match binding {
        ScanBinding::Document(index) => {
            let Some(candidate) = scanned.candidates.get(*index) else {
                return Attempt::failure(format!("\"{name}\" names no document"));
            };
            let document_name = document_name_of(&candidate.units, &candidate.text);
            let document = documents
                .iter()
                .position(|entry| entry.name == document_name && entry.file == file)
                .or_else(|| documents.iter().position(|entry| entry.name == document_name));
            match document {
                Some(document) => Attempt { document: Some(document), detail: String::new() },
                None => Attempt::failure(format!(
                    "the graphql`…` tag bound to \"{name}\" declares no document"
                )),
            }
        }
        ScanBinding::Alias(alias) => {
            let alias = alias.clone();
            resolve_binding(
                scanned,
                &alias,
                file,
                documents,
                document_extensions,
                seen,
                depth + 1,
            )
        }
        ScanBinding::Import { specifier, imported, .. } => {
            follow_import(specifier, imported, file, documents, document_extensions)
        }
        ScanBinding::Other => Attempt::failure(format!(
            "\"{name}\" is bound to a value that is not a document"
        )),
    }
}

/// Follows one import specifier to the document it names.
fn follow_import(
    specifier: &str,
    imported: &str,
    file: &str,
    documents: &[RawDocument],
    document_extensions: &[String],
) -> Attempt {
    let candidates = specifier_candidates(file, specifier, document_extensions);
    let in_file: Vec<usize> = documents
        .iter()
        .enumerate()
        .filter(|(_, entry)| candidates.contains(&entry.file))
        .map(|(index, _)| index)
        .collect();
    if in_file.is_empty() {
        return Attempt::failure(format!("\"{specifier}\" declares no document"));
    }
    if in_file.len() == 1 {
        return Attempt { document: in_file.first().copied(), detail: String::new() };
    }
    // The generated spelling of a document export is `<Name>Document`.
    let stem = imported.strip_suffix("Document").unwrap_or(imported);
    let named: Vec<usize> = in_file
        .iter()
        .copied()
        .filter(|index| {
            documents
                .get(*index)
                .is_some_and(|entry| entry.name == imported || entry.name == stem)
        })
        .collect();
    if named.len() == 1 {
        return Attempt { document: named.first().copied(), detail: String::new() };
    }
    Attempt::failure(format!(
        "\"{specifier}\" declares {} documents ({}); import one by name",
        in_file.len(),
        in_file
            .iter()
            .filter_map(|index| documents.get(*index))
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Every absolute path one import specifier may resolve to, most specific first.
///
/// The built-in module extensions come first and the project's document extensions
/// follow, so `./Q` reaches `Q.gqlx` when `routing.documentExtensions` declares it.
fn specifier_candidates(
    file: &str,
    specifier: &str,
    document_extensions: &[String],
) -> Vec<String> {
    if specifier.is_empty() {
        return Vec::new();
    }
    if !specifier.starts_with('.') && !specifier.starts_with('/') {
        // A package specifier is not a project document.
        return Vec::new();
    }
    let base = if specifier.starts_with('/') {
        specifier.to_string()
    } else {
        crate::extract::resolve_path(&crate::extract::dirname(file), specifier)
    };
    let extension = crate::extract::extname(&base);
    let stem =
        if extension.is_empty() { base.clone() } else { base[..base.len() - extension.len()].to_string() };
    let mut out = vec![base];
    for candidate in MODULE_EXTENSIONS
        .iter()
        .copied()
        .chain(document_extensions.iter().map(String::as_str))
    {
        let path = format!("{stem}{candidate}");
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The project extensions of a `.gqlx` project, as `resolveConfig` canonicalizes them.
    fn gqlx() -> Vec<String> {
        vec![".gql".into(), ".graphql".into(), ".gqlx".into()]
    }

    #[test]
    fn an_extensionless_specifier_probes_the_configured_document_extensions() {
        let candidates = specifier_candidates("/p/src/pages/index/+page.ts", "./Q", &gqlx());
        assert!(candidates.contains(&"/p/src/pages/index/Q.gqlx".to_string()), "{candidates:?}");
        // The built-in module extensions are still probed, and the written path first.
        assert_eq!(candidates.first().map(String::as_str), Some("/p/src/pages/index/Q"));
        assert!(candidates.contains(&"/p/src/pages/index/Q.ts".to_string()));
        assert!(candidates.contains(&"/p/src/pages/index/Q.gql".to_string()));
    }

    #[test]
    fn only_the_project_extensions_are_added() {
        let candidates = specifier_candidates("/p/src/pages/a/+page.ts", "./Q", &[".gqlx".into()]);
        assert!(candidates.contains(&"/p/src/pages/a/Q.gqlx".to_string()));
        // `.gql` is not configured, so it is only there because the module list has it.
        assert_eq!(candidates.iter().filter(|entry| entry.ends_with("Q.gql")).count(), 1);
    }

    #[test]
    fn a_specifier_with_its_own_extension_is_not_re_probed() {
        let candidates = specifier_candidates("/p/src/pages/a/+page.ts", "./Q.gqlx", &gqlx());
        assert_eq!(candidates.first().map(String::as_str), Some("/p/src/pages/a/Q.gqlx"));
        // The written path, the ten module extensions, and `.gqlx`: `.gql` and
        // `.graphql` are in both lists, so each is probed once.
        assert_eq!(candidates.len(), MODULE_EXTENSIONS.len() + 1, "one base plus every probe");
        assert_eq!(
            candidates.iter().filter(|entry| entry.as_str() == "/p/src/pages/a/Q.gqlx").count(),
            1,
            "the written path is not duplicated by the probe"
        );
    }
}

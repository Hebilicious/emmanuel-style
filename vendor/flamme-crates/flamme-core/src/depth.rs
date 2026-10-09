//! The document depth limit: the one bound that keeps a deeply nested document from
//! overflowing the native stack.
//!
//! Recursion over a document is unavoidable in the parser, the IR, the emitter and
//! `serde_json`, and a stack overflow is not a catchable failure: `catch_unwind` in
//! `crates/flamme-napi` cannot see it, so the process used to die with SIGSEGV on a
//! 700-deep document. The fix is to refuse the document before the recursion starts,
//! at the two points where arbitrary text becomes an arbitrary tree:
//!
//! - [`MAX_PARSE_NESTING`] is the parser's own ceiling. The parser has to descend
//!   before any tree exists to measure, so its bound is lexical: a pre-parse scan of
//!   the source counts `{`, `[` and `(` nesting outside strings and comments. A
//!   source past it is a syntax error, and the parser never recurses into it.
//! - [`MAX_SELECTION_DEPTH`] is the reported limit for a document. It is measured on
//!   the parsed tree by [`document_expansion_depth`], which walks iteratively, and
//!   enforced by the session before `prepare`, `validate`, the IR, emit or the
//!   response serialization can see the document. It is an order of magnitude below
//!   the depth the compiler was observed to survive, so the margin covers a smaller
//!   stack on another platform, and it is far above what a hand-written document
//!   uses (a real query nests a handful of selection sets).
//!
//! The measured depth follows fragment spreads, because the compiler does: the IR
//! inlines every reachable fragment (`ir::inline_fragment`), `transitive_spreads`
//! walks the spread graph, and both recurse once per fragment on the chain. A spread
//! is a sibling of the selections around it, but the expansion is a new stack frame,
//! so a chain of shallow fragments is exactly as deep as the recursion and used to
//! reach the stack overflow this module exists to prevent: 701 documents, each
//! spreading the next, killed the process where 700 nested selection sets report
//! `FLM1049`. [`FragmentExpansion`] therefore measures, in one pass per project, how
//! deep each fragment's own expansion reaches, and
//! [`document_expansion_depth`] adds those to the document's own nesting.
//!
//! Both bounds are on the compiler's own input, never on the schema's shape: a field
//! whose type refers to itself is fine, and only the document's nesting is counted.

use std::collections::HashMap;

use crate::graphql::ast::{Definition, Document, Selection, SelectionSet};

/// The deepest selection-set nesting one document may carry.
///
/// The compiler survived 600 nested selection sets and died between 600 and 700, so
/// 128 keeps a margin of more than four times on the observed budget while staying
/// far above any document written by hand. A document past it is reported as
/// `FLM1049` and dropped, exactly as a document that cannot be parsed is.
pub const MAX_SELECTION_DEPTH: usize = 128;

/// The nesting the parser refuses to descend into, measured lexically.
///
/// The parser must recurse before a tree exists, so it cannot use
/// [`MAX_SELECTION_DEPTH`]; this ceiling only has to be past anything the parser can
/// survive and is checked before the first recursive call, so it is safe on every
/// platform. Measured on a 2 MiB stack: the release parser parses a 2000-deep source
/// and overflows at 4000, a debug build overflows between 600 and 1000, and the
/// native module runs on Node's main thread, whose stack is larger than a test
/// thread's. 1024 is above the 700-deep document this limit was added for and below
/// every measured release limit, so a source that reaches the parser's recursion is
/// one the parser has room for. It is also eight times the reported limit, which
/// leaves room for deeply nested argument values.
pub const MAX_PARSE_NESTING: usize = 1024;

/// The deepest selection-set nesting in `document`, ignoring fragment spreads.
///
/// The operation's (or fragment's) own selection set is depth 1 and every nested set
/// adds one. The walk is iterative, so it is safe on a document of any depth the
/// parser accepted. This is the nesting as written; the depth the compiler's
/// recursion reaches is [`document_expansion_depth`], which follows spreads.
pub fn document_depth(document: &Document) -> usize {
    let mut deepest = 0;
    for definition in &document.definitions {
        let root = match definition {
            Definition::Operation(operation) => &operation.selection_set,
            Definition::Fragment(fragment) => &fragment.selection_set,
            // A type system definition has no selection set, and the extraction rejects
            // the document before this walk sees it.
            Definition::TypeSystem(_) => continue,
        };
        deepest = deepest.max(selection_set_depth(root));
    }
    deepest
}

/// Every fragment's own expansion depth, measured once per project.
///
/// Expansion is what the compiler recurses over: a spread is replaced by the
/// fragment's selection set, and a fragment inside that set is a further recursion.
/// The depth of one fragment is therefore its own nesting plus, for every spread it
/// contains, how far that spread can recurse. A project's fragments are measured
/// together because the answer for one depends on the ones it spreads, and a document
/// only has to look its own spreads up.
///
/// The measurement is exact for an acyclic spread graph, which is the only graph a
/// project can have (a cycle is `FLM1006`). Fragments inside a cycle get an upper
/// bound instead of diverging: the compiler stops recursing when a fragment repeats
/// in the chain (`Context::inlining`), so a path through a cycle visits each of its
/// fragments at most once.
#[derive(Debug, Default)]
pub struct FragmentExpansion {
    /// Fragment name -> the depth its own selection set reaches (root set = 1).
    depths: HashMap<String, usize>,
}

impl FragmentExpansion {
    /// Measures every fragment `(name, selection set)` the project declares.
    ///
    /// A name declared more than once takes the deepest reading of the two, so the
    /// bound never under-estimates whichever definition the compiler inlines (the
    /// duplicates are `FLM1004`, reported after this guard).
    pub fn new<'a>(fragments: impl IntoIterator<Item = (&'a str, &'a SelectionSet)>) -> Self {
        let mut nodes: Vec<SpreadNode> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for (name, selection_set) in fragments {
            let (plain, edges) = spread_edges(selection_set);
            match index.get(name) {
                Some(position) => {
                    let node = &mut nodes[*position];
                    node.plain = node.plain.max(plain);
                    node.edges.extend(edges);
                }
                None => {
                    index.insert(name.to_string(), nodes.len());
                    nodes.push(SpreadNode { name: name.to_string(), plain, edges });
                }
            }
        }
        let depths = expansion_depths(&nodes, &index);
        Self { depths }
    }

    /// The expansion depth of `name`, when the project declares it.
    pub fn depth_of(&self, name: &str) -> Option<usize> {
        self.depths.get(name).copied()
    }
}

/// One fragment's own selection set, as the expansion graph needs it.
struct SpreadNode {
    /// The fragment's name.
    name: String,
    /// The spread-free nesting of the fragment's own selection set, root included.
    plain: usize,
    /// The spreads in that set: the target's name and the depth of the set they sit
    /// in (`{ a { ...X } }` spreads `X` at depth 2).
    edges: Vec<(String, usize)>,
}

/// The deepest recursion the compiler reaches while expanding `document`.
///
/// A field or an inline fragment nests one deeper, exactly as [`document_depth`]
/// measures. A spread of `X` contributes the depth of the set it sits in plus the
/// depth of expanding `X` itself: its own selection set is a new recursion frame, and
/// the fragments it reaches are frames after that. A spread of a fragment the project
/// does not declare contributes nothing, because the compiler inlines nothing for it
/// (`FLM1001` reports the unknown name).
pub fn document_expansion_depth(document: &Document, expansion: &FragmentExpansion) -> usize {
    let mut deepest = 0;
    for definition in &document.definitions {
        let root = match definition {
            Definition::Operation(operation) => &operation.selection_set,
            Definition::Fragment(fragment) => &fragment.selection_set,
            Definition::TypeSystem(_) => continue,
        };
        let mut stack: Vec<(&SelectionSet, usize)> = vec![(root, 1)];
        while let Some((set, depth)) = stack.pop() {
            deepest = deepest.max(depth);
            for selection in &set.selections {
                match selection {
                    Selection::Field(field) => {
                        if let Some(nested) = &field.selection_set {
                            stack.push((nested, depth + 1));
                        }
                    }
                    Selection::InlineFragment(fragment) => {
                        stack.push((&fragment.selection_set, depth + 1));
                    }
                    Selection::FragmentSpread(spread) => {
                        if let Some(inner) = expansion.depth_of(&spread.name.value) {
                            deepest = deepest.max(depth.saturating_add(inner));
                        }
                    }
                }
            }
        }
    }
    deepest
}

/// The spreads of one selection set and the set's own spread-free depth.
fn spread_edges(root: &SelectionSet) -> (usize, Vec<(String, usize)>) {
    let mut plain = 1;
    let mut edges: Vec<(String, usize)> = Vec::new();
    let mut stack: Vec<(&SelectionSet, usize)> = vec![(root, 1)];
    while let Some((set, depth)) = stack.pop() {
        plain = plain.max(depth);
        for selection in &set.selections {
            match selection {
                Selection::Field(field) => {
                    if let Some(nested) = &field.selection_set {
                        stack.push((nested, depth + 1));
                    }
                }
                Selection::InlineFragment(fragment) => {
                    stack.push((&fragment.selection_set, depth + 1));
                }
                Selection::FragmentSpread(spread) => {
                    edges.push((spread.name.value.clone(), depth));
                }
            }
        }
    }
    (plain, edges)
}

/// Every fragment's expansion depth, from the spread graph alone.
///
/// The components come out of Tarjan's algorithm in reverse topological order, so a
/// fragment is measured after every fragment it can reach outside its own component.
/// A component that is a single fragment with no spread back into itself is measured
/// exactly; a component holding a cycle gets an upper bound, because the compiler's
/// `inlining` guard lets a path visit each of its fragments at most once.
fn expansion_depths(nodes: &[SpreadNode], index: &HashMap<String, usize>) -> HashMap<String, usize> {
    let mut depths: Vec<usize> = vec![0; nodes.len()];
    for component in strongly_connected(nodes, index) {
        let cyclic = component.len() > 1
            || component.iter().any(|member| {
                nodes[*member].edges.iter().any(|(target, _)| {
                    index.get(target).is_some_and(|position| component.contains(position))
                })
            });
        let mut plain = 1;
        let mut inside = 1;
        let mut outside = 0;
        for member in &component {
            let node = &nodes[*member];
            plain = plain.max(node.plain);
            for (target, depth) in &node.edges {
                match index.get(target) {
                    Some(position) if component.contains(position) => {
                        inside = inside.max(*depth);
                    }
                    Some(position) => {
                        outside = outside.max(depth.saturating_add(depths[*position]));
                    }
                    // An unknown fragment is not inlined at all.
                    None => {}
                }
            }
        }
        let value = if cyclic {
            // A path through the component visits at most `component.len()` of its
            // fragments, each adding its own nesting and the depth of its spread.
            plain.max(outside).saturating_add(
                component.len().saturating_mul(plain.saturating_add(inside).saturating_add(1)),
            )
        } else {
            plain.max(outside)
        };
        for member in &component {
            depths[*member] = value;
        }
    }
    nodes
        .iter()
        .enumerate()
        .map(|(position, node)| (node.name.clone(), depths[position]))
        .collect()
}

/// The strongly connected components of the spread graph, in reverse topological
/// order (Tarjan's algorithm, walked with an explicit stack so a deep graph cannot
/// overflow the native stack the bound protects).
fn strongly_connected(nodes: &[SpreadNode], index: &HashMap<String, usize>) -> Vec<Vec<usize>> {
    let mut edges: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (position, node) in nodes.iter().enumerate() {
        for (target, _) in &node.edges {
            if let Some(target) = index.get(target) {
                edges[position].push(*target);
            }
        }
    }
    let mut order: Vec<usize> = vec![usize::MAX; nodes.len()];
    let mut low: Vec<usize> = vec![0; nodes.len()];
    let mut on_stack: Vec<bool> = vec![false; nodes.len()];
    let mut stack: Vec<usize> = Vec::new();
    let mut next = 0usize;
    let mut components: Vec<Vec<usize>> = Vec::new();
    for root in 0..nodes.len() {
        if order[root] != usize::MAX {
            continue;
        }
        order[root] = next;
        low[root] = next;
        next += 1;
        stack.push(root);
        on_stack[root] = true;
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some((node, child)) = work.last_mut() {
            let node = *node;
            if *child < edges[node].len() {
                let target = edges[node][*child];
                *child += 1;
                if order[target] == usize::MAX {
                    order[target] = next;
                    low[target] = next;
                    next += 1;
                    stack.push(target);
                    on_stack[target] = true;
                    work.push((target, 0));
                } else if on_stack[target] {
                    low[node] = low[node].min(order[target]);
                }
            } else {
                work.pop();
                if let Some((parent, _)) = work.last() {
                    let parent = *parent;
                    low[parent] = low[parent].min(low[node]);
                }
                if low[node] == order[node] {
                    let mut component = Vec::new();
                    while let Some(member) = stack.pop() {
                        on_stack[member] = false;
                        component.push(member);
                        if member == node {
                            break;
                        }
                    }
                    components.push(component);
                }
            }
        }
    }
    components
}

/// The deepest nesting of one selection set, itself included, walked iteratively.
fn selection_set_depth(root: &SelectionSet) -> usize {
    let mut deepest = 0;
    let mut stack: Vec<(&SelectionSet, usize)> = vec![(root, 1)];
    while let Some((set, depth)) = stack.pop() {
        deepest = deepest.max(depth);
        for selection in &set.selections {
            match selection {
                Selection::Field(field) => {
                    if let Some(nested) = &field.selection_set {
                        stack.push((nested, depth + 1));
                    }
                }
                Selection::InlineFragment(fragment) => {
                    stack.push((&fragment.selection_set, depth + 1));
                }
                Selection::FragmentSpread(_) => {}
            }
        }
    }
    deepest
}

/// The first lexical nesting past `max`, as `(depth, byte offset)`.
///
/// The scan skips comments, strings and block strings, so a brace inside a string
/// literal is not nesting; anything else it meets is structure. It is iterative and
/// allocation free, so it is safe on a source of any size. `None` means the source
/// stays within `max`.
pub fn scan_nesting(source: &str, max: usize) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    let length = bytes.len();
    let mut index = 0usize;
    let mut depth = 0usize;
    while index < length {
        match bytes[index] {
            b'#' => {
                while index < length && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'"' => {
                if bytes.get(index + 1) == Some(&b'"') && bytes.get(index + 2) == Some(&b'"') {
                    // A block string: `\"""` is an escaped terminator, `"""` ends it.
                    index += 3;
                    while index < length {
                        if bytes[index] == b'\\'
                            && bytes.get(index + 1) == Some(&b'"')
                            && bytes.get(index + 2) == Some(&b'"')
                            && bytes.get(index + 3) == Some(&b'"')
                        {
                            index += 4;
                            continue;
                        }
                        if bytes[index] == b'"'
                            && bytes.get(index + 1) == Some(&b'"')
                            && bytes.get(index + 2) == Some(&b'"')
                        {
                            index += 3;
                            break;
                        }
                        index += 1;
                    }
                } else {
                    // A plain string. A newline ends it here; the lexer reports the
                    // unterminated literal with graphql-js's own message.
                    index += 1;
                    while index < length {
                        match bytes[index] {
                            b'\\' => index += 2,
                            b'"' => {
                                index += 1;
                                break;
                            }
                            b'\n' | b'\r' => break,
                            _ => index += 1,
                        }
                    }
                }
            }
            b'{' | b'[' | b'(' => {
                depth += 1;
                if depth > max {
                    return Some((depth, index));
                }
                index += 1;
            }
            b'}' | b']' | b')' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            _ => index += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graphql::parser::parse_document;

    /// A deep document is measured exactly, and the walk is iterative.
    #[test]
    fn the_depth_of_a_document_is_its_deepest_selection_set() {
        let document = parse_document("query Deep { me { friends { id } } }").expect("parses");
        assert_eq!(document_depth(&document), 3);

        // 400 nested selection sets, under the parser's own ceiling: the walk must
        // measure it without recursing, since that is what makes it safe on a
        // document the parser accepted at the ceiling itself. The depth is kept well
        // under the ceiling because a debug build's frames are larger and this test
        // runs on the harness's thread stack.
        let mut body = "id".to_string();
        for _ in 0..400 {
            body = format!("friends {{ {body} }}");
        }
        let deep = parse_document(&format!("query Deep {{ me {{ {body} }} }}")).expect("parses");
        assert_eq!(document_depth(&deep), 402);
    }

    /// The parser refuses a source past its ceiling before it descends, so the guard
    /// is what keeps a pathological document from overflowing the stack.
    #[test]
    fn the_parser_refuses_a_source_past_its_ceiling() {
        let deep = "{".repeat(MAX_PARSE_NESTING + 100);
        let error = parse_document(&deep).expect_err("past the ceiling");
        assert_eq!(
            error.message,
            format!(
                "Syntax Error: the source nests deeper than {} levels; the compiler cannot parse it.",
                MAX_PARSE_NESTING
            )
        );
        // The position is the character that crossed the ceiling, not the source's
        // start: the scan reports as it goes and never builds a tree.
        assert_eq!(error.line, 1);
        assert_eq!(error.column, (MAX_PARSE_NESTING + 1) as u32);
    }

    /// A fragment is its own root: a spread does not add to the spreader's depth.
    #[test]
    fn a_fragment_spread_is_not_a_nesting() {
        let document = parse_document(
            "query Deep { me { ...More } }\nfragment More on User { friends { friends { id } } }",
        )
        .expect("parses");
        // The query nests two sets and the fragment three; the spread is a reference,
        // so the document's depth is the fragment's three, never two plus three.
        assert_eq!(document_depth(&document), 3);
    }

    /// The limit the TypeScript suite pins (`packages/core/test/depth-limit.test.ts`)
    /// and the diagnostics below report.
    #[test]
    fn the_selection_depth_limit_is_the_published_one() {
        assert_eq!(MAX_SELECTION_DEPTH, 128);
    }

    /// A project's fragments, measured once, and the documents they were parsed from.
    fn expansion_of(sources: &[&str]) -> (Vec<Document>, FragmentExpansion) {
        let documents: Vec<Document> =
            sources.iter().map(|source| parse_document(source).expect("parses")).collect();
        let expansion = FragmentExpansion::new(documents.iter().filter_map(|document| {
            match document.definitions.first() {
                Some(Definition::Fragment(fragment)) => {
                    Some((fragment.name.value.as_str(), &fragment.selection_set))
                }
                _ => None,
            }
        }));
        (documents, expansion)
    }

    /// A spread chain is one recursion frame per fragment, so it measures deeper than
    /// the definition it starts from nests.
    #[test]
    fn a_spread_chain_is_as_deep_as_the_recursion_it_causes() {
        let (documents, expansion) = expansion_of(&[
            "query Deep { me { ...More } }",
            "fragment More on User { id ...Next }",
            "fragment Next on User { friends { id } }",
        ]);
        // `More` nests one set and spreads `Next`, which nests two: expanding `More`
        // reaches depth three, and the query's own two sets put the document at five.
        assert_eq!(expansion.depth_of("More"), Some(3));
        assert_eq!(expansion.depth_of("Next"), Some(2));
        assert_eq!(document_expansion_depth(&documents[0], &expansion), 5);
        // The flat measure is what the document is written as: two sets, one spread.
        assert_eq!(document_depth(&documents[0]), 2);
    }

    /// The compiler stops recursing at a fragment it is already inlining, so a cycle
    /// is measured as a finite bound instead of diverging.
    #[test]
    fn a_spread_cycle_is_bounded_and_never_diverges() {
        let (documents, expansion) = expansion_of(&[
            "query Deep { me { ...A } }",
            "fragment A on User { id ...B }",
            "fragment B on User { id ...A }",
        ]);
        let depth = document_expansion_depth(&documents[0], &expansion);
        assert!(
            (3..MAX_SELECTION_DEPTH).contains(&depth),
            "a two-fragment cycle stays under the limit so FLM1006 still reports it, got {depth}"
        );
    }

    /// A long chain is measured at its full length, which is what the session's guard
    /// rejects: the measurement itself must not recurse, since it runs on the hostile
    /// input the guard exists for.
    #[test]
    fn a_long_chain_is_measured_without_recursing() {
        let mut sources: Vec<String> = vec!["query Chain { me { ...F0 } }".to_string()];
        for level in 0..MAX_PARSE_NESTING {
            sources.push(format!("fragment F{level} on User {{ id ...F{} }}", level + 1));
        }
        sources.push(format!("fragment F{MAX_PARSE_NESTING} on User {{ id }}"));
        let borrowed: Vec<&str> = sources.iter().map(String::as_str).collect();
        let (documents, expansion) = expansion_of(&borrowed);
        assert_eq!(expansion.depth_of("F0"), Some(MAX_PARSE_NESTING + 1));
        assert_eq!(
            document_expansion_depth(&documents[0], &expansion),
            MAX_PARSE_NESTING + 3,
            "the operation's own two sets add to the chain"
        );
    }

    /// The scan counts structure and ignores strings and comments.
    #[test]
    fn the_lexical_scan_skips_strings_and_comments() {
        assert_eq!(scan_nesting("{ a }", 4), None);
        assert_eq!(scan_nesting("{ a(b: \"{{{{\") }", 4), None);
        assert_eq!(scan_nesting("{ a(b: \"\"\"{{{{\"\"\") }", 4), None);
        assert_eq!(scan_nesting("# {\n{ a }", 4), None);
        assert_eq!(scan_nesting("{{{{{", 4).map(|(depth, _)| depth), Some(5));
        // The byte offset is the opening character that crossed the limit.
        assert_eq!(scan_nesting("{ {{{", 2), Some((3, 3)));
    }
}


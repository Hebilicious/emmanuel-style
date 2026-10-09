//! `props.ts`: one runtime prop descriptor per fragment document.
//! Port of `packages/core/src/props.ts`.
//!
//! OWNER: the emit port.

use std::collections::HashMap;

use crate::contract::IrDocument;
use crate::emit::GENERATED_BANNER;
use crate::naming::compare_names;

/// One fragment the descriptor module covers.
#[derive(Clone, Debug)]
pub struct FragmentPropSpec {
    /// The fragment name.
    pub name: String,
    /// The GraphQL type the fragment is on.
    pub root_type: String,
}

/// Options for [`emit_props_module`].
#[derive(Clone, Debug, Default)]
pub struct EmitPropsOptions {
    /// The module a fragment's `$key` type is imported from, keyed by fragment name.
    pub artifact_modules: Option<HashMap<String, String>>,
}

/// The prop name a fragment's descriptor is keyed under: the lower-camel of its root type.
pub fn fragment_prop_name(root_type: &str) -> String {
    let mut chars = root_type.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_lowercase(), chars.as_str()),
        None => String::new(),
    }
}

/// The module JSDoc, emitted verbatim.
const MODULE_DOC: &[&str] = &[
    "/**",
    " * Runtime prop descriptors for this project's fragments, and the validators they carry.",
    " *",
    " * A type argument alone cannot carry a runtime validator: the SFC compiler (`@vue/compiler-sfc`, or",
    " * Vize) erases `defineProps<{ species: SpriteInfo$key }>()` without evaluating the type, so the",
    " * compiled component's only check is Vue's inferred `{ type: Object }`. That is a Vue compiler",
    " * property, not a Flamme limitation, and the same call is still type-checked by `vue-tsc`.",
    " *",
    " * These descriptors are the runtime-honest path: `defineProps(SpriteInfoProp)` runs the real",
    " * `validator` on every incoming value, while `Object as PropType<SpriteInfo$key>` keeps the",
    " * vue-tsc checking the type-only form had.",
    " *",
    " * A value validates when it is a non-null object whose ` $fragments` marker holds a",
    " * `{ parent, variables }` reference under the fragment's own name. That accepts a masked value read",
    " * from the cache and a loading frame (a frame keeps its references), and rejects `null`, a plain",
    " * object with the right field names, and a marker for a different fragment.",
    " *",
    " * Two directive cases are deliberate:",
    " *",
    " * - `@when`/`@when_not` on a spread never removes the reference: the read writes the marker whether",
    " *   or not the condition holds, and only the spread's *fields* are conditional. An excluded spread",
    " *   therefore still validates; the child read reports `partial: true` with the fields absent.",
    " * - `@mask_disable` writes no marker at all, because the spread is inlined as the parent's own",
    " *   fields. Such a value does not validate, and the generated `$key` type rejects it too: a child",
    " *   that wants the inlined data takes the parent's own type (`$unmasked`), not a `$key`.",
    " *",
    " * Only each fragment's own marker entry is required. The transitive entries its `$key` also names",
    " * are written by the same read into the same marker object, so re-checking them adds no signal.",
    " *",
    " * Queries get no descriptor: a query result carries no ` $fragments` marker, so a validator could",
    " * only repeat Vue's `Object` check. Spread a fragment in the query and hand the child that `$key`.",
    " */",
];

/// One fragment's validator and descriptor, in the layout the golden files pin.
fn fragment_block(fragment: &FragmentPropSpec) -> Vec<String> {
    let name = &fragment.name;
    let root_type = &fragment.root_type;
    let prop = fragment_prop_name(root_type);
    vec![
        String::new(),
        "/**".into(),
        format!(
            " * The runtime validator behind `{name}Prop`: `true` when `value` carries a real `{name}`"
        ),
        " * reference, meaning a ` $fragments` entry for this fragment that is a `{ parent, variables }`"
            .into(),
        " * reference. Call it directly when a hand-written parent needs the check before handing a value over."
            .into(),
        " */".into(),
        format!("export function is{name}Key(value: unknown): value is {name}$key {{"),
        format!("  return hasFragment(value, '{name}')"),
        "}".into(),
        String::new(),
        "/**".into(),
        format!(
            " * The `{prop}` prop (the root type `{root_type}` of this fragment, lower-camel), ready for"
        ),
        format!(" * `defineProps({name}Prop)`. For a differently named prop use the value form"),
        format!(" * (`defineProps({{ {prop}: {name}Prop.{prop} }})`); for a nullable prop use the type-only"),
        format!(" * `defineProps<{{ {prop}: {name}$key | null }}>()` form."),
        " */".into(),
        format!("export const {name}Prop = {{"),
        format!("  {prop}: {{"),
        format!("    type: Object as PropType<{name}$key>,"),
        "    required: true,".into(),
        format!("    validator: is{name}Key,"),
        "  },".into(),
        "} as const".into(),
    ]
}

/// The `props.ts` module.
pub fn emit_props_module(documents: &[IrDocument], options: &EmitPropsOptions) -> String {
    let sorted = fragment_specs(documents);
    let mut lines: Vec<String> = vec![GENERATED_BANNER.to_string(), String::new()];
    lines.extend(MODULE_DOC.iter().map(|line| (*line).to_string()));
    if sorted.is_empty() {
        lines.push(String::new());
        lines.push("// This project declares no fragments, so there are no prop descriptors to emit.".into());
        return format!("{}\n", lines.join("\n"));
    }

    // One `import type` per artifact module; fragments sharing a module share the line.
    let path_of = |name: &str| -> String {
        options
            .artifact_modules
            .as_ref()
            .and_then(|modules| modules.get(name))
            .cloned()
            .unwrap_or_else(|| format!("./artifacts/{name}"))
    };
    let mut order: Vec<String> = Vec::new();
    let mut modules: HashMap<String, Vec<String>> = HashMap::new();
    for fragment in &sorted {
        let path = path_of(&fragment.name);
        if !modules.contains_key(&path) {
            order.push(path.clone());
        }
        modules.entry(path).or_default().push(format!("{}$key", fragment.name));
    }
    lines.push(String::new());
    lines.push("import type { PropType } from 'vue'".into());
    lines.push(String::new());
    lines.push("import { hasFragment } from '@flamme/runtime'".into());
    for path in &order {
        let mut names = modules.get(path).cloned().unwrap_or_default();
        names.sort_by(|a, b| compare_names(a, b));
        lines.push(format!("import type {{ {} }} from '{}'", names.join(", "), path));
    }
    for fragment in &sorted {
        lines.extend(fragment_block(fragment));
    }
    format!("{}\n", lines.join("\n"))
}

/// The fragment documents, sorted, as the descriptor module lists them.
pub fn fragment_specs(documents: &[IrDocument]) -> Vec<FragmentPropSpec> {
    let mut specs: Vec<FragmentPropSpec> = documents
        .iter()
        .filter(|document| document.kind == crate::contract::ArtifactKind::Fragment)
        .map(|document| FragmentPropSpec {
            name: document.name.clone(),
            root_type: document.root_type.clone(),
        })
        .collect();
    specs.sort_by(|a, b| crate::naming::compare_names(&a.name, &b.name));
    specs
}

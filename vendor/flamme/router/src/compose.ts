/**
 * Composing hand-written route records with the generated filesystem table.
 *
 * `src/pages/**` is the route table for most apps, and `$flamme/routes` carries it as a flat list of
 * {@link FlammeRoute}s. A project that needs one route the file tree cannot express (a legacy URL, a
 * redirect alias) passes it to `createFlammeRouter` as a hand-written record in the `handwritten`
 * option; this module merges the two flat tables, and `defineFlammeRoutes` nests the result.
 *
 * The rules, and what each one is for:
 *
 * - **`name` decides identity.** A hand-written record whose `name` matches a generated record
 *   **replaces** it, in the generated record's own slot. That is deliberate: taking a filesystem
 *   route over is spelled by naming it, and the generated record's children (the records that nest
 *   under it by `parent`) keep nesting under the replacement. The replacement is used **verbatim**:
 *   nothing of the generated record is inherited, so it declares its own `path` and `parent` too.
 * - **`parent` nests.** A hand-written record may nest under a generated record or under another
 *   hand-written one by naming it, whatever the order of the two in the hand-written list. A
 *   `parent` no record declares is `FLM4016`, not a dropped route, and a `parent` chain that closes
 *   on itself is `FLM4019` from the nesting step, not a subtree that silently never installs.
 * - **`path` is unique.** vue-router matches the first record that fits and never reports the loser,
 *   so a hand-written path a different record owns in the **composed** table is `FLM4017`. Ownership
 *   is read off that table rather than off the generated one: the record that *replaces* a generated
 *   one may keep that record's path, and a replacement that moves away frees the path it left.
 * - **A moved generated record is `FLM4020`.** A replacement that changes the `path` or the
 *   `parent` of a generated record the composed table still nests generated records under is
 *   reported: those children were planned against the generated path **and** the generated parent
 *   link, a pathless child (a route group) renders at its parent's URL, so it moves with either.
 * - **`path: ''` is a child.** A pathless record renders at its parent's URL, which is exactly what a
 *   route group (`(name)/+page.vue`) emits. Empty paths are exempt from the collision rule, because
 *   any number of pathless children may share one parent path.
 * - **Order.** Generated records keep the generated order (a replacement included); hand-written
 *   records that declare a new name are appended after them, in the order they were given. Sibling
 *   order is stable and predictable rather than interleaved.
 *
 * One name per record is also the rule *within* the hand-written list: two records with one `name`
 * would silently drop the first, so that is `FLM4018`.
 */

import type { FlammeRoute } from './define.js';

/**
 * The generated table with the hand-written records composed into it.
 *
 * ```ts
 * const routes = composeFlammeRoutes(records, [
 *   { name: 'legacy', path: '/pokemon/:id', parent: '+layout', meta: { flamme: 'page' }, redirect: … },
 * ])
 * ```
 *
 * Throws when a hand-written record cannot be placed: an unknown `parent` (`FLM4016`), a `path`
 * another record owns in the composed table (`FLM4017`), a duplicated hand-written `name`
 * (`FLM4018`), or a replacement that moves the `path` or the `parent` of a generated record whose
 * generated children still nest under it (`FLM4020`). `generated` may be empty: hand-written records
 * alone are a route table, which is what a project with no `src/pages` has.
 */
export function composeFlammeRoutes(
  generated: readonly FlammeRoute[],
  handwritten: readonly FlammeRoute[],
): readonly FlammeRoute[] {
  if (handwritten.length === 0) {
    // the common case, and the one that must stay allocation-free: an app with no hand-written route
    // installs exactly the generated table
    return generated;
  }

  const replacements = new Map<string, FlammeRoute>();
  const handwrittenNames = new Set<string>();
  for (const route of handwritten) {
    if (replacements.has(route.name)) {
      throw new Error(
        `Two hand-written routes are named "${route.name}" (FLM4018). A record's \`name\` is what ` +
          'the composed table replaces a generated record by and what a `parent` points at, so it ' +
          'has to be unique: rename one of the two.',
      );
    }
    replacements.set(route.name, route);
    handwrittenNames.add(route.name);
  }

  // every name the composed table declares: the generated records plus the hand-written ones, which
  // is also the set a `parent` may point at
  const generatedByName = new Map(generated.map((route) => [route.name, route]));
  const generatedNames = new Set(generatedByName.keys());
  const declared = new Set<string>(generatedNames);
  for (const name of handwrittenNames) {
    declared.add(name);
  }
  for (const route of handwritten) {
    if (route.parent !== undefined && !declared.has(route.parent)) {
      throw new Error(
        `The hand-written route "${route.name}" nests under "${route.parent}", which neither the ` +
          'generated table nor the hand-written records declare (FLM4016). Name a record that ' +
          'exists, or drop `parent` to add the record at the top level.',
      );
    }
  }

  // the composed table, in order: a replacement keeps the generated record's slot, and a
  // hand-written record that declares a new name is appended. Built before the collision rule
  // because ownership is a property of the *result*: a replacement that moves a generated record's
  // path frees the path the generated table had for it.
  const composed = generated.map((route) => replacements.get(route.name) ?? route);
  for (const route of handwritten) {
    if (!generatedNames.has(route.name)) {
      composed.push(route);
    }
  }

  // the path each record owns, with the record that owns it, so the diagnostic can name both sides.
  // Empty paths are skipped here: they are the pathless-child convention, and many may share one.
  const byPath = new Map<string, FlammeRoute>();
  for (const route of composed) {
    if (route.path === '') {
      continue;
    }
    const owner = byPath.get(route.path);
    // Two records of one generated table are the generator's own business: the composition never
    // polices a table it did not write. A hand-written record on either side is its business.
    if (
      owner !== undefined &&
      owner.name !== route.name &&
      (handwrittenNames.has(route.name) || handwrittenNames.has(owner.name))
    ) {
      throw new Error(pathCollision(route, owner, handwrittenNames));
    }
    byPath.set(route.path, route);
  }

  // A replacement still parents every record that nested under the generated record by name. Those
  // children were planned against the generated record's path **and** its parent link, so a
  // replacement that moves either is reported rather than left to move a pathless child's URL (a
  // route group renders at its parent's URL) or to relocate the whole subtree silently.
  for (const [name, replacement] of replacements) {
    const original = generatedByName.get(name);
    if (original === undefined) {
      continue;
    }
    if (original.path === replacement.path && original.parent === replacement.parent) {
      continue;
    }
    const children = composed.filter(
      (route) => route.parent === name && !handwrittenNames.has(route.name),
    );
    if (children.length > 0) {
      throw new Error(movedGeneratedRecord(name, original, replacement, children));
    }
  }

  return composed;
}

/** How the diagnostic names one side of a path collision. */
function kindOf(name: string, handwrittenNames: ReadonlySet<string>): string {
  return handwrittenNames.has(name) ? 'hand-written route' : 'generated route';
}

/**
 * The `FLM4017` message: one record's path is one another record in the composed table already
 * owns, which makes the later record unreachable.
 *
 * The offender is usually a hand-written record and the owner is usually a generated one; a
 * replacement that moves its path onto a surviving generated record's, and a hand-written record
 * that reuses an earlier hand-written one's, are the same failure with the sides swapped.
 */
function pathCollision(
  offender: FlammeRoute,
  owner: FlammeRoute,
  handwrittenNames: ReadonlySet<string>,
): string {
  return (
    `The ${kindOf(offender.name, handwrittenNames)} "${offender.name}" declares the path ` +
    `"${offender.path}", which the ${kindOf(owner.name, handwrittenNames)} "${owner.name}" already ` +
    'owns (FLM4017). Two records with one path make the later one unreachable: give the ' +
    `hand-written record a path of its own, nest it under "${owner.name}" with \`path: ''\`, or ` +
    `claim "${owner.name}" as its \`name\` to take that record over deliberately.`
  );
}

/**
 * The `FLM4020` message: a replacement moved the `path` or the `parent` of a generated record whose
 * generated children still nest under it by name.
 *
 * The message names the record, every link it declares against the generated one (a replacement may
 * move both at once, and each is a way the subtree's URLs move), and every child that stayed,
 * because the child list is what the author has to re-declare (or leave the generated record's links
 * alone for).
 */
function movedGeneratedRecord(
  name: string,
  original: FlammeRoute,
  replacement: FlammeRoute,
  children: readonly FlammeRoute[],
): string {
  const moved: string[] = [];
  if (original.path !== replacement.path) {
    moved.push(`declares the path "${replacement.path}" instead of "${original.path}"`);
  }
  if (original.parent !== replacement.parent) {
    moved.push(
      `declares ${parentLink(replacement.parent)} instead of ${parentLink(original.parent)}`,
    );
  }
  const list = children.map((child) => `"${child.name}" (path "${child.path}")`).join(', ');
  return (
    `The hand-written route "${name}" replaces the generated record of the same name but ` +
    `${moved.join(' and ')} (FLM4020). The generated records ${list} still nest under it, and the ` +
    `generator planned their URLs against ${plannedAgainst(original)}: a pathless child renders at ` +
    "its parent's URL and moves with it, and an absolute-path child keeps its own path, so the " +
    "parent's URL no longer contains it. Keep the generated path and parent, replace those children " +
    'in the same hand-written table, or give this route a name of its own.'
  );
}

/** How a declared `parent` link reads in the "declares … instead of …" clause. */
function parentLink(parent: string | undefined): string {
  return parent === undefined ? 'no parent' : `the parent "${parent}"`;
}

/** How the generated record's own links read in the explanation clause. */
function plannedAgainst(original: FlammeRoute): string {
  return original.parent === undefined
    ? `path "${original.path}" at the top level`
    : `path "${original.path}" under "${original.parent}"`;
}

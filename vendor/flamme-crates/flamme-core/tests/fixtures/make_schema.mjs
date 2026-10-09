/**
 * Materializes the schema-index parity fixtures for the Rust tests.
 *
 *   node crates/flamme-core/tests/fixtures/make_schema.mjs
 *
 * `schema` is the valid project: an interface, a union, an enum, input objects, both
 * `@key` spellings, a configured key (one field kept because it is declared, one
 * dropped because it is not) and a type that falls back to `defaultKeys`. Its whole
 * generated tree is produced by the TypeScript compiler, so `schema_parity.rs` can
 * compare the index and the emitted schema files against the oracle.
 *
 * `schema-keys` is the invalid one: two `@key` directives on one type and a `@key`
 * naming a field that is not a scalar, which are the two FLM1015 reports. The oracle
 * refuses to emit for it, so only its diagnostics are compared.
 *
 * `schema-declared` is a schema that declares the compiler's own directives and
 * enums itself (§7.5): the merge must add only what is missing and `indexSdlFor`
 * must keep the user's non-repeatable `@key`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The project config; `types` is the per-project key configuration. */
function config(types) {
  return `${JSON.stringify(
    {
      schemaPath: './server/schema.graphql',
      url: '/graphql',
      include: ['src/**/*.{vue,ts,graphql,gql}'],
      exclude: ['server/schema.graphql'],
      ...(types === undefined ? {} : { types }),
    },
    null,
    2,
  )}\n`;
}

const CONFIG = config({
  Gym: { keys: ['name', 'leader'] },
  League: { keys: ['slug', 'name'] },
});


const SCHEMA = `# Schema shape for the schema-index parity fixture.
#
# It exercises everything buildSchemaIndex reads: an interface, a union, an enum,
# input objects, both @key spellings, a configured key (one field kept because the
# type declares it, one dropped because it does not) and a type that falls back to
# defaultKeys.

interface Node {
\tid: ID!
}

type Species implements Node @key(fields: ["id"]) {
\tid: ID!
\tname: String!
\tweight: Int
\tregion: Region!
\tfavorite: Boolean!
}

type Trainer implements Node @key(fields: "id name") {
\tid: ID!
\tname: String!
\thome: Region
}

type Gym implements Node {
\tid: ID!
\tname: String!
\tleader: Trainer
}

type League implements Node {
\tid: ID!
\tname: String!
\tgyms: [Gym!]!
}

type Badge {
\tid: ID!
\tname: String!
}

# A key on an extension is invisible to the oracle: it reads
# type.astNode.directives, and astNode is the base definition. Badge therefore
# falls back to defaultKeys.
extend type Badge @key(fields: ["name"]) {
\textra: String
}

union SearchResult = Species | Trainer | Gym

enum Region {
\tKanto
\tJohto
\tHoenn
}

extend enum Region {
\tSinnoh
}

input SearchFilter {
\tregion: Region
\tlimit: Int!
\tmatch: String
}

input NestedFilter {
\tfilter: SearchFilter!
\ttags: [String!]
}

type Query {
\tsearch(filter: SearchFilter): [SearchResult!]!
\tspecies(id: ID!): Species
\ttrainer(id: ID!): Trainer
\tgym(id: ID!): Gym
\tleague(id: ID!): League
\tbadge(id: ID!): Badge
\tnode(id: ID!): Node
}
`;

const DOCUMENT = `query Search($filter: SearchFilter) {
\tsearch(filter: $filter) {
\t\t... on Species {
\t\t\tid
\t\t\tname
\t\t\tregion
\t\t}
\t\t... on Trainer {
\t\t\tid
\t\t\tname
\t\t}
\t\t... on Gym {
\t\t\tid
\t\t\tname
\t\t}
\t}
}
`;

const KEYS_SCHEMA = `# Schema shape for the FLM1015 parity fixture: a schema key declared twice on one
# type, and a schema key naming a field that is not a scalar.

interface Node {
\tid: ID!
}

type Species implements Node @key(fields: ["id"]) @key(fields: ["name"]) {
\tid: ID!
\tname: String!
\thabitat: Habitat!
}

type Habitat {
\tid: ID!
\tname: String!
}

# The description is part of the definition's location: graphql-js's loc.startToken
# is the token the definition starts at, the description when there is one.
"""
A trainer. home is deliberately not a scalar, so its key reports FLM1015.
"""
type Trainer implements Node @key(fields: "home") {
\tid: ID!
\tname: String!
\thome: Habitat
}

union SearchResult = Species | Trainer

type Query {
\tsearch: [SearchResult!]!
\tnode(id: ID!): Node
}
`;

const KEYS_DOCUMENT = `query Search {
\tsearch {
\t\t... on Species {
\t\t\tid
\t\t\tname
\t\t}
\t\t... on Trainer {
\t\t\tid
\t\t\tname
\t\t}
\t}
}
`;

const DECLARED_SCHEMA = `# A schema that declares the compiler's own directives and enums (§7.5). The merge
# appends only what is missing, so @loading, @paginate and the rest still land here,
# while @key, @cache and both enums keep the user's declarations.

directive @key(fields: [String!]!) on OBJECT | INTERFACE
directive @cache(policy: CachePolicy, partial: Boolean) on QUERY | MUTATION | SUBSCRIPTION

enum CachePolicy {
\tCacheOrNetwork
\tNetworkOnly
\tCacheAndNetwork
\tCacheOnly
\tSessionOnly
}

enum PaginateMode {
\tSinglePage
\tInfinite
\tWindowed
}

type Wallet @key(fields: ["id"]) {
\tid: ID!
\tbalance: Int!
}

type Query {
\twallet(id: ID!): Wallet
}
`;

const DECLARED_DOCUMENT = `query Wallet($id: ID!) {
\twallet(id: $id) {
\t\tid
\t\tbalance
\t}
}
`;

const projects = {
  schema: {
    'flamme.config.json': CONFIG,
    'server/schema.graphql': SCHEMA,
    'src/routes/+page.gql': DOCUMENT,
  },
  'schema-keys': {
    'flamme.config.json': CONFIG,
    'server/schema.graphql': KEYS_SCHEMA,
    'src/routes/+page.gql': KEYS_DOCUMENT,
  },
  'schema-declared': {
    'flamme.config.json': config(undefined),
    'server/schema.graphql': DECLARED_SCHEMA,
    'src/routes/+page.gql': DECLARED_DOCUMENT,
  },
};

for (const [name, files] of Object.entries(projects)) {
  const target = join(HERE, name);
  await rm(target, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(target, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files to ${target}\n`);
}

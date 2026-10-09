/**
 * Hand-rolled argv parsing for the commands (`spec/spec.md` §10.5). The accepted
 * surface is a closed set, so a small parser beats a general-purpose one; it
 * never throws, and every rejection carries a message for the user.
 */

/** Commands the CLI accepts. */
export type CommandName = 'generate' | 'check' | 'explain' | 'refs' | 'init';

/** Parsed `flamme generate` invocation. */
export interface GenerateArgs {
  /** Discriminant. */
  readonly command: 'generate';
  /** Explicit config file from `--config`, or `undefined` to search the project. */
  readonly configFile: string | undefined;
  /** `--watch`: keep running and rebuild on every change. */
  readonly watch: boolean;
  /** `--force`: rewrite every generated file, changed or not. */
  readonly force: boolean;
  /** `--silent`: print nothing on success. */
  readonly silent: boolean;
  /** `--persisted`: also write and register `persisted.json`. */
  readonly persisted: boolean;
}

/** Parsed `flamme check` invocation. */
export interface CheckArgs {
  /** Discriminant. */
  readonly command: 'check';
  /** Explicit config file from `--config`, or `undefined` to search the project. */
  readonly configFile: string | undefined;
  /** `--json`: machine-readable diagnostics instead of the human lines. */
  readonly json: boolean;
  /** `--persisted`: fail when the committed persisted-query manifest is stale. */
  readonly persisted: boolean;
}

/** Parsed `flamme explain` invocation. */
export interface ExplainArgs {
  /** Discriminant. */
  readonly command: 'explain';
  /** Explicit config file from `--config`, or `undefined` to search the project. */
  readonly configFile: string | undefined;
  /** The document name given positionally, or `undefined` with `--fragment`. */
  readonly document: string | undefined;
  /** The fragment name given through `--fragment`, or `undefined`. */
  readonly fragment: string | undefined;
  /** `--json`: one machine-readable report instead of the human text. */
  readonly json: boolean;
}

/** Parsed `flamme refs` invocation. */
export interface RefsArgs {
  /** Discriminant. */
  readonly command: 'refs';
  /** Explicit config file from `--config`, or `undefined` to search the project. */
  readonly configFile: string | undefined;
  /** The fragment name to find spreaders of. */
  readonly fragment: string;
  /** `--json`: one machine-readable report instead of the human text. */
  readonly json: boolean;
}

/** Parsed `flamme init` invocation. */
export interface InitArgs {
  /** Discriminant. */
  readonly command: 'init';
  /** `--dry-run`: print the diff and write nothing. */
  readonly dryRun: boolean;
}

/** Any parsed command line. */
export type ParsedArgs = GenerateArgs | CheckArgs | ExplainArgs | RefsArgs | InitArgs;

/** What {@link parseArgs} decided. */
export type ParseResult =
  | { readonly kind: 'command'; readonly args: ParsedArgs }
  | { readonly kind: 'help'; readonly command: CommandName | undefined }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'usage-error';
      readonly command: CommandName | undefined;
      readonly message: string;
      /**
       * True when the command accepts `--json` and the parser had already seen that flag when it
       * rejected the line. The CLI then prints one JSON error value on stdout, so a caller that
       * asked for machine-readable output gets it even for a usage error; a line that is malformed
       * before the flag is reached keeps stdout empty and prints the usage on stderr.
       */
      readonly json: boolean;
    };

/** The prefixes of the flags that take a value. */
const CONFIG_PREFIX = '--config=';
const FRAGMENT_PREFIX = '--fragment=';

/** Flags each command accepts, beyond the value flags and the global `--help`/`--version`. */
const COMMAND_FLAGS: Readonly<Record<CommandName, readonly string[]>> = {
  generate: ['--watch', '--force', '--silent', '--persisted'],
  check: ['--json', '--persisted'],
  explain: ['--json'],
  refs: ['--json'],
  init: ['--dry-run'],
};

/** Usage line and one-line summary per command, for the help text. */
const COMMAND_USAGE: readonly { readonly command: CommandName; readonly usage: string }[] = [
  {
    command: 'generate',
    usage: 'generate [--config <path>] [--watch] [--force] [--silent] [--persisted]',
  },
  { command: 'check', usage: 'check [--config <path>] [--json] [--persisted]' },
  {
    command: 'explain',
    usage: 'explain <Document> [--config <path>] [--json] | explain --fragment <Name> [--json]',
  },
  { command: 'refs', usage: 'refs <Fragment> [--config <path>] [--json]' },
  { command: 'init', usage: 'init [--dry-run]' },
];

/** One option line of the help text, with the commands that accept it. */
interface OptionLine {
  /** How the option is written in the help text (`--config <path>`). */
  readonly flag: string;
  /** One-line explanation. */
  readonly description: string;
  /** Commands that accept it; empty means every command plus the global surface. */
  readonly commands: readonly CommandName[];
}

/** Every option, in help order. */
const OPTION_LINES: readonly OptionLine[] = [
  {
    flag: '--config <path>',
    description: 'use an explicit config file instead of searching',
    commands: ['generate', 'check', 'explain', 'refs'],
  },
  { flag: '--watch', description: 'rebuild on every change', commands: ['generate'] },
  { flag: '--force', description: 'rewrite unchanged files too', commands: ['generate'] },
  { flag: '--silent', description: 'print nothing on success', commands: ['generate'] },
  {
    flag: '--persisted',
    description: 'write persisted.json, or fail check when it is stale',
    commands: ['generate', 'check'],
  },
  {
    flag: '--json',
    description: 'print machine-readable diagnostics',
    commands: ['check', 'explain', 'refs'],
  },
  {
    flag: '--fragment <name>',
    description: 'explain a fragment instead of an operation',
    commands: ['explain'],
  },
  { flag: '--dry-run', description: 'print the diff and write nothing', commands: ['init'] },
  { flag: '-h, --help', description: 'show this help', commands: [] },
  { flag: '-v, --version', description: 'print the CLI version', commands: [] },
];

/** True for a token that names a command. */
function isCommand(value: string): value is CommandName {
  return COMMAND_USAGE.some((entry) => entry.command === value);
}

/** A usage-error result. */
function usageError(command: CommandName | undefined, message: string, json = false): ParseResult {
  return { kind: 'usage-error', command, message, json };
}

/** True when `--help`/`-h` or `--version`/`-v` was given after the command. */
function globalFlag(command: CommandName, flags: readonly string[]): ParseResult | undefined {
  for (const flag of flags) {
    if (flag === '--help' || flag === '-h') {
      return { kind: 'help', command };
    }
    if (flag === '--version' || flag === '-v') {
      return { kind: 'version' };
    }
  }
  return undefined;
}

/** Everything {@link parseCommand} collected before the command-specific build. */
interface Collected {
  readonly configFile: string | undefined;
  readonly fragmentFlag: string | undefined;
  readonly seen: ReadonlySet<string>;
  readonly positionals: readonly string[];
  /** True when `--json` was among the flags the walk accepted. */
  readonly json: boolean;
}

/** Builds the command-specific args once every flag is validated. */
function buildArgs(command: CommandName, collected: Collected): ParseResult {
  const { configFile, fragmentFlag, seen, positionals, json } = collected;
  if (command === 'generate') {
    if (positionals.length > 0) {
      return usageError(
        command,
        `unknown option "${positionals[0] ?? ''}" for "flamme generate".`,
        json,
      );
    }
    return {
      kind: 'command',
      args: {
        command,
        configFile,
        watch: seen.has('--watch'),
        force: seen.has('--force'),
        silent: seen.has('--silent'),
        persisted: seen.has('--persisted'),
      },
    };
  }
  if (command === 'check') {
    if (positionals.length > 0) {
      return usageError(
        command,
        `unknown option "${positionals[0] ?? ''}" for "flamme check".`,
        json,
      );
    }
    return {
      kind: 'command',
      args: {
        command,
        configFile,
        json: seen.has('--json'),
        persisted: seen.has('--persisted'),
      },
    };
  }
  if (command === 'explain') {
    const document = positionals[0];
    if (document !== undefined && fragmentFlag !== undefined) {
      return usageError(
        command,
        'explain takes a document name or --fragment <Name>, not both.',
        json,
      );
    }
    if (positionals.length > 1) {
      return usageError(
        command,
        `explain takes one document name, not "${positionals[1] ?? ''}".`,
        json,
      );
    }
    if (document === undefined && fragmentFlag === undefined) {
      return usageError(command, 'explain needs a document name or --fragment <Name>.', json);
    }
    return {
      kind: 'command',
      args: { command, configFile, document, fragment: fragmentFlag, json: seen.has('--json') },
    };
  }
  if (command === 'refs') {
    if (positionals.length === 0) {
      return usageError(command, 'refs needs a fragment name.', json);
    }
    if (positionals.length > 1) {
      return usageError(
        command,
        `refs takes one fragment name, not "${positionals[1] ?? ''}".`,
        json,
      );
    }
    return {
      kind: 'command',
      args: {
        command,
        configFile,
        fragment: positionals[0] ?? '',
        json: seen.has('--json'),
      },
    };
  }
  if (positionals.length > 0) {
    return usageError(command, `unknown option "${positionals[0] ?? ''}" for "flamme init".`, json);
  }
  return { kind: 'command', args: { command, dryRun: seen.has('--dry-run') } };
}

/** Parses the flags that follow a known command. */
function parseCommand(command: CommandName, flags: readonly string[]): ParseResult {
  const queue = [...flags];
  const seen = new Set<string>();
  const positionals: string[] = [];
  let configFile: string | undefined;
  let fragmentFlag: string | undefined;
  let flag = queue.shift();
  while (flag !== undefined) {
    const inlineConfig = flag.startsWith(CONFIG_PREFIX) ? flag.slice(CONFIG_PREFIX.length) : undefined;
    const inlineFragment = flag.startsWith(FRAGMENT_PREFIX)
      ? flag.slice(FRAGMENT_PREFIX.length)
      : undefined;
    if (command !== 'init' && (flag === '--config' || inlineConfig !== undefined)) {
      const value = inlineConfig ?? queue.shift();
      if (value === undefined || value.length === 0) {
        return usageError(command, '--config needs a path.', seen.has('--json'));
      }
      configFile = value;
    } else if (command === 'explain' && (flag === '--fragment' || inlineFragment !== undefined)) {
      const value = inlineFragment ?? queue.shift();
      if (value === undefined || value.length === 0) {
        return usageError(command, '--fragment needs a name.', seen.has('--json'));
      }
      fragmentFlag = value;
    } else if (COMMAND_FLAGS[command].includes(flag)) {
      seen.add(flag);
    } else if (flag.startsWith('-')) {
      return usageError(
        command,
        `unknown option "${flag}" for "flamme ${command}".`,
        seen.has('--json'),
      );
    } else {
      positionals.push(flag);
    }
    flag = queue.shift();
  }
  return buildArgs(command, {
    configFile,
    fragmentFlag,
    seen,
    positionals,
    json: seen.has('--json'),
  });
}

/** Parses argv without `node` and the script path; never throws. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first === undefined) {
    return usageError(undefined, 'expected a command: generate, check, explain, refs or init.');
  }
  if (first === '--help' || first === '-h') {
    return { kind: 'help', command: undefined };
  }
  if (first === '--version' || first === '-v') {
    return { kind: 'version' };
  }
  if (!isCommand(first)) {
    return usageError(undefined, `unknown command "${first}".`);
  }
  const global = globalFlag(first, argv.slice(1));
  if (global !== undefined) {
    return global;
  }
  return parseCommand(first, argv.slice(1));
}

/** The `--help` text, optionally narrowed to one command. */
export function usageLines(command?: CommandName): readonly string[] {
  const commands = COMMAND_USAGE.filter(
    (entry) => command === undefined || entry.command === command,
  );
  const options = OPTION_LINES.filter(
    (entry) =>
      entry.commands.length === 0 || command === undefined || entry.commands.includes(command),
  );
  return [
    'flamme — GraphQL codegen for Vue',
    '',
    'Usage:',
    ...commands.map((entry) => `  flamme ${entry.usage}`),
    '',
    'Options:',
    ...options.map((entry) => `  ${entry.flag.padEnd(16)}${entry.description}`),
    '',
    'Exit codes:',
    '  0 success · 1 compile errors · 2 config or usage error · 3 schema load failure · 4 internal error',
  ];
}

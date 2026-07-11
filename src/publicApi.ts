import type { DebugEngine } from './debugEngine';

/** Version of the declarative extension API returned by activate(). */
export const PUBLIC_API_VERSION = 1 as const;

/** VS Code debug type consumers can use for a normal attach session. */
export const DJANGO_PROCESS_DEBUG_TYPE = 'django-process' as const;

/** Commands safe for another extension to present or invoke. */
export const SETUP_COMMAND_ID = 'djangoProcessDebugger.setup' as const;
export const STATUS_COMMAND_ID = 'djangoProcessDebugger.showSetupStatus' as const;

const PUBLIC_ENGINES = Object.freeze([
  'debugpy',
  'experimental',
] as const satisfies readonly DebugEngine[]);

const PUBLIC_COMMANDS = Object.freeze({
  setup: SETUP_COMMAND_ID,
  status: STATUS_COMMAND_ID,
});

const EXPERIMENTAL_CAPABILITIES = Object.freeze({
  /** Attach by passing a positive PID from the same host to django-process. */
  localPid: true as const,
  /** Sessions started through django-process participate in hot reload. */
  hotReload: true as const,
});

const PUBLIC_CAPABILITIES = Object.freeze({
  experimental: EXPERIMENTAL_CAPABILITIES,
});

/**
 * Stable, side-effect-free contract exposed to sibling VS Code extensions.
 *
 * Activation and session ownership deliberately remain behind the contributed
 * debug type. Consumers should start a normal `django-process` session instead
 * of bypassing its PID lock, bootstrap checks, or hot-reload lifecycle.
 */
export interface DjangoProcessDebuggerPublicApiV1 {
  readonly apiVersion: typeof PUBLIC_API_VERSION;
  readonly debugType: typeof DJANGO_PROCESS_DEBUG_TYPE;
  readonly engines: typeof PUBLIC_ENGINES;
  readonly commands: typeof PUBLIC_COMMANDS;
  readonly capabilities: typeof PUBLIC_CAPABILITIES;
}

export const DJANGO_PROCESS_DEBUGGER_PUBLIC_API: DjangoProcessDebuggerPublicApiV1 =
  Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    debugType: DJANGO_PROCESS_DEBUG_TYPE,
    engines: PUBLIC_ENGINES,
    commands: PUBLIC_COMMANDS,
    capabilities: PUBLIC_CAPABILITIES,
  });

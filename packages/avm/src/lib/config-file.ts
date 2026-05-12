import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseDocument } from "yaml";
import { avmConfigFile } from "./config.ts";

// ---------- Types ----------

export type EditorChoice = "code" | "cursor" | "zed";

export interface DaemonConfig {
  port: number;
}

export interface PruneImagesConfig {
  enabled: boolean;
  keep_recent: number;
}

export interface ServiceDefinition {
  kind: "process" | "docker";
  command?: string[];
  container?: string;
  check: ServiceCheck;
}

export interface ServiceCheck {
  tcp: string;
}

export interface NotificationSound {
  file: string;
  volume: number;
}

export interface NotificationsConfig {
  enabled: boolean;
  sounds: {
    "needs-attention": NotificationSound;
    complete: NotificationSound;
  };
}

export interface AvmConfig {
  editor?: EditorChoice;
  daemon: DaemonConfig;
  prune_images: PruneImagesConfig;
  agents_md: string[];
  skills_dir: string[];
  volumes: VolumeMount[];
  repos: Record<string, RepoConfig>;
  services: Record<string, ServiceDefinition>;
  integrations: IntegrationsConfig;
  notifications: NotificationsConfig;
}

export interface IntegrationsConfig {
  claude_notifications: boolean;
  claude_desktop: boolean;
}

export interface VolumeMount {
  /** Raw source string as written in config.yaml (relative to ~/.avm/volumes/ unless absolute). */
  source: string;
  /** Raw target string as written in config.yaml (relative to /home/agent/ unless absolute; ~/ expands to /home/agent/). */
  target: string;
}

export interface RepoConfig {
  symlinks: SymlinkMount[];
}

export interface SymlinkMount {
  /** Raw source, relative to ~/.avm/files/. */
  source: string;
  /** Raw target, relative to the `avm-bridge link` invocation cwd (typically a repo working copy). */
  target: string;
}

// ---------- Public API ----------

/**
 * Load and validate `~/.avm/config.yaml`. Returns an empty config if the
 * file does not exist. Throws on schema errors with a message that
 * identifies the offending key.
 */
export function loadAvmConfig(): AvmConfig {
  if (!existsSync(avmConfigFile)) {
    return {
      daemon: { port: 6970 },
      prune_images: defaultPruneImagesConfig(),
      agents_md: ["~/AGENTS.md"],
      skills_dir: [],
      volumes: [],
      repos: {},
      services: {},
      integrations: { claude_notifications: false, claude_desktop: false },
      notifications: structuredClone(DEFAULT_NOTIFICATIONS),
    };
  }
  const raw = readFileSync(avmConfigFile, "utf-8");
  return parseAvmConfig(raw);
}

function defaultPruneImagesConfig(): PruneImagesConfig {
  return { enabled: false, keep_recent: 1 };
}

/**
 * Set the `editor` field in `~/.avm/config.yaml`, preserving all other
 * content and formatting. Creates the file if it doesn't exist.
 */
export function setConfigEditor(editor: EditorChoice): void {
  const raw = existsSync(avmConfigFile)
    ? readFileSync(avmConfigFile, "utf-8")
    : "";
  const doc = parseDocument(raw);
  doc.set("editor", editor);
  writeFileSync(avmConfigFile, doc.toString());
}

/**
 * Set an `integrations.*` boolean in `~/.avm/config.yaml`, preserving
 * all other content and formatting. Creates the file if it doesn't exist.
 */
export function setConfigIntegration(
  key: "claude_notifications" | "claude_desktop",
  value: boolean,
): void {
  const raw = existsSync(avmConfigFile)
    ? readFileSync(avmConfigFile, "utf-8")
    : "";
  const doc = parseDocument(raw);
  doc.setIn(["integrations", key], value);
  writeFileSync(avmConfigFile, doc.toString());
}

/**
 * Set the `notifications.enabled` field in `~/.avm/config.yaml`,
 * preserving all other content and formatting. Creates the file if
 * it doesn't exist.
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const raw = existsSync(avmConfigFile)
    ? readFileSync(avmConfigFile, "utf-8")
    : "";
  const doc = parseDocument(raw);
  doc.setIn(["notifications", "enabled"], enabled);
  writeFileSync(avmConfigFile, doc.toString());
}

/** Parse + validate YAML content. Separated from I/O for testability. */
export function parseAvmConfig(yamlSource: string): AvmConfig {
  const doc = parseDocument(yamlSource);
  if (doc.errors.length > 0) {
    const msg = doc.errors.map((e) => e.message).join("\n");
    throw new Error(`Invalid YAML in ${avmConfigFile}:\n${msg}`);
  }
  const data = (doc.toJS() ?? {}) as unknown;
  return validate(data);
}

// ---------- Validation ----------

const TOP_LEVEL_KEYS = new Set([
  "editor",
  "agents_md",
  "skills_dir",
  "volumes",
  "repos",
  "daemon",
  "prune_images",
  "services",
  "integrations",
  "notifications",
]);
const VALID_EDITORS = new Set<string>(["code", "cursor", "zed"]);
const REPO_KEYS = new Set(["symlinks"]);

function validate(data: unknown): AvmConfig {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `${avmConfigFile}: top-level must be a mapping (got ${describe(data)}).`,
    );
  }

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown top-level key "${key}" (ignored). Allowed: ${[...TOP_LEVEL_KEYS].join(", ")}.`,
      );
    }
  }

  const editor = parseEditor(obj.editor);
  const daemon = parseDaemon(obj.daemon);
  const prune_images = parsePruneImages(obj.prune_images);
  const agents_md = parseAgentsMd(obj.agents_md);
  const skills_dir = parseSkillsDir(obj.skills_dir);
  const volumes = parseVolumes(obj.volumes);
  const repos = parseRepos(obj.repos);
  const services = parseServices(obj.services);
  const integrations = parseIntegrations(obj.integrations);
  const notifications = parseNotifications(obj.notifications);
  return {
    editor,
    daemon,
    prune_images,
    agents_md,
    skills_dir,
    volumes,
    repos,
    services,
    integrations,
    notifications,
  };
}

function parseStringOrList(raw: unknown, fieldName: string): string[] {
  if (raw === undefined) return [];
  const isList = Array.isArray(raw);
  const entries = isList ? raw : [raw];
  return entries.map((entry, i) => {
    const ctx = isList ? `${fieldName}[${i}]` : fieldName;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `${avmConfigFile}: ${ctx} must be a non-empty string (got ${describe(entry)}).`,
      );
    }
    // Reject shell-unsafe chars (same rule as splitShortForm).
    const unsafeChars = /["$`\\]|[\x00-\x1f\x7f]/;
    if (unsafeChars.test(entry)) {
      throw new Error(
        `${avmConfigFile}: ${ctx} ("${entry}") contains unsafe characters.`,
      );
    }
    return entry;
  });
}

function parseAgentsMd(raw: unknown): string[] {
  if (raw === undefined) return ["~/AGENTS.md"];
  return parseStringOrList(raw, "agents_md");
}

function parseSkillsDir(raw: unknown): string[] {
  return parseStringOrList(raw, "skills_dir");
}

const INTEGRATIONS_KEYS = new Set(["claude_notifications", "claude_desktop"]);

function parseIntegrations(raw: unknown): IntegrationsConfig {
  const result: IntegrationsConfig = {
    claude_notifications: false,
    claude_desktop: false,
  };
  if (raw === undefined) return result;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "integrations" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!INTEGRATIONS_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown key "${key}" under integrations (ignored). Allowed: ${[...INTEGRATIONS_KEYS].join(", ")}.`,
      );
    }
  }
  for (const key of INTEGRATIONS_KEYS) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== "boolean") {
        throw new Error(
          `${avmConfigFile}: integrations.${key} must be a boolean (got ${describe(obj[key])}).`,
        );
      }
      result[key as keyof IntegrationsConfig] = obj[key] as boolean;
    }
  }
  return result;
}

function parseEditor(raw: unknown): EditorChoice | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !VALID_EDITORS.has(raw)) {
    throw new Error(
      `${avmConfigFile}: "editor" must be one of: ${[...VALID_EDITORS].join(", ")} (got ${describe(raw)}).`,
    );
  }
  return raw as EditorChoice;
}

function parseVolumes(raw: unknown): VolumeMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "volumes" must be a list (got ${describe(raw)}).`,
    );
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(
        `${avmConfigFile}: volumes[${i}] must be a "source:target" string (got ${describe(entry)}).`,
      );
    }
    return splitShortForm(entry, `volumes[${i}]`);
  });
}

function parseRepos(raw: unknown): Record<string, RepoConfig> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "repos" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const out: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(
        `${avmConfigFile}: repos.${name} — repo name must contain only letters, digits, dots, underscores, and hyphens.`,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `${avmConfigFile}: repos.${name} must be a mapping (got ${describe(value)}).`,
      );
    }
    const repoObj = value as Record<string, unknown>;
    for (const key of Object.keys(repoObj)) {
      if (!REPO_KEYS.has(key)) {
        console.warn(
          `${avmConfigFile}: unknown key "${key}" under repos.${name} (ignored). Allowed: ${[...REPO_KEYS].join(", ")}.`,
        );
      }
    }
    out[name] = { symlinks: parseSymlinks(repoObj.symlinks, name) };
  }
  return out;
}

function parseSymlinks(raw: unknown, repoName: string): SymlinkMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: repos.${repoName}.symlinks must be a list (got ${describe(raw)}).`,
    );
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(
        `${avmConfigFile}: repos.${repoName}.symlinks[${i}] must be a "source:target" string (got ${describe(entry)}).`,
      );
    }
    return splitShortForm(entry, `repos.${repoName}.symlinks[${i}]`);
  });
}

/** Split "source:target" on the first colon. Both sides must be non-empty and shell-safe. */
function splitShortForm(
  entry: string,
  context: string,
): { source: string; target: string } {
  const idx = entry.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `${avmConfigFile}: ${context} ("${entry}") must be "source:target".`,
    );
  }
  const source = entry.slice(0, idx);
  const target = entry.slice(idx + 1);
  if (source.length === 0 || target.length === 0) {
    throw new Error(
      `${avmConfigFile}: ${context} ("${entry}") has an empty source or target.`,
    );
  }
  // Reject characters that could break shell interpolation if these values are ever used in a shell command.
  const unsafeChars = /["$`\\]|[\x00-\x1f\x7f]/;
  if (unsafeChars.test(source) || unsafeChars.test(target)) {
    throw new Error(
      `${avmConfigFile}: ${context} ("${entry}") contains unsafe characters. source and target must not contain: " $ \` \\ or control characters.`,
    );
  }
  return { source, target };
}

const DAEMON_KEYS = new Set(["port"]);
const PRUNE_IMAGES_KEYS = new Set(["enabled", "keep_recent"]);
const SERVICE_KEYS = new Set(["kind", "command", "container", "check"]);
const CHECK_KEYS = new Set(["tcp"]);
const VALID_SERVICE_KINDS = new Set(["process", "docker"]);

const NOTIFICATIONS_KEYS = new Set(["enabled", "sounds"]);
const SOUND_KEYS = new Set(["file", "volume"]);
const SOUND_NAMES = new Set(["needs-attention", "complete"]);

const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: true,
  sounds: {
    "needs-attention": {
      file: "/System/Library/Sounds/Ping.aiff",
      volume: 0.7,
    },
    complete: {
      file: "/System/Library/Sounds/Submarine.aiff",
      volume: 1.0,
    },
  },
};

function parseDaemon(raw: unknown): DaemonConfig {
  if (raw === undefined) return { port: 6970 };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "daemon" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!DAEMON_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown key "${key}" under daemon (ignored). Allowed: ${[...DAEMON_KEYS].join(", ")}.`,
      );
    }
  }
  let port = 6970;
  if (obj.port !== undefined) {
    if (
      typeof obj.port !== "number" ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535
    ) {
      throw new Error(
        `${avmConfigFile}: daemon.port must be an integer 1–65535 (got ${describe(obj.port)}).`,
      );
    }
    port = obj.port;
  }
  return { port };
}

function parsePruneImages(raw: unknown): PruneImagesConfig {
  if (raw === undefined) return defaultPruneImagesConfig();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "prune_images" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!PRUNE_IMAGES_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown key "${key}" under prune_images (ignored). Allowed: ${[...PRUNE_IMAGES_KEYS].join(", ")}.`,
      );
    }
  }
  const defaults = defaultPruneImagesConfig();
  let enabled = defaults.enabled;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(
        `${avmConfigFile}: prune_images.enabled must be a boolean (got ${describe(obj.enabled)}).`,
      );
    }
    enabled = obj.enabled;
  }
  let keep_recent = defaults.keep_recent;
  if (obj.keep_recent !== undefined) {
    if (
      typeof obj.keep_recent !== "number" ||
      !Number.isInteger(obj.keep_recent) ||
      obj.keep_recent < 0
    ) {
      throw new Error(
        `${avmConfigFile}: prune_images.keep_recent must be a non-negative integer (got ${describe(obj.keep_recent)}).`,
      );
    }
    keep_recent = obj.keep_recent;
  }
  return { enabled, keep_recent };
}

function parseServices(
  raw: unknown,
): Record<string, ServiceDefinition> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "services" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const out: Record<string, ServiceDefinition> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(
        `${avmConfigFile}: services.${name} — service name must contain only letters, digits, dots, underscores, and hyphens.`,
      );
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `${avmConfigFile}: services.${name} must be a mapping (got ${describe(value)}).`,
      );
    }
    const svcObj = value as Record<string, unknown>;
    for (const key of Object.keys(svcObj)) {
      if (!SERVICE_KEYS.has(key)) {
        console.warn(
          `${avmConfigFile}: unknown key "${key}" under services.${name} (ignored). Allowed: ${[...SERVICE_KEYS].join(", ")}.`,
        );
      }
    }
    // kind: required
    if (svcObj.kind === undefined) {
      throw new Error(
        `${avmConfigFile}: services.${name}.kind is required.`,
      );
    }
    if (
      typeof svcObj.kind !== "string" ||
      !VALID_SERVICE_KINDS.has(svcObj.kind)
    ) {
      throw new Error(
        `${avmConfigFile}: services.${name}.kind must be one of: ${[...VALID_SERVICE_KINDS].join(", ")} (got ${describe(svcObj.kind)}).`,
      );
    }
    const kind = svcObj.kind as "process" | "docker";

    // kind-specific fields
    let command: string[] | undefined;
    let container: string | undefined;
    if (kind === "process") {
      if (svcObj.command === undefined) {
        throw new Error(
          `${avmConfigFile}: services.${name}.command is required when kind is "process".`,
        );
      }
      if (
        !Array.isArray(svcObj.command) ||
        svcObj.command.length === 0 ||
        !svcObj.command.every((c: unknown) => typeof c === "string")
      ) {
        throw new Error(
          `${avmConfigFile}: services.${name}.command must be a non-empty list of strings (got ${describe(svcObj.command)}).`,
        );
      }
      command = svcObj.command as string[];
    } else {
      // kind === "docker"
      if (svcObj.container === undefined) {
        throw new Error(
          `${avmConfigFile}: services.${name}.container is required when kind is "docker".`,
        );
      }
      if (typeof svcObj.container !== "string" || svcObj.container.length === 0) {
        throw new Error(
          `${avmConfigFile}: services.${name}.container must be a non-empty string (got ${describe(svcObj.container)}).`,
        );
      }
      container = svcObj.container;
    }

    // check: required
    if (svcObj.check === undefined) {
      throw new Error(
        `${avmConfigFile}: services.${name}.check is required.`,
      );
    }
    if (
      svcObj.check === null ||
      typeof svcObj.check !== "object" ||
      Array.isArray(svcObj.check)
    ) {
      throw new Error(
        `${avmConfigFile}: services.${name}.check must be a mapping (got ${describe(svcObj.check)}).`,
      );
    }
    const checkObj = svcObj.check as Record<string, unknown>;
    for (const key of Object.keys(checkObj)) {
      if (!CHECK_KEYS.has(key)) {
        console.warn(
          `${avmConfigFile}: unknown key "${key}" under services.${name}.check (ignored). Allowed: ${[...CHECK_KEYS].join(", ")}.`,
        );
      }
    }
    if (checkObj.tcp === undefined) {
      throw new Error(
        `${avmConfigFile}: services.${name}.check.tcp is required.`,
      );
    }
    if (typeof checkObj.tcp !== "string" || checkObj.tcp.length === 0) {
      throw new Error(
        `${avmConfigFile}: services.${name}.check.tcp must be a non-empty "host:port" string (got ${describe(checkObj.tcp)}).`,
      );
    }

    out[name] = { kind, command, container, check: { tcp: checkObj.tcp } };
  }
  return out;
}

function parseNotifications(raw: unknown): NotificationsConfig {
  if (raw === undefined) return structuredClone(DEFAULT_NOTIFICATIONS);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${avmConfigFile}: "notifications" must be a mapping (got ${describe(raw)}).`,
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!NOTIFICATIONS_KEYS.has(key)) {
      console.warn(
        `${avmConfigFile}: unknown key "${key}" under notifications (ignored). Allowed: ${[...NOTIFICATIONS_KEYS].join(", ")}.`,
      );
    }
  }

  const result = structuredClone(DEFAULT_NOTIFICATIONS);

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(
        `${avmConfigFile}: notifications.enabled must be a boolean (got ${describe(obj.enabled)}).`,
      );
    }
    result.enabled = obj.enabled;
  }

  if (obj.sounds !== undefined) {
    if (obj.sounds === null || typeof obj.sounds !== "object" || Array.isArray(obj.sounds)) {
      throw new Error(
        `${avmConfigFile}: notifications.sounds must be a mapping (got ${describe(obj.sounds)}).`,
      );
    }
    const sounds = obj.sounds as Record<string, unknown>;
    for (const key of Object.keys(sounds)) {
      if (!SOUND_NAMES.has(key)) {
        console.warn(
          `${avmConfigFile}: unknown key "${key}" under notifications.sounds (ignored). Allowed: ${[...SOUND_NAMES].join(", ")}.`,
        );
      }
    }
    for (const name of SOUND_NAMES) {
      const entry = sounds[name];
      if (entry === undefined) continue;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `${avmConfigFile}: notifications.sounds.${name} must be a mapping (got ${describe(entry)}).`,
        );
      }
      const e = entry as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (!SOUND_KEYS.has(key)) {
          console.warn(
            `${avmConfigFile}: unknown key "${key}" under notifications.sounds.${name} (ignored). Allowed: ${[...SOUND_KEYS].join(", ")}.`,
          );
        }
      }
      const target = result.sounds[name as "needs-attention" | "complete"];
      if (e.file !== undefined) {
        if (typeof e.file !== "string" || e.file.length === 0) {
          throw new Error(
            `${avmConfigFile}: notifications.sounds.${name}.file must be a non-empty string (got ${describe(e.file)}).`,
          );
        }
        target.file = e.file;
      }
      if (e.volume !== undefined) {
        if (typeof e.volume !== "number" || !Number.isFinite(e.volume) || e.volume < 0 || e.volume > 1) {
          throw new Error(
            `${avmConfigFile}: notifications.sounds.${name}.volume must be a number 0–1 (got ${describe(e.volume)}).`,
          );
        }
        target.volume = e.volume;
      }
    }
  }

  return result;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

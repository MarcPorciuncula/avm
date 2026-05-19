/**
 * Pure logic for installing/uninstalling AVM notification hooks in the
 * in-container Claude Code's `~/.claude/settings.json`. The host-side
 * file backing that path is whichever `volumes:` entry in
 * `~/.avm/config.yaml` maps to the container's `~/.claude`; avm itself
 * does not own or fix that path — `cli/commands/notify.ts` resolves it
 * from config.
 *
 * "AVM entries" are identified by command-prefix matching: any entry
 * whose every hooks[].command starts with `avm-bridge claude-hook ` is
 * considered AVM-managed. This is the only convention; no JSON marker
 * fields are used.
 */

export const AVM_HOOK_COMMAND_PREFIX = "avm-bridge claude-hook ";

export interface ClaudeHookCommand {
  type: string;
  command: string;
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

export interface ClaudeSettings {
  hooks?: {
    Notification?: ClaudeHookEntry[];
    Stop?: ClaudeHookEntry[];
    [key: string]: ClaudeHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const AVM_NOTIFICATION_ENTRY: ClaudeHookEntry = {
  matcher: "*",
  hooks: [{ type: "command", command: "avm-bridge claude-hook notification" }],
};

const AVM_STOP_ENTRY: ClaudeHookEntry = {
  matcher: "*",
  hooks: [{ type: "command", command: "avm-bridge claude-hook stop" }],
};

function isAvmEntry(entry: ClaudeHookEntry): boolean {
  if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) return false;
  return entry.hooks.every(
    (h) => typeof h.command === "string" && h.command.startsWith(AVM_HOOK_COMMAND_PREFIX),
  );
}

function stripAvmEntries(entries: ClaudeHookEntry[] | undefined): ClaudeHookEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => !isAvmEntry(e));
}

/** Returns a new settings object with AVM hook entries removed and the canonical AVM entries appended. */
export function installHooks(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks!;

  const notification = stripAvmEntries(hooks.Notification);
  notification.push(structuredClone(AVM_NOTIFICATION_ENTRY));
  hooks.Notification = notification;

  const stop = stripAvmEntries(hooks.Stop);
  stop.push(structuredClone(AVM_STOP_ENTRY));
  hooks.Stop = stop;

  return next;
}

/** Returns a new settings object with AVM hook entries removed (no re-add). */
export function uninstallHooks(settings: ClaudeSettings): ClaudeSettings {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks!;

  if (Array.isArray(hooks.Notification)) {
    const filtered = stripAvmEntries(hooks.Notification);
    if (filtered.length === 0) delete hooks.Notification;
    else hooks.Notification = filtered;
  }
  if (Array.isArray(hooks.Stop)) {
    const filtered = stripAvmEntries(hooks.Stop);
    if (filtered.length === 0) delete hooks.Stop;
    else hooks.Stop = filtered;
  }

  // If hooks ended up empty, drop it.
  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  }

  return next;
}

/** Count installed AVM entries across both arrays — used by `avm notify status`. */
export function countAvmEntries(settings: ClaudeSettings): number {
  let n = 0;
  for (const arr of [settings.hooks?.Notification, settings.hooks?.Stop]) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) if (isAvmEntry(entry)) n++;
  }
  return n;
}

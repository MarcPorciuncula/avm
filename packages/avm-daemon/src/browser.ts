import { spawn } from "node:child_process";
import { ConnectError, Code } from "@connectrpc/connect";

/**
 * Open a URL in the user's default browser on the host.
 *
 * Only http(s) URLs are permitted — macOS `open` will otherwise launch
 * applications and local files, which would be unsafe to expose to
 * in-container tools.
 */
export function openUrl(req: { url: string }): { url: string } {
  const url = req.url.trim();
  if (!url) {
    throw new ConnectError("url is required", Code.InvalidArgument);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectError(`invalid url: ${url}`, Code.InvalidArgument);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConnectError(
      `unsupported url scheme: ${parsed.protocol} (only http and https are allowed)`,
      Code.InvalidArgument,
    );
  }

  const child = spawn("open", [parsed.toString()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { url: parsed.toString() };
}

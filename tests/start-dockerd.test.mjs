import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Run on Linux (or in avm-core) for real flock/timeout semantics. Only Docker
// processes are mocked. Each test remaps the helper's fixed runtime paths to a
// private temporary directory; no host/container Docker state is touched.
const source = readFileSync(new URL("../templates/start-dockerd.sh", import.meta.url), "utf8");

function fixture(t, { mode = "ready", timeoutSeconds = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "avm-dockerd-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const groups = [];
  t.after(() => {
    for (const pid of groups) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  let script = source;
  for (const [from, to] of [
    ["/var/run/docker.pid", join(dir, "docker.pid")],
    ["/var/run/avm-dockerd.lock", join(dir, "startup.lock")],
    ["/var/log/dockerd.log", join(dir, "dockerd.log")],
    ["timeout_seconds=30", `timeout_seconds=${timeoutSeconds}`],
  ]) {
    assert.ok(script.includes(from), `fixture must remap ${from}`);
    script = script.replaceAll(from, to);
  }
  const scriptPath = join(dir, "start-dockerd.sh");
  writeFileSync(scriptPath, script);
  function mock(name, body) {
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  }
  mock("pidof", `
    [ "$1" = dockerd ]
    [ -f "$AVM_TEST_DIR/daemon.pid" ] || exit 1
    pid=$(cat "$AVM_TEST_DIR/daemon.pid")
    kill -0 "$pid" 2>/dev/null || exit 1
    echo "$pid"
  `);
  mock("dockerd", `
    echo launch >> "$AVM_TEST_DIR/launches"
    if [ -f "$AVM_TEST_DIR/docker.pid" ]; then
      pid=$(cat "$AVM_TEST_DIR/docker.pid")
      if kill -0 "$pid" 2>/dev/null; then
        echo "stale PID collision: $pid" >&2
        exit 1
      fi
    fi
    if [ "$AVM_TEST_MODE" = exit ]; then
      echo "synthetic daemon failure" >&2
      exit 42
    fi
    echo $$ > "$AVM_TEST_DIR/daemon.pid"
    echo $$ > "$AVM_TEST_DIR/docker.pid"
    if [ "$AVM_TEST_MODE" = ready ]; then
      sleep 0.2
      touch "$AVM_TEST_DIR/ready"
    fi
    while true; do sleep 1; done
  `);
  mock("docker", `
    [ "$*" = "--host unix:///var/run/docker.sock info" ] || exit 2
    if [ "$AVM_TEST_MODE" = hung ]; then
      trap '' TERM
      sleep 60
    fi
    [ -f "$AVM_TEST_DIR/ready" ]
  `);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AVM_TEST_DIR: dir,
    AVM_TEST_MODE: mode,
    // A caller's remote Docker endpoint must not satisfy local readiness.
    DOCKER_HOST: "tcp://unreachable.invalid:2375",
  };
  function start() {
    const child = spawn("bash", [scriptPath], { env, detached: true });
    groups.push(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    // Catch deadlocks without leaking test daemons or stalling the whole suite.
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 10_000);
    return new Promise((resolve, reject) => {
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
  function existingDaemon() {
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    groups.push(child.pid);
    writeFileSync(join(dir, "daemon.pid"), String(child.pid));
    writeFileSync(join(dir, "docker.pid"), String(child.pid));
    return child.pid;
  }
  function read(name) {
    try { return readFileSync(join(dir, name), "utf8"); } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }
  return { start, existingDaemon, read, write: (name, value = "") => writeFileSync(join(dir, name), value) };
}

test("recovers a stale PID pointing at an unrelated live process", async (t) => {
  const f = fixture(t);
  f.write("docker.pid", String(process.pid));
  const result = await f.start();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Docker daemon is ready/);
  assert.equal(f.read("launches"), "launch\n");
  assert.notEqual(f.read("docker.pid").trim(), String(process.pid));
});

test("keeps an existing healthy daemon and its PID file", async (t) => {
  const f = fixture(t);
  const pid = f.existingDaemon();
  f.write("ready");
  const result = await f.start();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.read("docker.pid"), String(pid));
  assert.equal(f.read("launches"), "");
});

test("waits for an existing daemon to become ready", async (t) => {
  const f = fixture(t);
  f.existingDaemon();
  let finished = false;
  const pending = f.start().then((result) => { finished = true; return result; });
  await delay(300);
  assert.equal(finished, false);
  f.write("ready");
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.read("launches"), "");
});

test("fails rather than reporting an unready existing daemon as ready", async (t) => {
  const f = fixture(t, { timeoutSeconds: 1 });
  const pid = f.existingDaemon();
  const result = await f.start();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /failed to become ready within 1s/);
  assert.equal(f.read("docker.pid"), String(pid));
  assert.equal(f.read("launches"), "");
});

test("reports early daemon exit and includes its log", async (t) => {
  const f = fixture(t, { mode: "exit", timeoutSeconds: 30 });
  const result = await f.start();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /exited during startup \(status 42\)/);
  assert.match(result.stderr, /synthetic daemon failure/);
  assert.doesNotMatch(result.stderr, /failed to become ready/);
});

test("bounds a hung Docker API probe even if it ignores SIGTERM", async (t) => {
  const f = fixture(t, { mode: "hung", timeoutSeconds: 1 });
  const result = await f.start();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /failed to become ready within 1s/);
});

test("serializes concurrent callers and releases the lock for later calls", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.start(), f.start()]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(f.read("launches"), "launch\n");
  const result = await f.start();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.read("launches"), "launch\n");
});

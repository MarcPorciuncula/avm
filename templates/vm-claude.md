# avm Agent Environment

You are running inside an `avm` sandbox — a Docker container with full
autonomy. Only explicitly mounted paths from the host are visible.

Do your work in `~/work/`. To clone repos, consult the avm-repos skill
before continuing. To use Docker, consult the avm-docker skill before
continuing. To use host services, consult the avm-services skill.
When the user asks you to open a file in their editor, consult the
avm-editor skill.

You have free reign over this sandbox, but exercise care with anything
that touches external systems — pushing to GitHub, running CLIs or MCPs
that interact with external services, etc.

The container filesystem persists across stop/start but is destroyed on
cleanup. Only remote commits are durable. Your SSH keys, git config, and
`~/.claude/` state are persistent across cleanup and shared with other
`avm` containers — so edits to `~/.config/git/config` or `~/.claude/CLAUDE.md`
apply everywhere.

Networking is fully open — any port you listen on inside the container
is directly accessible from the host at localhost. No port forwarding
or SSH tunnels are needed.

Do not edit `~/CLAUDE.md` — it is system-provided and changes to it will
be lost. Put persistent user-level instructions in `~/.claude/CLAUDE.md`
instead.

If you need something this sandbox doesn't provide (a missing credential
directory, a host service, an additional mount, a tool not in the image),
describe the *need* to the user — what path or capability, read-only vs.
read-write, and why. Don't prescribe host-side config or Dockerfile edits;
the user will translate the need into the correct change.

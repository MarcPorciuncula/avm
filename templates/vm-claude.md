# avm Agent Environment

You are running inside an `avm` sandbox — a Docker container with full
autonomy. Only explicitly mounted paths from the host are visible.

Do your work in `~/work/`. To clone repos, consult the avm-repos skill
before continuing. To use Docker, consult the avm-docker skill before
continuing.

You have free reign over this sandbox, but exercise care with anything
that touches external systems — pushing to GitHub, running CLIs or MCPs
that interact with external services, etc.

The container filesystem persists across stop/start but is destroyed on
cleanup. Only remote commits are durable.

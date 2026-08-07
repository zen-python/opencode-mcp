# opencode-mcp

A small, zero-dependency CLI for managing [OpenCode](https://opencode.ai)'s
MCP server config, with syntax modeled on `claude mcp add`:

```
claude mcp add -s user -t http stripe https://mcp.stripe.com
opencode-mcp add -t remote stripe https://mcp.stripe.com
```

It reads and writes the `mcp` key of your OpenCode config
(`~/.config/opencode/opencode.json` by default), following the schema
documented at https://opencode.ai/docs/mcp-servers/. It never touches any
other key already in that file, and it keeps a `.bak` copy before every
write.

## Install

```bash
cd opencode-mcp
npm link          # makes `opencode-mcp` available globally
# or just run it directly:
node bin/opencode-mcp.js --help
```

Requires Node.js 16+. No npm dependencies.

## Important: options come before the name

Like `claude mcp add`, all of opencode-mcp's own flags must be given
**before** `<name>`. Everything from `<name>` onward — the URL, or the
command and its own flags — is taken literally. That's what lets you write
things like `npx -y ...` without opencode-mcp mistaking the command's `-y`
for one of its own options.

```bash
# opencode-mcp's flags (-t, -H, -e, ...) go here ↓        ↓ then name, then url/command
opencode-mcp add           -t remote                    stripe   https://mcp.stripe.com
opencode-mcp add -H "Authorization: Bearer {env:KEY}"    my-api   https://mcp.example.com
opencode-mcp add -e KEY=value                            my-tool  -- npx -y my-mcp-command
```

## Usage

```
opencode-mcp add [options] <name> <url>                  (remote server)
opencode-mcp add [options] <name> <command> [args...]     (local server)
opencode-mcp add [options] <name> -- <command> [args...]  (local, explicit)
opencode-mcp remove <name>
opencode-mcp enable <name>
opencode-mcp disable <name>
opencode-mcp list
opencode-mcp add-json [options] <name> '<json>'
opencode-mcp ai [options] <name> [description]
```

Type (`local` vs `remote`) is auto-detected: an `http(s)://` first argument
means remote, anything else means local. Use `-t/--type` to force it.

### `add` options

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `-t, --type <local|remote>` | both | force server type |
| `-e, --env KEY=VALUE` (repeatable) | local | environment variable |
| `-H, --header "Key: Value"` (repeatable) | remote | HTTP header |
| `--cwd <dir>` | local | working directory |
| `--timeout <ms>` | both | tool-fetch timeout (default 5000) |
| `--oauth` | remote | enable OAuth auto-detection (default) |
| `--no-oauth` | remote | disable OAuth (e.g. API-key servers) |
| `--oauth-client-id/-secret/-scope` | remote | pre-registered OAuth client |
| `--disabled` / `--enabled` | both | initial `enabled` state (default: enabled) |
| `-g, --global` | — | write to `~/.config/opencode/opencode.json` (default) |
| `-p, --project` | — | write to `./opencode.json` instead |
| `--config <path>` | — | write to an arbitrary file |
| `-f, --force` | — | overwrite an existing entry with this name |
| `--dry-run` | — | print the JSON, don't write it |

### Examples

```bash
# Remote server (Stripe)
opencode-mcp add -t remote stripe https://mcp.stripe.com

# Remote, type auto-detected from the https:// URL
opencode-mcp add sentry https://mcp.sentry.dev/mcp

# Remote with a header (e.g. an API key)
opencode-mcp add -H "CONTEXT7_API_KEY: {env:CONTEXT7_API_KEY}" \
    context7 https://mcp.context7.com/mcp

# Remote with pre-registered OAuth
opencode-mcp add --oauth-client-id "{env:MY_MCP_CLIENT_ID}" \
    --oauth-client-secret "{env:MY_MCP_CLIENT_SECRET}" \
    my-oauth-server https://mcp.example.com/mcp

# Remote, API-key style (disable OAuth auto-detection)
opencode-mcp add --no-oauth -H "Authorization: Bearer {env:MY_API_KEY}" \
    my-api-key-server https://mcp.example.com

# Local server via npx
opencode-mcp add my-server -- npx -y @modelcontextprotocol/server-everything

# Local server with an env var, via bun
opencode-mcp add -e MY_ENV_VAR=my_env_var_value my-server -- bun x my-mcp-command

# Write to the project-local opencode.json instead of the global one
opencode-mcp add -p linear https://mcp.linear.app/mcp

# See what's configured
opencode-mcp list

# Toggle / remove
opencode-mcp disable stripe
opencode-mcp enable stripe
opencode-mcp remove stripe
```

`{env:VAR_NAME}` is OpenCode's own placeholder syntax for pulling a value
from an environment variable at runtime (see the docs) — opencode-mcp
writes it verbatim, it does not resolve it itself.

## `ai`: look up the right config with OpenAI

If you don't know the exact npx package name or remote URL for a server,
`opencode-mcp ai` can ask an OpenAI model (with web search unless --no-search) to
figure it out, show you the proposed JSON, and ask for confirmation before
writing anything.

```bash
export OPENAI_API_KEY=sk-...
opencode-mcp ai stripe "Stripe's official MCP server"
opencode-mcp ai linear
```

Options: `--model <name>` (default `gpt-4.1`, or set `OPENCODE_MCP_AI_MODEL`),
`--no-search`, `-y/--yes` to skip confirmation, plus the same
`-g/-p/--config/-f/--dry-run` as `add`.

## Notes
- The tool preserves every other key in your `opencode.json` — it only ever
  reads and writes `config.mcp`.
- A `.bak` copy of the config is written before every save.
- Minimal JSONC (`//` and `/* */` comments, trailing commas) is tolerated
  when *reading* an existing config, but output is always written as plain
  JSON.
- Manual OAuth flows (`opencode mcp auth <name>`, `opencode mcp list`,
  `opencode mcp logout <name>`) are OpenCode's own commands — this tool only
  edits the config file, it doesn't perform the OAuth dance itself.

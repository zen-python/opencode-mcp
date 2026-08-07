#!/usr/bin/env node
/**
 * opencode-mcp — manage OpenCode's `mcp` config entries with a CLI syntax
 * similar to `claude mcp add ...`.
 *
 * Config target (per https://opencode.ai/docs/mcp-servers/):
 *   ~/.config/opencode/opencode.json   (--global, default)
 *   ./opencode.json                    (--project)
 *   <custom path>                      (--config <path>)
 *
 * Only the `mcp` key (and, for `disable`, the `tools` key) is ever touched.
 * Every other key already in the file is preserved untouched.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');

const VERSION = '1.11.1';
const SCHEMA_URL = 'https://opencode.ai/config.json';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function die(msg, code = 1) {
  process.stderr.write(`opencode-mcp: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function isUrl(str) {
  return /^https?:\/\//i.test(str);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Config file location + load/save (non-destructive merge)
// ---------------------------------------------------------------------------

function defaultGlobalPath() {
  // Respect XDG_CONFIG_HOME if set, otherwise ~/.config
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode', 'opencode.json');
}

function resolveConfigPath(opts) {
  if (opts.configPath) return path.resolve(opts.configPath);
  if (opts.project) return path.resolve(process.cwd(), 'opencode.json');
  return defaultGlobalPath();
}

function stripJsonComments(text) {
  // Minimal JSONC support (// and /* */ comments, not inside strings) so that
  // a hand-edited opencode.jsonc-style file with comments doesn't hard-fail.
  let out = '';
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // consumed the closing '/'
      continue;
    }
    out += c;
  }
  // strip trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { $schema: SCHEMA_URL };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  if (!raw.trim()) return { $schema: SCHEMA_URL };
  try {
    return JSON.parse(raw);
  } catch (e1) {
    try {
      return JSON.parse(stripJsonComments(raw));
    } catch (e2) {
      die(
        `could not parse existing config at ${configPath}\n` +
          `  ${e2.message}\n` +
          `Fix the JSON manually, or point elsewhere with --config <path>.`
      );
    }
  }
}

function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }

  const json = JSON.stringify(config, null, 2) + '\n';
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, configPath);
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/**
 * Small flag parser, git/claude-style: recognized options must come BEFORE
 * the positional arguments. The moment we hit the first token that isn't
 * one of our known flags (typically the server <name>), flag-parsing stops
 * and everything from there on -- including anything that looks like a flag
 * -- is treated as a literal positional/command token. This is what lets
 * `opencode-mcp add my-server npx -y some-package` work without the
 * command's own `-y` being swallowed by our parser.
 *
 * A leading `--` right after the recognized options is optional but
 * supported for clarity; it's simply skipped.
 *
 * Returns { flags: {name: value|true, ...(arrays for repeatable)},
 * positionals: [...] }.
 */
function parseArgs(argv, spec) {
  const flags = {};
  let i = 0;

  for (; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '--') {
      i++;
      break;
    }

    let matched = null;
    let inlineValue = null;

    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      if (eq !== -1) inlineValue = tok.slice(eq + 1);
      matched = spec.long[name];
      if (!matched) die(`unknown option --${name}`);
      matched = { ...matched, canonical: matched.canonical || name };
    } else if (tok.startsWith('-') && tok.length > 1 && tok !== '-') {
      const short = tok.slice(1, 2);
      if (tok.length > 2) inlineValue = tok.slice(2);
      matched = spec.short[short];
      if (!matched) die(`unknown option -${short}`);
    } else {
      // First non-flag token: stop parsing flags, everything remaining
      // (this token included) is positional/command data.
      break;
    }

    const key = matched.canonical;
    if (matched.type === 'boolean') {
      flags[key] = true;
    } else {
      let value = inlineValue;
      if (value === null) {
        value = argv[i + 1];
        if (value === undefined) die(`option --${key} requires a value`);
        i++;
      }
      if (matched.repeatable) {
        flags[key] = flags[key] || [];
        flags[key].push(value);
      } else {
        flags[key] = value;
      }
    }
  }

  const positionals = argv.slice(i);
  return { flags, positionals };
}

function kvToObject(list, sep, label) {
  const out = {};
  for (const item of list || []) {
    const idx = item.indexOf(sep);
    if (idx === -1) die(`expected KEY${sep}VALUE for ${label}, got "${item}"`);
    out[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const ADD_SPEC = {
  long: {
    type: { canonical: 'type' },
    env: { canonical: 'env', repeatable: true },
    header: { canonical: 'header', repeatable: true },
    cwd: { canonical: 'cwd' },
    timeout: { canonical: 'timeout' },
    oauth: { canonical: 'oauth', type: 'boolean' },
    'no-oauth': { canonical: 'noOauth', type: 'boolean' },
    'oauth-client-id': { canonical: 'oauthClientId' },
    'oauth-client-secret': { canonical: 'oauthClientSecret' },
    'oauth-scope': { canonical: 'oauthScope' },
    disabled: { canonical: 'disabled', type: 'boolean' },
    enabled: { canonical: 'enabled', type: 'boolean' },
    global: { canonical: 'global', type: 'boolean' },
    project: { canonical: 'project', type: 'boolean' },
    config: { canonical: 'configPath' },
    force: { canonical: 'force', type: 'boolean' },
    'dry-run': { canonical: 'dryRun', type: 'boolean' },
    help: { canonical: 'help', type: 'boolean' },
  },
  short: {
    t: { canonical: 'type' },
    e: { canonical: 'env', repeatable: true },
    H: { canonical: 'header', repeatable: true },
    g: { canonical: 'global', type: 'boolean' },
    p: { canonical: 'project', type: 'boolean' },
    f: { canonical: 'force', type: 'boolean' },
    h: { canonical: 'help', type: 'boolean' },
  },
};

const ADD_JSON_SPEC = {
  long: {
    global: { canonical: 'global', type: 'boolean' },
    project: { canonical: 'project', type: 'boolean' },
    config: { canonical: 'configPath' },
    force: { canonical: 'force', type: 'boolean' },
    'dry-run': { canonical: 'dryRun', type: 'boolean' },
    enabled: { canonical: 'enabled', type: 'boolean' },
    disabled: { canonical: 'disabled', type: 'boolean' },
    help: { canonical: 'help', type: 'boolean' },
  },
  short: {
    g: { canonical: 'global', type: 'boolean' },
    p: { canonical: 'project', type: 'boolean' },
    f: { canonical: 'force', type: 'boolean' },
    h: { canonical: 'help', type: 'boolean' },
  },
};

function printAddHelp() {
  info(`Usage:
  opencode-mcp add [options] <name> <url>                  (remote)
  opencode-mcp add [options] <name> <command> [args...]     (local)
  opencode-mcp add [options] <name> -- <command> [args...]  (local, explicit)

IMPORTANT: like "claude mcp add", all opencode-mcp OPTIONS must come
BEFORE <name>. Everything from <name> onward is taken literally, so a
command's own flags (npx -y, etc.) are never mistaken for opencode-mcp's
own options.

Options:
  -t, --type <local|remote>   Force server type (auto-detected from the
                               command/url otherwise: a http(s):// URL is
                               treated as remote, anything else as local)
  -e, --env KEY=VALUE         Environment variable for a local server
                               (repeatable)
  -H, --header "Key: Value"   HTTP header for a remote server (repeatable)
      --cwd <dir>             Working directory for a local server
      --timeout <ms>          Tool-fetch timeout in ms (default: 5000)
      --oauth                 Enable OAuth auto-detection (remote; this is
                               already the default unless --no-oauth is set)
      --no-oauth              Disable OAuth auto-detection (e.g. for servers
                               that use an API-key header instead)
      --oauth-client-id <id>
      --oauth-client-secret <secret>
      --oauth-scope <scope>   Pre-registered OAuth client config
      --disabled              Add the server with "enabled": false
      --enabled               Add the server with "enabled": true (default)
  -g, --global                 Write to ~/.config/opencode/opencode.json (default)
  -p, --project                 Write to ./opencode.json instead
      --config <path>          Write to an arbitrary config file
  -f, --force                   Overwrite an existing entry with this name
      --dry-run                 Print the resulting JSON, don't write it

Examples:
  opencode-mcp add -t remote stripe https://mcp.stripe.com
  opencode-mcp add sentry https://mcp.sentry.dev/mcp
  opencode-mcp add -H "CONTEXT7_API_KEY: {env:CONTEXT7_API_KEY}" \\
      context7 https://mcp.context7.com/mcp
  opencode-mcp add my-server -- npx -y @modelcontextprotocol/server-everything
  opencode-mcp add -e MY_ENV_VAR=value my-server -- bun x my-mcp-command
`);
}

function printAddJsonHelp() {
  info(`Usage:
  opencode-mcp add-json [options] <name> '<json>'

Writes the provided JSON verbatim into config.mcp[<name>] (no translation).
The JSON must already be in OpenCode MCP entry shape.

Options:
  -g, --global                 Write to ~/.config/opencode/opencode.json (default)
  -p, --project                 Write to ./opencode.json instead
      --config <path>          Write to an arbitrary config file
  -f, --force                   Overwrite an existing entry with this name
      --dry-run                 Print the resulting JSON, don't write it
      --enabled                 Set "enabled": true (overrides JSON)
      --disabled                Set "enabled": false (overrides JSON)

Example:
  opencode-mcp add-json github '{"type":"remote","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer YOUR_GITHUB_PAT"}}'
`);
}

function buildLocalEntry(flags, command) {
  if (!command.length) die('local server needs a command, e.g. "npx -y my-mcp-command" (put it after -- )');
  const entry = { type: 'local', command };
  if (flags.cwd) entry.cwd = flags.cwd;
  if (flags.env) entry.environment = kvToObject(flags.env, '=', '--env');
  if (flags.timeout) entry.timeout = Number(flags.timeout);
  entry.enabled = flags.disabled ? false : true;
  return entry;
}

function buildRemoteEntry(flags, url) {
  const entry = { type: 'remote', url };
  if (flags.header) entry.headers = kvToObject(flags.header, ':', '--header');
  if (flags.timeout) entry.timeout = Number(flags.timeout);
  entry.enabled = flags.disabled ? false : true;

  if (flags.noOauth) {
    entry.oauth = false;
  } else if (flags.oauthClientId || flags.oauthClientSecret || flags.oauthScope) {
    entry.oauth = {};
    if (flags.oauthClientId) entry.oauth.clientId = flags.oauthClientId;
    if (flags.oauthClientSecret) entry.oauth.clientSecret = flags.oauthClientSecret;
    if (flags.oauthScope) entry.oauth.scope = flags.oauthScope;
  } else if (flags.oauth) {
    entry.oauth = {};
  }
  return entry;
}

function cmdAdd(argv) {
  const { flags, positionals } = parseArgs(argv, ADD_SPEC);
  if (flags.help || positionals.length === 0) {
    printAddHelp();
    process.exit(flags.help ? 0 : 1);
  }

  const name = positionals[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    die(`server name "${name}" should only contain letters, numbers, "-" and "_"`);
  }

  // Everything after <name> identifies the server: a single URL (remote),
  // or a command + its args (local). An optional literal "--" right after
  // <name> is accepted as an explicit separator and stripped.
  const tail = positionals.slice(1);
  if (tail[0] === '--') tail.shift();
  if (tail.length === 0) {
    die(`missing <url> or <command> for "${name}". See --help.`);
  }

  let type = flags.type;
  if (type && type !== 'local' && type !== 'remote') {
    die(`--type must be "local" or "remote", got "${type}"`);
  }
  if (!type) type = isUrl(tail[0]) ? 'remote' : 'local';

  let entry;
  if (type === 'remote') {
    if (!isUrl(tail[0])) die(`--type remote needs a http(s):// URL, got "${tail[0]}"`);
    if (tail.length > 1) die(`too many arguments for a remote server: ${tail.slice(1).join(' ')}`);
    entry = buildRemoteEntry(flags, tail[0]);
  } else {
    entry = buildLocalEntry(flags, tail);
  }

  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  config.mcp = config.mcp || {};

  if (config.mcp[name] && !flags.force) {
    die(`"${name}" already exists in ${configPath}. Use --force to overwrite, or "opencode-mcp remove ${name}" first.`);
  }

  config.mcp[name] = entry;

  if (flags.dryRun) {
    info(JSON.stringify({ [name]: entry }, null, 2));
    return;
  }

  saveConfig(configPath, config);
  info(`Added "${name}" (${type}) to ${configPath}`);
  if (type === 'remote' && entry.oauth !== false) {
    info(`If this server needs auth, run: opencode mcp auth ${name}`);
  }
}

function cmdAddJson(argv) {
  const { flags, positionals } = parseArgs(argv, ADD_JSON_SPEC);
  if (flags.help || positionals.length < 2) {
    printAddJsonHelp();
    process.exit(flags.help ? 0 : 1);
  }

  const name = positionals[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    die(`server name "${name}" should only contain letters, numbers, "-" and "_"`);
  }

  const jsonRaw = positionals[1];
  let entry;
  try {
    entry = JSON.parse(jsonRaw);
  } catch (e) {
    die(`invalid JSON for "${name}": ${e.message}`);
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    die(`JSON for "${name}" must be a non-null object`);
  }
  if (entry.type !== 'local' && entry.type !== 'remote') {
    die(`JSON for "${name}" must include "type" as "local" or "remote"`);
  }

  // Flags override JSON; otherwise preserve JSON, and default to true if absent.
  if (flags.enabled) entry.enabled = true;
  else if (flags.disabled) entry.enabled = false;
  else if (entry.enabled === undefined) entry.enabled = true;

  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  config.mcp = config.mcp || {};

  if (config.mcp[name] && !flags.force) {
    die(`"${name}" already exists in ${configPath}. Use --force to overwrite.`);
  }

  config.mcp[name] = entry;

  if (flags.dryRun) {
    info(JSON.stringify({ [name]: entry }, null, 2));
    return;
  }

  saveConfig(configPath, config);
  info(`Added "${name}" to ${configPath}`);
}

const SIMPLE_SPEC = {
  long: {
    global: { canonical: 'global', type: 'boolean' },
    project: { canonical: 'project', type: 'boolean' },
    config: { canonical: 'configPath' },
    help: { canonical: 'help', type: 'boolean' },
  },
  short: {
    g: { canonical: 'global', type: 'boolean' },
    p: { canonical: 'project', type: 'boolean' },
    h: { canonical: 'help', type: 'boolean' },
  },
};

function cmdRemove(argv) {
  const { flags, positionals } = parseArgs(argv, SIMPLE_SPEC);
  const name = positionals[0];
  if (!name || flags.help) {
    info('Usage: opencode-mcp remove [-g|-p|--config <path>] <name>');
    process.exit(name ? 0 : 1);
  }
  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  if (!config.mcp || !config.mcp[name]) {
    die(`"${name}" not found in ${configPath}`);
  }
  delete config.mcp[name];
  saveConfig(configPath, config);
  info(`Removed "${name}" from ${configPath}`);
}

function setEnabled(argv, enabled) {
  const { flags, positionals } = parseArgs(argv, SIMPLE_SPEC);
  const name = positionals[0];
  if (!name || flags.help) {
    info(`Usage: opencode-mcp ${enabled ? 'enable' : 'disable'} [-g|-p|--config <path>] <name>`);
    process.exit(name ? 0 : 1);
  }
  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  if (!config.mcp || !config.mcp[name]) {
    die(`"${name}" not found in ${configPath}`);
  }
  config.mcp[name].enabled = enabled;
  saveConfig(configPath, config);
  info(`${enabled ? 'Enabled' : 'Disabled'} "${name}" in ${configPath}`);
}

function cmdList(argv) {
  const { flags } = parseArgs(argv, SIMPLE_SPEC);
  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  const mcp = config.mcp || {};
  const names = Object.keys(mcp);

  info(`Config: ${configPath}`);
  if (names.length === 0) {
    info('(no MCP servers configured)');
    return;
  }
  for (const name of names) {
    const e = mcp[name];
    const enabled = e.enabled === false ? 'disabled' : 'enabled';
    if (e.type === 'remote') {
      info(`  ${name}  [remote, ${enabled}]  ${e.url}`);
    } else {
      info(`  ${name}  [local, ${enabled}]  ${(e.command || []).join(' ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// `ai` command — ask an OpenAI model (with web search) for the right config
// ---------------------------------------------------------------------------

function openaiResponsesRequest(body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) die('OPENAI_API_KEY is not set. Export it to use "opencode-mcp ai".');

  const payload = JSON.stringify(body);
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/responses',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${apiKey}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenAI API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Could not parse OpenAI response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }
  const parts = [];
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n');
}

function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const AI_SPEC = {
  long: {
    model: { canonical: 'model' },
    'no-search': { canonical: 'noSearch', type: 'boolean' },
    yes: { canonical: 'yes', type: 'boolean' },
    global: { canonical: 'global', type: 'boolean' },
    project: { canonical: 'project', type: 'boolean' },
    config: { canonical: 'configPath' },
    force: { canonical: 'force', type: 'boolean' },
    'dry-run': { canonical: 'dryRun', type: 'boolean' },
    help: { canonical: 'help', type: 'boolean' },
  },
  short: {
    y: { canonical: 'yes', type: 'boolean' },
    g: { canonical: 'global', type: 'boolean' },
    p: { canonical: 'project', type: 'boolean' },
    f: { canonical: 'force', type: 'boolean' },
    h: { canonical: 'help', type: 'boolean' },
  },
};

async function cmdAi(argv) {
  const { flags, positionals } = parseArgs(argv, AI_SPEC);
  const name = positionals[0];
  const description = positionals.slice(1).join(' ');

  if (!name || flags.help) {
    info(`Usage: opencode-mcp ai [options] <name> [description]

Looks up (via OpenAI, with web search unless --no-search) the correct
OpenCode "mcp" config entry for a named server -- e.g. its npx command, or
its remote URL -- and asks you to confirm before writing it.

Requires OPENAI_API_KEY in the environment.

Options:
  --model <name>   OpenAI model to use (default: gpt-4.1, override with
                    OPENCODE_MCP_AI_MODEL env var)
  --no-search      Don't use the web_search tool (rely on model knowledge
                    only -- faster, but more likely to be stale/wrong)
  -y, --yes        Skip the confirmation prompt
  -g/-p/--config   Same as "add"
  -f, --force      Overwrite an existing entry
  --dry-run        Print the resulting JSON, don't write it

Example:
  opencode-mcp ai stripe "Stripe's official MCP server"
  opencode-mcp ai linear
`);
    process.exit(name ? 0 : 1);
  }

  const model = flags.model || process.env.OPENCODE_MCP_AI_MODEL || 'gpt-4.1';

  const instructions = `You are configuring an MCP (Model Context Protocol) server entry for the
OpenCode CLI (https://opencode.ai/docs/mcp-servers/). Given a server name
and optional description, find the correct real-world way to run/connect to
that MCP server, then respond with ONLY a single JSON object (no prose, no
markdown fences) matching one of these two shapes:

Local server (spawned as a subprocess, e.g. via npx/bunx):
{"type":"local","command":["npx","-y","<real-package-name>"],"environment":{"OPTIONAL_KEY":"placeholder-or-{env:VAR}"}}

Remote server (hosted, reached over HTTP):
{"type":"remote","url":"https://real-hostname/real-path","headers":{"OPTIONAL_HEADER":"{env:VAR}"}}`;

  const input = `MCP server name: ${name}\n${description ? `Description: ${description}` : '(no extra description given)'}`;

  const body = { model, instructions, input };
  if (!flags.noSearch) {
    body.tools = [{ type: 'web_search' }];
  }

  info(`Asking ${model}${flags.noSearch ? '' : ' (with web search)'} for the "${name}" MCP config...`);

  let response;
  try {
    response = await openaiResponsesRequest(body);
  } catch (e) {
    die(`OpenAI request failed: ${e.message}`);
  }

  const text = extractOutputText(response);
  const parsed = extractJsonObject(text);
  if (!parsed || !parsed.type) {
    die(`Could not get a usable config from the model. Raw output:\n${text}`);
  }

  if (parsed.confidence === 'low') {
    info(`Note: the model is not fully confident about this one.${parsed.note ? ` ${parsed.note}` : ''}`);
  }

  const entry = { type: parsed.type };
  if (parsed.type === 'local') {
    if (!Array.isArray(parsed.command) || !parsed.command.length) {
      die(`Model returned a local entry with no command:\n${JSON.stringify(parsed, null, 2)}`);
    }
    entry.command = parsed.command;
    if (parsed.environment) entry.environment = parsed.environment;
    if (parsed.cwd) entry.cwd = parsed.cwd;
  } else if (parsed.type === 'remote') {
    if (!parsed.url || !isUrl(parsed.url)) {
      die(`Model returned a remote entry with no valid url:\n${JSON.stringify(parsed, null, 2)}`);
    }
    entry.url = parsed.url;
    if (parsed.headers) entry.headers = parsed.headers;
    if (parsed.oauth !== undefined) entry.oauth = parsed.oauth;
  } else {
    die(`Model returned an unknown type "${parsed.type}"`);
  }
  entry.enabled = true;

  info(`\nProposed config for "${name}":`);
  info(JSON.stringify({ [name]: entry }, null, 2));

  if (!flags.yes) {
    const answer = await ask('\nWrite this to your OpenCode config? [y/N] ');
    if (!/^y(es)?$/i.test(answer)) {
      info('Aborted, nothing written.');
      return;
    }
  }

  const configPath = resolveConfigPath(flags);
  const config = loadConfig(configPath);
  config.mcp = config.mcp || {};
  if (config.mcp[name] && !flags.force) {
    die(`"${name}" already exists in ${configPath}. Use --force to overwrite.`);
  }
  config.mcp[name] = entry;

  if (flags.dryRun) return;

  saveConfig(configPath, config);
  info(`Added "${name}" to ${configPath}`);
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function printMainHelp() {
  info(`opencode-mcp v${VERSION}

Manage OpenCode MCP server entries (~/.config/opencode/opencode.json by
default) without hand-editing JSON, similar in spirit to "claude mcp add".

Usage:
  opencode-mcp add [options] <name> <url|command...>
  opencode-mcp add-json [options] <name> '<json>'
  opencode-mcp remove <name>
  opencode-mcp enable <name>
  opencode-mcp disable <name>
  opencode-mcp list
  opencode-mcp ai [options] <name> [description]

Run "opencode-mcp <command> --help" for command-specific options.
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'add':
      cmdAdd(rest);
      break;
    case 'add-json':
      cmdAddJson(rest);
      break;
    case 'remove':
    case 'rm':
      cmdRemove(rest);
      break;
    case 'enable':
      setEnabled(rest, true);
      break;
    case 'disable':
      setEnabled(rest, false);
      break;
    case 'list':
    case 'ls':
      cmdList(rest);
      break;
    case 'ai':
      await cmdAi(rest);
      break;
    case '--version':
    case '-v':
      info(VERSION);
      break;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printMainHelp();
      process.exit(cmd === undefined ? 1 : 0);
      break;
    default:
      die(`unknown command "${cmd}". Run "opencode-mcp --help".`);
  }
}

main().catch((e) => die(e.stack || e.message));

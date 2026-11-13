# PPM Common Tasks

Practical recipes for controlling PPM. Prefer these stable shell invocations over HTTP unless the user has specifically asked for HTTP.

## Task 1: Confirm PPM is running

```bash
ppm status --json | jq '{running, healthy, port, state}'
```

`ppm status` exits 0 either way: `running` says whether PPM is up, `healthy` whether it answered on `port`.
Use `ppm status` (no flag) for a human-readable view.

## Task 2: Start the server

```bash
# Port from config (8080 unless changed)
ppm start

# Override port
ppm start --port 9090

# Use a separate config DB (~/.ppm/ppm.dev.db, with its own port setting)
ppm start --profile dev
```

`ppm restart`, `ppm stop`, `ppm down` and `ppm upgrade` cut every running PPM chat. Ask the user first.

## Task 3: Register a project

```bash
# Add the current directory
ppm projects add "$PWD"

# Under a name of your choice
ppm projects add /abs/path/to/app --name my-app

# List registered projects
ppm projects list
```

## Task 4: Add and test a database connection

```bash
# PostgreSQL (see `ppm db add --help` for every flag)
ppm db add --name staging --type postgres --connection-string "postgres://app:secret@db.example.com:5432/myapp"

# MySQL / MariaDB need their driver, installed once
ppm db driver install mysql
ppm db add --name shop --type mysql --connection-string "mysql://app:secret@db.example.com:3306/shop"

# SQLite takes an absolute file path
ppm db add --name local --type sqlite --file /abs/path/to/app.db

# Test the connection
ppm db test staging
```

## Task 5: Query a saved DB connection

Inside a PPM chat, use the `db_query` tool (and `db_execute` for a change, which the user
approves). `ppm db query` refuses there and names the tool, because the CLI obeys neither the
per-tool switch in Settings → Tools nor the approval. Claude, Codex and Antigravity chats all have
the tools.

Outside PPM, the CLI runs. First check which connections the user has made available to an AI —
the ones this hides are not yours to open — and ask before any write:

```bash
PPM_AI_CHAT=1 ppm db list

# Run a SQL query against a registered connection
ppm db query staging "SELECT count(*) AS total FROM users"

# Output as JSON for scripting
ppm db query staging "SELECT id, email FROM users LIMIT 10" --json
```

## Task 6: Read or change config

```bash
# Read a value (secrets such as auth.token are never printed)
ppm config get port
ppm config get auth.enabled

# Set a value (takes effect on next restart)
ppm config set port 9090
```

## Task 7: Tail the daemon log

```bash
# Last 100 lines
ppm logs --tail 100

# Errors only
ppm logs --level error

# Follow live
ppm logs -f

# Clear the log
ppm logs --clear
```

## Task 8: Upgrade PPM

```bash
# Check for a new version without installing
ppm upgrade --check

# Install the latest (restarts PPM)
ppm upgrade
```

## Task 9: Manage auto-start on boot

```bash
ppm autostart enable              # register
ppm autostart status --json       # inspect
ppm autostart disable             # unregister
```

## Task 10: Inspect installed skills

```bash
ppm skills list
ppm skills list --json
```

## Task 11: Hand a task to a PPM chat

```bash
# Prints "Created session: <id>"
ppm chat create -p my-app

# Streams the reply to stdout
ppm chat send <session-id> "Run the tests and summarise the failures"

ppm chat list -p my-app
```

## Task 12: Git in a registered project

`-p` can be left out when the current directory is inside the project.

```bash
ppm git status -p my-app
ppm git log -p my-app -n 5
ppm git diff -p my-app
ppm git stage -p my-app src/app.ts
ppm git commit -p my-app -m "fix: handle empty input"
```

## Task 13: Scheduled agents

```bash
ppm schedule list
ppm schedule add --name nightly --cron "0 2 * * *" --project my-app --prompt "Update dependencies and run the tests"
ppm schedule run-now <id>         # needs a running PPM
ppm schedule runs <id>
```

## Task 14: Back up or restore the config DB

```bash
ppm backup                        # snapshot now
ppm restore --list                # available snapshots
ppm restore <backup>              # stop PPM first
```

## HTTP API Quick Calls

The token is the user's PPM access password — ask them for it. See [http-api.md](http-api.md) for the full list.

```bash
PPM_BASE="http://localhost:$(ppm status --json | jq -r .port)"
AUTH="Authorization: Bearer $PPM_TOKEN"

# Check the token
curl -s -H "$AUTH" $PPM_BASE/api/auth/check

# List projects over HTTP
curl -s -H "$AUTH" $PPM_BASE/api/projects | jq .data

# List DB connections
curl -s -H "$AUTH" $PPM_BASE/api/db/connections | jq .data
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `ppm: command not found` | Ensure `npm i -g @hienlh/ppm` ran; check `$PATH` includes npm bin. |
| Server won't start | `ppm logs --tail 50`; check port conflict with `lsof -i :8080`. |
| `"state": "paused"` in `ppm status --json` | It crashed repeatedly: `ppm logs --level error`, then `ppm restart --force`. |
| `401 Unauthorized` from the API | Send `Authorization: Bearer <token>`; ask the user for the token. Do not turn auth off. |

## Exit Code Convention

- `0` — success (`ppm status` included, whether or not PPM runs)
- non-zero — failure; the reason is on stderr

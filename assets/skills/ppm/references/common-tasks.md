# PPM Common Tasks

Practical recipes for controlling PPM. Prefer these stable shell invocations over HTTP unless the user has specifically asked for HTTP.

## Task 1: Confirm PPM is running

```bash
ppm status --json
```

Non-zero exit = server not running. Use `ppm status` (no flag) for a human-readable view.

## Task 2: Start the server

```bash
# Default port (from config, usually 8080)
ppm start

# Override port
ppm start --port 9090

# Use dev DB profile (port 8081, ~/.ppm/ppm.dev.db)
ppm start --profile dev
```

## Task 3: Register a project

```bash
# Add the current directory
ppm projects add "$PWD"

# List registered projects as JSON
ppm projects list --json
```

## Task 4: Add and test a database connection

```bash
# Interactive add
ppm db add

# Non-interactive (check `ppm db add --help` for full flag list)
ppm db add --name staging --type postgres --host db.example.com --port 5432 --user app --database myapp

# Test the connection
ppm db test staging
```

## Task 5: Query a saved DB connection

```bash
# Run a SQL query against a registered connection
ppm db query staging "SELECT count(*) AS total FROM users"

# Output as JSON for scripting
ppm db query staging "SELECT id, email FROM users LIMIT 10" --json
```

## Task 6: Read or change config

```bash
# Read a value
ppm config get port
ppm config get auth.enabled

# Set a value (takes effect on next restart)
ppm config set port 9090
ppm config set auth.enabled true

# List all keys
ppm config list
```

## Task 7: Tail the daemon log

```bash
# Last 100 lines
ppm logs --tail 100

# Follow live
ppm logs -f

# Clear the log
ppm logs --clear
```

## Task 8: Upgrade PPM

```bash
# Check for a new version without installing
ppm upgrade --check

# Install the latest
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

## HTTP API Quick Calls

Assume `PPM_BASE=http://localhost:8080`. See [http-api.md](http-api.md) for full list.

```bash
# List projects over HTTP
curl -s $PPM_BASE/api/projects | jq

# List DB connections
curl -s $PPM_BASE/api/db/connections | jq

# Get server status (via CLI is easier; HTTP equivalent varies)
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `ppm: command not found` | Ensure `npm i -g @hienlh/ppm` ran; check `$PATH` includes npm bin. |
| Server won't start | `ppm logs --tail 50`; check port conflict with `lsof -i :8080`. |
| Stale tunnel URL | `ppm restart --force`. |
| Auth prompts unexpected | `ppm config get auth.enabled`; toggle with `ppm config set auth.enabled false`. |

## Exit Code Convention

- `0` — success
- `1` — generic error (IO, validation, server not running)
- `2` — asset/setup missing (e.g. bundled skill assets)

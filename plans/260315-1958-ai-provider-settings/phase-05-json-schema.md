---
phase: 5
title: "JSON Schema for yaml autocomplete"
status: complete
effort: 30m
depends_on: [2]
---

# Phase 5: JSON Schema

## Overview
Create a JSON Schema for `ppm.yaml` so editors (VS Code, JetBrains) provide autocomplete and validation. Add schema comment to generated yaml files.

## Files to Create
- `schemas/ppm-config.schema.json`

## Files to Edit
- `src/services/config.service.ts` — prepend schema comment when writing yaml

## Implementation Steps

1. **Create `schemas/ppm-config.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PPM Configuration",
  "description": "Configuration file for PPM (Project & Process Manager)",
  "type": "object",
  "properties": {
    "port": {
      "type": "integer",
      "default": 8080,
      "description": "Server port"
    },
    "host": {
      "type": "string",
      "default": "0.0.0.0",
      "description": "Server bind address"
    },
    "auth": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": true },
        "token": { "type": "string" }
      }
    },
    "projects": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "name": { "type": "string" }
        },
        "required": ["path", "name"]
      }
    },
    "ai": {
      "type": "object",
      "properties": {
        "default_provider": { "type": "string", "default": "claude" },
        "providers": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/AIProviderConfig"
          }
        }
      }
    }
  },
  "$defs": {
    "AIProviderConfig": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": ["agent-sdk", "mock"]
        },
        "api_key_env": { "type": "string" },
        "model": {
          "type": "string",
          "description": "Model ID (e.g. claude-sonnet-4-6, claude-opus-4-6)",
          "examples": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]
        },
        "effort": {
          "type": "string",
          "enum": ["low", "medium", "high", "max"],
          "default": "high"
        },
        "max_turns": {
          "type": "integer",
          "minimum": 1,
          "maximum": 500,
          "default": 100
        },
        "max_budget_usd": {
          "type": "number",
          "minimum": 0.01,
          "maximum": 50
        },
        "thinking_budget_tokens": {
          "type": "integer",
          "minimum": 0,
          "description": "0 = disabled"
        }
      },
      "required": ["type"]
    }
  }
}
```

2. **Update `configService.save()`** to prepend schema comment

In `src/services/config.service.ts`, update the `save()` method:

```typescript
save(): void {
  const dir = dirname(this.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const yamlContent = yaml.dump(this.config);
  const schemaComment = "# yaml-language-server: $schema=https://raw.githubusercontent.com/.../schemas/ppm-config.schema.json\n";
  // Only prepend if not already present in existing file
  const existing = existsSync(this.configPath) ? readFileSync(this.configPath, "utf-8") : "";
  const hasSchema = existing.startsWith("# yaml-language-server:");
  const content = hasSchema ? schemaComment + yamlContent : yamlContent;
  writeFileSync(this.configPath, content, "utf-8");
}
```

**Alternative (simpler, recommended):** Since schema is local, use relative path. But relative schemas only work if schema file is alongside yaml. For `~/.ppm/config.yaml` this won't work. Best approach: skip auto-injection for now, document in README that users can add the schema comment manually. The schema file in repo still helps contributors.

**Decision: keep it simple.** Just create the schema file. Don't auto-inject the comment — YAGNI for now.

## Todo
- [x] Create `schemas/ppm-config.schema.json` with full config definition
- [x] Verify schema validates the current default config shape
- [x] Document schema usage in project README (optional, low priority)

## Success Criteria
- Schema file exists and is valid JSON Schema
- Schema covers all `PpmConfig` fields including new AI settings
- Editor autocomplete works when user adds schema comment to their yaml

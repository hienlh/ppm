/**
 * Starting documents for a new spec. Kept as strings in code (not files under `templates/`) so
 * the compiled binary carries them without an asset step. They are Kiro's formats; the AI
 * replaces the placeholder text, and the parser (`spec-format.ts`) reads what it writes.
 */
import type { SpecKind } from "../../shared/spec-types.ts";

export function requirementsTemplate(title: string, kind: SpecKind): string {
  if (kind === "bugfix") {
    return `# Bug analysis: ${title}

<!-- Describe the bug in three parts. Tasks cite these ids: 1.k current, 2.k expected, 3.k unchanged. -->

UI: no

## Current Behavior (Defect)

1. WHEN <condition> THEN the system <what goes wrong>

## Expected Behavior (Correct)

1. WHEN <condition> THEN the system SHALL <what should happen>

## Unchanged Behavior (Regression Prevention)

1. WHEN <condition> THEN the system SHALL CONTINUE TO <what must keep working>
`;
  }
  return `# Requirements: ${title}

## Introduction

<!-- What this is and who it is for, in two or three sentences. -->

<!-- UI: yes when the feature adds or changes a screen (the design step then includes a drawing). -->
UI: no

## Requirements

### Requirement 1: <name>

**User Story:** As a <role>, I want <feature>, so that <benefit>.

#### Acceptance Criteria

1. WHEN <event> THE SYSTEM SHALL <response>
`;
}

export function designTemplate(title: string): string {
  return `# Design: ${title}

## Overview

## Architecture

## Components and Interfaces

## Data Models

## Error Handling

## Testing Strategy

<!-- Thorough mode runs exactly these commands, from the project folder, after you approve this file.
     {files} becomes the task's _Test:_ files. -->
\`\`\`ppm-test
task: bun test {files}
suite: bun test
\`\`\`
`;
}

export function tasksTemplate(title: string): string {
  return `# Implementation Plan: ${title}

<!-- One checkbox per task. Under each, the lines PPM reads:
       _Requirements: 1.1, 1.2_   which acceptance criteria it implements
       _Deps: 1_                  tasks that must finish first (tasks without deps run in parallel)
       _Files: src/a.ts, src/b.ts_ every file it will create or change (tasks sharing a file never run together)
       _Test: tests/a.test.ts_     its test files (Thorough: they must fail first, then pass)
       _Test: none — reason_       when a task cannot have a test
     Mark an optional task with an asterisk: - [ ]* 4. Title -->

- [ ] 1. <first task>
  - _Requirements: 1.1_
  - _Files: <files>_
  - _Test: <test file>_
`;
}

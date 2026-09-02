---
name: web-design-guidelines
description: >
  Review or write web UI code against the Vercel Web Interface Guidelines —
  accessibility, focus states, forms, animation, typography, content handling,
  images, performance, navigation state, touch, safe areas, dark mode, i18n,
  hydration, hover states, and copy. Use when building, reviewing, or auditing
  a web interface (React, Next.js, Vue, Svelte, plain HTML/CSS), when the user
  asks to check UI code for accessibility or UX problems, or when they mention
  web interface guidelines, UI review, design QA, or a11y audit.
metadata:
  author: pidove99
  version: "1.0"
  source: https://github.com/vercel-labs/web-interface-guidelines
---

## Overview

A checklist-driven guideline set for web interfaces. Two modes:

- **Review** — audit existing UI files and report violations with `file:line` locations.
- **Author** — apply the rules while writing or editing UI code, before the user has to ask.

The full rule set lives in `references/guidelines.md`. **Read that file before either mode** — do not review or write from memory of this overview.

## Mode 1 — Review

Use when the user names files, a directory, a diff, or a PR to check.

1. Read `references/guidelines.md`.
2. Determine scope. If the user gave no target, default to the current diff (`git diff --name-only`), filtered to UI files (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`).
3. Read each file in scope. Do not skim — line numbers must be accurate.
4. Check every applicable rule category. Skip categories the file cannot violate (a pure utility module has no focus states).
5. Report in the output format below.

### Rules for good findings

- **Only report what you can see in the file.** Never guess at a line number; never flag a rule the file has no surface for.
- **One line per finding.** State the issue and location. Skip the explanation unless the fix is non-obvious.
- **No preamble, no summary paragraph.** High signal-to-noise — sacrifice grammar for brevity.
- A clean file gets `✓ pass`, not silence.
- Flag anti-patterns (see the reference) with the same weight as missing affordances.

### Output format

Group by file. Use `file:line` so the path is clickable in an editor.

```text
## src/Button.tsx

src/Button.tsx:42 - icon button missing aria-label
src/Button.tsx:18 - input lacks label
src/Button.tsx:55 - animation missing prefers-reduced-motion
src/Button.tsx:67 - transition: all → list properties

## src/Modal.tsx

src/Modal.tsx:12 - missing overscroll-behavior: contain
src/Modal.tsx:34 - "..." → "…"

## src/Card.tsx

✓ pass
```

If the user asks for fixes rather than a report, apply them file by file, keeping each edit minimal and scoped to the violation.

## Mode 2 — Author

Use when writing or editing UI code, whether or not the user mentions the guidelines.

1. Read `references/guidelines.md` before writing the component.
2. Write the code so the rules hold on the first pass — semantic elements, labels, focus-visible rings, `autocomplete`, explicit image dimensions, URL-backed state, reduced-motion variants.
3. Re-read your own diff against the reference before reporting done. Fix anything you find.
4. Do not narrate the checklist to the user. The compliant code is the deliverable; mention only the judgment calls that were genuinely ambiguous.

## Scope notes

- These are **web interface** rules. Do not apply them to server code, build config, or tests.
- Framework-agnostic where possible: `focus-visible:ring-*` is Tailwind shorthand, but a plain `:focus-visible { outline: ... }` satisfies the same rule. Match the project's existing conventions rather than importing Tailwind into a codebase that does not use it.
- When a rule conflicts with an explicit project convention (a design system, a documented lint rule), the project wins — note the conflict once rather than fighting it.

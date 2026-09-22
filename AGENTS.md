# AGENTS.md

## Tool routing (required)

You have two MCP servers. Use them in this order. Do not skip them.

### 1. This repo — `cocoindex-code`
Use `cocoindex-code` `search` first whenever you need to find or understand code in THIS repository.

Use it for:
- “where is X implemented”
- “how does Y work”
- finding call sites, similar patterns, entry points
- any question about existing files, functions, or architecture

Search rules:
- Query in natural language or a short code snippet. Do not only grep first.
- First search: `limit` 8–12, `refresh_index` true.
- Follow-up searches in the same turn: `refresh_index` false.
- Narrow with `paths` and `languages` when you already know the area
  (examples: `paths: ["app/src/**"]`, `languages: ["kotlin"]` or `["python"]`).
- After search hits, READ the returned files. Do not edit from the snippet alone.
- Grep/glob only if search returns nothing useful, or you need an exact string
  (`TODO`, an error message, a symbol you already know).

Do not invent files that search did not find. If search is empty, say so.

### 2. External libraries — `context7`
Use `context7` before writing or changing code that depends on a third-party library or framework.

Use it for:
- current APIs, setup, config, and examples
- version-specific behavior (Android, Compose, Retrofit, Room, FastAPI, etc.)

Rules:
- Resolve the library id, then fetch docs for the exact task.
- Prefer the project’s actual dependency versions from Gradle/package files.
- Do not rely on training memory for library APIs when Context7 is available.

### Do not
- Do not add MCP servers.
- Do not use Context7 to search this repo.
- Do not use cocoindex-code for public library docs.
- Do not dump huge file trees into context. Search, then read 2–5 files.

## Workflow

Plan first, then edit.

1. Search `cocoindex-code` for the relevant code.
2. If a library is involved, query `context7`.
3. Read the hit files and name the exact change set.
4. Edit only those files.
5. Run the project checks below.
6. If you changed a lot of files, mention that `ccc index` should be run.

Work in the current project only. Never treat `$HOME`, `AppData`, or other repos as this codebase.

## Project commands

Fill these in for this repo and keep them accurate:

- Dev / run:
- Test:
- Lint / format:
- Build:

If a command is unknown, look it up in README / Gradle / package scripts. Do not guess.

## Edit rules

- Match existing style, naming, and folder layout.
- Smallest change that solves the request.
- Do not rewrite unrelated files.
- Do not commit secrets, `.env`, or local-only config.
- Do not touch `.cocoindex_code/` databases.
- After edits, cite the files you changed.

## Parallel tools

When independent, call tools in parallel:
- cocoindex search + read known config files
- Context7 resolve + docs fetch
Never run many unbounded greps across the whole tree.
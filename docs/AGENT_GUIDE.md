# Agent guide: tiger screen shot

Create App Store and Google Play screenshots and preview videos from editable artboards. Read [AGENT_OPERATIONS.md](AGENT_OPERATIONS.md) before choosing a command and [CLI.md](CLI.md) for its full options. The machine-readable index is [agent-manifest.json](agent-manifest.json).

## Level and interface

Current strict level for the whole app is L0 with partial read, write and verification features; target L2. The new `status`, `list`, `get` and `history` commands use the versioned envelope described below. Other CLI data shapes remain command-specific. File inspection and CLI history do not cover desktop IndexedDB projects or GUI/MCP operations. General dry runs and idempotency are not complete. Do not infer success from a command's name alone.

| Command | Purpose |
| --- | --- |
| `status`, `list`, `get`, `history` | Read an exported project file and CLI execution results. |
| `doctor`, `templates`, `editor status`, `cache info` | Diagnose and inspect the environment or templates. |
| `init`, `import`, `new`, `fill`, `design` | Set up or create a project. |
| `call`, `edit`, `localize` | Inspect or change a project through editor tools. |
| `render`, `video`, `manifest`, `verify` | Export files, record a manifest and check store rules. |
| `studio`, `editor`, `cache`, `install`, `mcp`, `all` | Open or configure the editor, manage caches, serve tools or run a pipeline. |
| `upload` | Plan or perform a store upload. A real upload needs explicit authorization. |

Use `osg <command> --help`; flags and output vary. Global `--json` requests machine output where supported; it is not a uniform guarantee for every command. Human output and diagnostics use stderr; command JSON uses stdout. Existing commands use exit codes 0 success, 1 usage/config/environment error, 2 driver/render error, 3 store verification failure. For `status`, `list`, `get` and `history`, exit codes are 0 success, 1 invalid input, 2 read failure, 3 permission denied and 4 missing file or artboard.

The four inspection commands always emit JSON: success is `{"ok":true,"data":...,"meta":{"schema_version":1,"request_id":"..."}}`; failure is `{"ok":false,"error":{"code":"...","message":"...","retryable":false},"meta":{"schema_version":1,"request_id":"..."}}`. Their error codes are `invalid_argument`, `unsupported_flag`, `invalid_project`, `ambiguous_id`, `not_found`, `permission_denied` and `read_failed`. They do not load executable CLI configuration or start the editor; `--project` is resolved from the current directory and defaults to `osg/project.json`. `list` lists artboards in that file, not saved desktop projects. `get` returns the stored base artboard and can contain the project's text and embedded media.

`history` records CLI commands that can change files or external state, including failed attempts. Records contain a timestamp, command, exit category, request ID and dry-run flag, but no arguments, project content, credentials or detailed error text. It does not record GUI or MCP calls, commands before this feature, interrupted processes or every read command. The default file is under the OS user data directory; `OSG_HISTORY_FILE` overrides it. The file is created with user-only permissions where supported. Logging failure produces a warning without changing the operation's exit status. Reading history never creates it; `truncated` and `invalid_lines` disclose incomplete results.

`--dry-run` is accepted only for `upload`, `cache prune`, and `localize --csv-in` without `--add`, `--base`, `--text`, `--translate` or `--csv-out`. It is rejected elsewhere. Upload dry run still contacts the store and reads credentials. `--yes` confirms the destructive CLI operations listed in the catalog; it does not authorize external actions on the user's behalf and does not guard MCP. `--idempotency-key` is unsupported and rejected. `--timeout` is supported by `import`, `render` and `video` only. Other flags require consulting command documentation.

## Three workflows

1. Inspect prerequisites and a project file:

   ```sh
   osg status --project path/to/project.json
   osg list --project path/to/project.json
   osg get '<id>' --project path/to/project.json
   ```

   These commands read a file, not the desktop app's IndexedDB project list. Discover actual IDs from `list`.

2. Plan a CSV import, then apply it only after reviewing the result and backing up the project:

   ```sh
   osg localize --csv-in copy.csv --dry-run --json --project path/to/project.json
   osg localize --csv-in copy.csv --json --project path/to/project.json
   ```

   General `edit` has no dry run. Use a separate copy of the project and inspect results before applying changes to the original. `call` without `--save` does not write the project file, but tools may have other side effects, particularly with `--editor-url`.

3. Check exported files and investigate failures:

   ```sh
   osg verify path/to/exports --store appstore --json
   osg history --limit 20
   osg doctor --json
   ```

   A failing verifier returns exit 3. `doctor` starts a browser and creates a temporary probe database. Keep command output when detailed failure text is needed. Check the images visually as well.

## MCP and human actions

`osg mcp --stdio` exposes the editor's tools; `osg mcp --http` binds to `127.0.0.1` and requires `OSG_MCP_AUTH_TOKEN`. Tool definitions come from the editor, not a CLI-generated schema; see `cli/tools.json` and the server's live `tools/list` for names and inputs. Reads and writes are both tools. `list_project_versions` accepts a project ID from `list_projects` and returns saved version metadata from that editor's database; it does not open or restore a version. `list_ai_runs` returns recent run IDs, modes, timestamps and statuses without prompts, replies, screenshots or error details. A CLI-launched editor has its own storage and does not inspect the desktop app's database. Existing MCP is not a claim of L4 safety: individual tools do not all have dry runs or confirmation. Do not expose the server publicly or invoke destructive tools without checking their effects. Desktop MCP is a separate integration; see `docs/CLI.md` and `docs/CAPTURE.md`.

There is no supported SDK in this repository; CLI and MCP cover the current integration need. OS permission dialogs, device authorization, account sign-in, CAPTCHA and visual judgment require a person. Never send credentials in prompts or logs. Do not upload, publish, delete user data or send content externally without the user's authorization. See the catalog for operation-specific side effects.

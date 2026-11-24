# Agent guide: tiger screen shot

Create App Store and Google Play screenshots and preview videos from editable artboards. Read [AGENT_OPERATIONS.md](AGENT_OPERATIONS.md) before choosing a command and [CLI.md](CLI.md) for its full options. The machine-readable index is [agent-manifest.json](agent-manifest.json).

## Level and interface

Current strict level is L0 with partial read, write and verification features; target L2. CLI data shapes are command-specific and have no common versioned response envelope. The manifest's schema version describes the manifest only. `status`, project `list`/`get`, execution `history`, general dry runs and idempotency are not complete. Do not infer success from a command's name alone.

| Command | Purpose |
| --- | --- |
| `doctor`, `templates`, `editor status`, `cache info` | Diagnose and inspect the environment or templates. |
| `init`, `import`, `new`, `fill`, `design` | Set up or create a project. |
| `call`, `edit`, `localize` | Inspect or change a project through editor tools. |
| `render`, `video`, `manifest`, `verify` | Export files, record a manifest and check store rules. |
| `studio`, `editor`, `cache`, `install`, `mcp`, `all` | Open or configure the editor, manage caches, serve tools or run a pipeline. |
| `upload` | Plan or perform a store upload. A real upload needs explicit authorization. |

Use `osg <command> --help`; flags and output vary. Global `--json` requests machine output where supported; it is not a uniform guarantee for every command. Human output and diagnostics use stderr; command JSON uses stdout. Existing exit codes are 0 success, 1 usage/config/environment error, 2 driver/render error, 3 store verification failure. Error shapes differ by command; no stable string error-code vocabulary is promised.

`--dry-run` is accepted only for `upload`, `cache prune`, and `localize --csv-in` without `--add`, `--base`, `--text`, `--translate` or `--csv-out`. It is rejected elsewhere. Upload dry run still contacts the store and reads credentials. `--yes` and `--idempotency-key` are unsupported and rejected. `--timeout` is supported by `import`, `render` and `video` only. Other flags require consulting command documentation.

## Three workflows

1. Inspect prerequisites and a project file:

   ```sh
   osg doctor --json
   osg templates --json
   osg call list_artboards --project path/to/project.json
   osg call get_artboard '{"artboardId":"<id>"}' --project path/to/project.json
   ```

   `doctor` starts a browser and creates a temporary probe database. `call` opens a file, not the desktop app's IndexedDB project list. Discover actual IDs from `list_artboards`.

2. Plan a CSV import, then apply it only after reviewing the result and backing up the project:

   ```sh
   osg localize --csv-in copy.csv --dry-run --json --project path/to/project.json
   osg localize --csv-in copy.csv --json --project path/to/project.json
   ```

   General `edit` has no dry run. Use a separate copy of the project and inspect results before applying changes to the original. `call` without `--save` does not write the project file, but tools may have other side effects, particularly with `--editor-url`.

3. Check exported files and investigate failures:

   ```sh
   osg verify path/to/exports --store appstore --json
   osg doctor --json
   ```

   A failing verifier returns exit 3. There is no general CLI execution history; keep command output if a record is needed. Check the images visually as well.

## MCP and human actions

`osg mcp --stdio` exposes the editor's tools; `osg mcp --http` binds to `127.0.0.1` and requires `OSG_MCP_AUTH_TOKEN`. Tool definitions come from the editor, not a CLI-generated schema; see `cli/tools.json` and the server's live `tools/list` for names and inputs. Reads and writes are both tools. Existing MCP is not a claim of L4 safety: individual tools do not all have dry runs or confirmation. Do not expose the server publicly or invoke destructive tools without checking their effects. Desktop MCP is a separate integration; see `docs/CLI.md` and `docs/CAPTURE.md`.

There is no supported SDK in this repository; CLI and MCP cover the current integration need. OS permission dialogs, device authorization, account sign-in, CAPTCHA and visual judgment require a person. Never send credentials in prompts or logs. Do not upload, publish, delete user data or send content externally without the user's authorization. See the catalog for operation-specific side effects.

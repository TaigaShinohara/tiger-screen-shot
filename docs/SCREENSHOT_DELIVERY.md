# Screenshot delivery

This workflow creates or prepares editable projects with real captures and saves the reviewed package locally.

## Fill a missing screen

Start with existing originals. `create` and `prepare` report screen-specific input problems as `inputs_required`, with the group, screen, reason and next action. A screen awaiting an image can set `input` to `null`. Keep its ID and claim in the brief so Capture can target it.

```sh
osg desktop-call list_capture_devices --port 8722 --agent-json
osg deliver capture --spec brief.json --group ipad-ja --screen library \
  --device DEVICE_ID --app com.example.app --port 8722 \
  --out ./ipad-library-source --current-screen --agent-json
```

Enable the desktop MCP connection and supply its bearer token via `OSG_DESKTOP_MCP_TOKEN`. Choose a running device and an installed app. Use `--launch` for the app's first screen, `--screen-url` for a link the target app supports, or `--current-screen` for a screen already reached on the device. Append `--dry-run` to check the request without contacting Capture or writing files. A blocked capture reports why and what to do next. Finish any necessary device permission or screen navigation before retrying.

Capture saves the untouched PNG and `capture.json` in a new directory. Inspect the image for the intended screen and language, then set the screen's `input`, `inputFormat`, `inputLocale` and `capture` from the result. The optional `capture` is the path to `capture.json`; the delivery verifies its association, dimensions and SHA-256. Capture records the requested locale and the agent confirms the language shown, especially for `--current-screen`.

## Create or prepare a draft

For an initial design, use the same spec as below but omit each group's `project` and each screen's `boardId`. Set `projectLocale` to `null`. Supply a short, verified claim for each screen: it becomes the headline, so do not invent features or use generic template copy. `osg deliver create` uses the editor's design tools to create one editable project per group, renders them and stops for visual review:

```sh
osg deliver create --spec brief.json --work ./delivery-draft --dry-run --agent-json
OSG_EDITOR_DIR=/absolute/path/to/local/out osg deliver create --spec brief.json --work ./delivery-draft --offline --agent-json
```

The automatic initial layout supports Japanese and English. Other languages need a separately prepared project with an appropriate font. The generated spec is `delivery-draft/delivery-spec.json`; projects are `delivery-draft/<group>.project.json`, and the review workspace is `delivery-draft/review`. Initial layouts are proposals, never automatic visual approvals. Inspect them, edit the projects with the existing editor tools when needed, then use `prepare` with the generated spec and a **new** review workspace. A change to the original brief, an input or a project requires preparation again. The full-size output and thumbnail remain review-required until an AI with image viewing checks them.

To prepare existing projects, use one project per device layout. Each board must visibly contain the corresponding original capture as an inline image or bundled `asset:`. Use exact original bytes; a resized or re-encoded copy cannot prove this relationship. The agent must replace template examples and write accurate copy from the supplied brief. A bare template is not a finished design.

Write a UTF-8 JSON spec. Paths are relative to the spec file. Screens are in delivery order; each maps one original image to one board. `projectLocale` is the project's locale code, or `null` to use the base canvas. Set `locale` to the intended output language. The two codes must match when `projectLocale` is given.

```json
{
  "version": 1,
  "name": "Example app screenshots",
  "groups": [{
    "id": "iphone-ja",
    "store": "appstore",
    "format": "ios",
    "locale": "ja",
    "projectLocale": null,
    "project": "iphone/project.json",
    "screens": [
      { "id": "home", "boardId": "board-home", "input": "originals/iphone-home.png", "inputFormat": "ios", "inputLocale": "ja", "claim": "Library screen" }
    ]
  }]
}
```

Add separate groups and separately designed projects for each store, device and language. Every input declares its capture format and language in `inputFormat` and `inputLocale`; these must match the group. These declarations cannot prove the origin or language of the pixels, so the AI must inspect them too. Supported formats are the CLI's convertible iPhone, iPad, Android phone and tablet formats. `play` requires the store's minimum screenshot count. The source must be a PNG or JPEG. A project's selected localized board must contain the exact source; the AI must also check it is actually visible in the output.

```sh
osg deliver prepare --spec delivery.json --work ./delivery-work --dry-run --agent-json
OSG_EDITOR_DIR=/absolute/path/to/local/out osg deliver prepare --spec delivery.json --work ./delivery-work --offline --agent-json
```

Dry run reads and hashes the spec, projects and images, but creates no files and does not start a browser. Prepare requires a fresh work directory and a local editor. It fully decodes source and generated images in the browser, checks PNG chunks and store rules, and writes full images and 240-pixel-wide thumbnails. It reports `review_required` and exits with a verification failure until review; it is not a completed delivery. If preparation fails, the work directory is retained for diagnosis; use a new path for another run. It does not modify the original images or projects.

An AI with image viewing capabilities inspects every full image and its thumbnail. At full size, check the actual screen and language, accurate claim, readable content, clipping, device fit and placeholders. At thumbnail size, check that the headline is readable and the part of the app it describes is recognizable. Mark an issue as `false` and an unverified check as `null`. Finish reports missing, failed, unverified and stale reviews by screen. Replace an unsuitable source or edit the existing project as appropriate, prepare into a new directory, and review the new images and hashes. For a changed original brief, run `create` again. The review records the agent's visual judgment.

Write the review JSON **outside** the workspace using the paths and hashes returned by prepare:

```json
{
  "version": 1,
  "reviewer": "ai",
  "items": [{
    "group": "iphone-ja",
    "screen": "home",
    "sha256": "full-image-sha256-from-prepare",
    "thumbnailSha256": "thumbnail-sha256-from-prepare",
    "notes": "Describe the actual full-size and thumbnail inspection",
    "checks": {
      "actualScreen": true,
      "claimAccurate": true,
      "readableFullSize": true,
      "readableThumbnail": true,
      "noClipping": true,
      "appropriateDevice": true,
      "noPlaceholder": true
    }
  }]
}
```

```sh
osg deliver finish --work ./delivery-work --review ./review.json --out ./delivery-final --agent-json
```

Finish requires a new output directory. It checks the spec, originals, projects, images, thumbnail hashes, exact ordered screen list, review and unexpected workspace files before copying. The result is organized by store, format and locale, with `delivery-manifest.json` recording checks, image sizes, hashes, sources and the AI's notes. The full-size images and `review-thumbnails/` preserve both views used for review; the latter is review evidence, not a store screenshot. The review is an AI-reported assessment, not a guarantee of store acceptance. Keep the manifest alongside the files and review its paths before sharing it. Do not upload or publish the package without separate authorization.

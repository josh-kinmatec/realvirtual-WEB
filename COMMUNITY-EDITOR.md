# Community editor — start here

The community checkout ships with the commercial Editor, STEP import and physics as empty stubs. This
branch (`feature/community-editor`) replaces them with our own implementations, **MCP-first**: an AI
assistant (Claude Code) builds and kinematizes a machine cell through the `web_*` tools while you watch
the viewport. There is no editor UI beyond the viewport gizmos and the document card.

All processing is local. STEP files are converted in a Web Worker inside your browser and are never
uploaded; documents live in the project you open (browser storage or a folder on disk).

## 1. One-time setup

1. `npm install` (done on this machine) and `npm run dev` → <http://localhost:5173/?mcpPort=18714>
   (`?mcpPort=18714` points the viewer at the Node MCP bridge).
2. The Node bridge is built in `mcp-bridge/` (`npm run setup` there, if `mcp-bridge/dist` is missing).
   `.mcp.json` in the repo root registers it for Claude Code (the file is git-ignored on purpose).
   Start `claude` **inside this folder** and approve the `realvirtual-WebViewer` server.
3. **Open a writable project in the browser once** (an MCP tool cannot open a folder picker):
   *Projects* → open or create a **folder project** (recommended — you can drop CAD files into it with the
   file manager) or use the implicit browser project *My Workspace* (no folder on disk).
4. Put your CAD into the project, e.g. `<project>/cad/machine.step`. Paths in tool calls are
   project-relative.

## 2. The workflow (tell Claude: "kinematize cad/machine.step")

`web_describe` → `web_editor_open source=new` → `web_editor_import_cad relPath=cad/machine.step`
→ look (`web_node_tree`, `web_view_sweep`, `web_screenshot_annotated`) →
`web_editor_kinematize paths=… groupName=… direction=RotationY|LinearX|… ` →
`web_editor_verify_drive` (returns a montage of the motion) → `web_editor_materialize` →
`web_editor_save` → `web_editor_close` (reloads the saved document as a running simulation).
The long form is `recipes/kinematize-cad-import.md`; `web_help("kinematize")` serves it to the assistant.

Every edit is one undo step (`web_editor_undo`). CAD node names are never changed; the kinematic model is a
separate layer of axis nodes plus group membership.

## 3. What is implemented (and how it was checked)

| Area | Where | Status |
|---|---|---|
| Editor mode + plugin, open/save/close, document card | `src/plugins/community-editor/index.ts` | verified through a real MCP client → bridge → browser |
| Authoring actions (kinematic groups, transforms, signals, logic steps, delete, select, materials) | `…/community-editor/*` | 241 tests of the original test suite pass against it |
| Drive preview (`web_editor_verify_drive`, gizmo drag) | `drive-drag-preview.ts` | verified: axis + group move, exact restore |
| STEP import (OCCT in a Web Worker, retessellate) | `…/step-import/` | tests pass; real large assemblies **not** measured |
| Rapier physics (opt-in: set `localStorage['rv.physics']='on'`, reload) | `src/plugins/community-physics/` | 119 tests of the original suite pass against real Rapier; **dev server only** — a production build needs the Rapier ES module served and `setRapierModuleUrl()` called at boot, otherwise it stays kinematic |

Test switches: `RV_RUN_PRIVATE_DEPENDENT_TESTS=1 npx vitest run tests/<file>` runs tests that the community
build normally excludes (they import `@rv-private/*`, which now resolves to our implementations).

**Regression check:** the full default suite (1,049 files) shows no failures caused by these changes. Three
files fail identically on the untouched upstream commit (`spec-loading`, `spec-tables-sync`,
`mechanism-mcp-inspect`) and `scene-store-settings-into-model-preflight` hangs on upstream as well.
Several slow files time out when the whole suite runs in parallel on this PC but pass on their own.

## 4. Known gaps — read before relying on it

- **Not implemented:** in-place test session (`web_editor_test_start/stop` answer "no test session"),
  descend into referenced assets, crash recovery of unsaved ops on re-open, rigid-body mechanisms
  (`web_editor_mechanism_*`), IK, machining, DES kernel, JT/IGES/USD/FBX import, editor panels (hierarchy,
  Materials window, mesh separate/merge dialogs — the MCP tools for separate/merge exist).
- **Behaviour the repo does not specify was chosen by us** (axis naming `_N` suffixes, pivot = vertex mean for
  `pivotToObjectCenter`, material preset ids/colours, STEP quality → tessellation tolerances
  draft 0.004 / standard 0.001 / fine 0.0002). Review these against your expectations.
- **STEP performance:** 1000 simple parts ≈ 31 s, 3000 ≈ 5 min (synthetic data, headless). Real assemblies
  with hundreds of MB and the 4 GB WASM heap limit were not tested. On out-of-memory OCCT returns no geometry;
  the importer reports it and suggests `quality=draft`.
- **The reopened document label** for a document created by `web_editor_open source=new` is `Untitled`;
  rename with `web_editor_save name=…`.
- Hosted/public use: the project is AGPL-3.0. Serving this build to third parties triggers the source
  disclosure duties; contributing it upstream grants realvirtual GmbH relicensing rights (`CONTRIBUTING.md`).
  Clarify with the GF before either.

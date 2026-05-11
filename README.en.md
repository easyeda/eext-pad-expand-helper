[中文](./README.md)

# Pad Expand Helper (English UI **`pad-expand-helper`**)

Batch generate **solder mask expansion geometry** based on selected **pads or components** in the **PCB editor**: output as **keep-out areas on electrical layers** (to control copper pour/fill), or **solder mask layer fill graphics only**. Suitable for scenarios where you need to quickly place solder mask openings and process keep-out zones with a fixed expansion amount.

## Feature Diagram

![Feature flow diagram: select pads or components → enter expansion and type in settings → generate keep-out areas or solder mask graphics](./images/readme-feature-flow.png)

> If the diagram does not exactly match the current interaction, refer to the "Usage Instructions" below.

![alt text](images/image.png)

## Extension Identity

| Property | Value |
|----------|-------|
| name | `pad-expand-helper` |
| uuid | `23d6d62d80c44cc28c5c608ac3126f32` |
| displayName | **焊盘外扩助手** (first-level menu in `locales/extensionJson/en.json` is **`pad-expand-helper`**) |
| version | see `extension.json` |
| license | Apache-2.0 |
| categories | PCB |
| entry | `./dist/index` (build output is `dist/index.js`) |

> **name uniqueness**: The extension store requires that **extensions with different uuids cannot use the same `name`**. If the submission review prompts a naming conflict, change the `name` in `extension.json` to an unused name (lowercase letters, digits, and hyphens only, 5–30 characters), then rebuild and upload.

## Feature Description

### Generation Type (choose one of three)

In the settings window, select which rule type the result falls under:

| Type | Description |
|------|-------------|
| **Keep-out Area (No Copper Pour, default)** | Generates an area rule on the corresponding **electrical layer** to prohibit copper pour. |
| **Keep-out Area (No Fill)** | Same concept as above, targeting rule semantics that prohibit fill (use interchangeably with the copper pour option depending on the scenario). |
| **Solder Mask Area (solder mask layer graphics only)** | Keeps fill primitives only on the **top/bottom solder mask layer**, without converting to electrical layer keep-out areas. |

Expansion geometry is first constructed on the solder mask side, then **converted to keep-out areas** or **retained as solder mask fill** based on the selected type; round pads etc. will generate ring fills of **outer ring minus inner ring** (see changelog 1.0.2).

### Workflow

1. After opening the feature via the menu, an **inline settings page** (`iframe/index.html`) pops up first: select the generation type, enter the **expansion width** (single-side width outward relative to the pad outline), and choose whether to enable **continuous generation mode**. If the inline page is unavailable, it falls back to the system native dialog flow.
2. **Single generation**: Processes the **currently selected** pads/component pads/components (expanding all pads) once and finishes.
3. **Continuous generation mode**: After applying settings, you can **click or box-select multiple times** on the canvas to select pads/components; press **Esc** or **right-click** to exit; running the menu again will end the session and allow reconfiguration.

### Selection and Layer Assignment

- **Selection**: You can directly select **pads**, **component pads**, or select **components** (automatically expanding and deduplicating all pads underneath); supports multi-select and mixed selection.
- **Layer assignment**: Top layer pads → top solder mask / corresponding electrical layer; bottom layer pads → bottom layer; cross-layer/multi-layer pads → corresponding primitives generated on both top and bottom sides. Special pads on inner layers with no corresponding solder mask/electrical mapping will be **skipped** with a notification.

### Geometry and Units

- **Shapes**: Common pad outlines such as circles, rectangles, ovals, rounded tracks (stadium shapes), regular polygons, and complex polygons are all supported; expansion uses **polyline fitting** (no standalone arc primitives).
- **Units**: Reads the current **canvas unit**; input values are converted to PCB internal **mil** for generation; expansion has an **upper limit** (currently **2000 mil** in source code, subject to the actual compiled constant).

### Feedback and Exceptions

- Success or partial success will show a **toast** notification with the number of generated items; partially failed entries will list brief reasons (e.g., inner layer pad skipped, keep-out area conversion failed, etc.).
- No valid pads selected, running in a non-PCB environment, etc. will display a clear dialog or toast explanation.

### Resources and Configuration (extension.json)

- **logo**: `./images/logo.png` (square icon, recommended ≥500×500, PNG/JPEG).
- **banner**: `./images/banner.jpg` (extension store banner, aspect ratio **64:27**, JPEG, see [official documentation](https://prodocs.lceda.cn/cn/api/guide/extension-json.html)).

## Usage Instructions

### Environment Requirements

- **JLCPCB EDA Professional Edition / EasyEDA Professional Edition**, version must satisfy `engines.eda` in `extension.json` (currently `^3.0.0`).

### Operation Steps

1. Open a **PCB** design file.
2. **Single mode**: First **select** the target(s) on the canvas (pads, component pads, or components).
3. Find **`焊盘外扩助手`** in the top menu bar → **`焊盘阻焊外扩…`** (in English: **`pad-expand-helper`** → **`pad-expand-helper: expand…`**; the inline settings page English title is **`pad-expand-helper: setup`**; subject to what the client displays).
4. Complete in the settings window: **generation type**, **expansion width**, and whether to use **continuous generation**.
5. **Continuous mode**: After entering, repeatedly click/box-select on the canvas to generate; use **Esc** or **right-click** to exit continuous mode.

### Menu Description

| Menu Item | Function |
|-----------|----------|
| 焊盘外扩助手 / **pad-expand-helper** (first level; Latin name on English UI) | Group entry |
| 焊盘阻焊外扩… / `pad-expand-helper: expand…` | Open settings and execute generation (corresponds to `extension.json` submenu `pad-expand-helper: expand...`) |
| About... | Display current extension version number |

### FAQ

- **No valid objects selected (single mode)**: Please select at least one pad or a component containing pads first.
- **Selected but contains no pads**: A notification will indicate that the current selection does not contain pads.
- **Cannot see the menu or feature not working**: Please open the board in the **PCB editor** and try again; this extension registers entries in `home` / `sch` / `pcb` etc., but the core logic targets PCB.
- **Settings window won't open**: The inline frame API may fail due to version differences; try updating the client; if the issue persists, please include the version number in your feedback.
- **Upload to store reports missing banner**: Ensure `images/banner.jpg` exists in the package and `extension.json`'s `images.banner` is `./images/banner.jpg`. You can use `scripts/gen-banner.ps1` locally to generate a placeholder banner before running `npm run build`.

## Development and Build

```bash
npm install
npm run compile   # generates dist/index.js
npm run lint
npm run build     # compiles and packages .eext to build/dist
```

After the build completes, find **`pad-expand-helper_v<version>.eext`** in the `build/dist` directory (composed of `extension.json`'s **`name`** and **`version`**, consistent with the extension store identifier; **do not** change just the filename in the packaging script for aesthetics while keeping an incorrect `name`). Install the extension package in the client.

**Entry file**: `entry` in `extension.json` is `./dist/index`; before publishing, make sure to run `npm run compile` (or `npm run build`) to ensure **`dist/index.js` exists and is consistent with the source code**. The inline settings page is located in `iframe/` and must also be included in the extension package.

## API and License

- Development guide: <https://prodocs.lceda.cn/cn/api/guide/>
- API reference: <https://prodocs.lceda.cn/cn/api/reference/pro-api.html>
- License: **Apache-2.0**

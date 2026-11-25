# Muse Auto Approve

<p align="center">
  <img src="icons/icon128.png" alt="Muse Auto Approve Logo" width="96" height="96" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <b>Automated permission approval tool designed specifically for <a href="https://muse.ai">Muse.ai</a></b><br>
  Dual-mode support: Native Chrome Extension (Manifest V3) + Tampermonkey Userscript<br>
  Direct RPC Engine · Closed Shadow DOM & iframe Penetration · Context-Aware Anti-Misclick · Verified Counting · Draggable Badge
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-7.2.0-emerald?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/Manifest-V3-blue?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Tampermonkey-Supported-green?style=flat-square" alt="Tampermonkey" />
  <img src="https://img.shields.io/badge/License-MIT-purple?style=flat-square" alt="License" />
</p>

---

## Demo

Automatically detects permission dialogs on Muse (file uploads, tool executions, etc.) and approves them within milliseconds:

![Muse Auto Approve Demo](assets/demo.gif)

---

## Key Features

- **Protocol-First Dual Engine (Direct RPC Primary + DOM Penetration Fallback)**  
  Actively polls `egress.approvals` via React Fiber (preferring React 18 `FiberRootNode.current`) immediately on load without waiting for UI cards. DOM penetration serves as secondary fallback only when RPC cannot connect or does not list the prompt. RPC errors surface explicit reasons with exponential backoff instead of failing silently.

- **Strict Tier Priority (Always / All First, Single Fallback)**  
  RPC prioritizes `allow_always` and automatically degrades to `allow_once` when server policy forbids permanent approval. DOM clicking ranks buttons across 5 tiers (`Allow all` / `Always allow all` > `Allow always` / `Always allow` / `Always allow this site` > `Allow all once` > `Allow for this site` / `Allow for this task` > `Allow` / `Approve`) and normalizes badge counts like `Allow all (3)`.

- **Context-Aware Anti-Misclick Protection**  
  Verifies approval context (paired Deny/Reject/Cancel buttons or approval prompts) before clicking and excludes navigation bars, code blocks, settings switches, and disabled buttons.

- **Verified Approval Counting & Smart Retry**  
  Counts only after RPC confirmation or verified DOM button state transitions (detached, hidden, disabled, or label changed), escalating to direct React `onClick` invocation only on retry.

- **Closed Shadow DOM Penetration Without Leaks**  
  Patches `Element.prototype.attachShadow` at `document-start`, tracks roots with `WeakRef` for GC safety, and uses throttled `MutationObserver` instead of heavy full-DOM polling.

- **Multi-Instance Guard & Strict Domain Isolation**  
  Uses generation tokens to prevent duplicate execution across reloads, enforces exact `muse.ai` / `*.muse.ai` hostname checks, and migrates legacy v6.3/v6.4 settings automatically.

- **Minimalist Draggable Floating Badge**  
  - **Drag & Reposition**: Move anywhere on screen with persisted coordinates.
  - **Left Click**: Toggle Auto / Paused across main page and child iframes.
  - **Right Click**: Reset cumulative approval counters.

---

## Installation & Usage

This project supports both **Chrome / Edge Extension** and **Tampermonkey Userscript** modes. Choose whichever fits your workflow.

### Method 1: Userscript Installation (Recommended)

1. Ensure a userscript manager extension is installed in your browser:
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)
   - [ScriptCat](https://docs.scriptcat.org/)

2. **Crucial Setup (For Modern Chrome / Edge 126+)**:  
   Due to Chromium security policies, you must explicitly enable user scripts for Tampermonkey:
   - Navigate to `chrome://extensions/` in your address bar.
   - Locate Tampermonkey and click **"Details"**.
   - Enable the **"Allow User Scripts"** toggle (as shown below; enable "Developer mode" in the top-right corner if the toggle is not visible).

   <p align="center">
     <img src="assets/tampermonkey-permission.png" alt="Allow User Scripts Setting" width="600" />
   </p>

3. **Install the Script (Two Options)**:

   - **Option A: Manual Installation (Most Reliable)**
     1. Open [`muse-auto-approve.user.js`](./muse-auto-approve.user.js) in this repository and copy the entire source code.
     2. Click the Tampermonkey icon in your browser toolbar, then click **"Create a new script..."** (as shown below).
     3. Clear the default template and paste the copied code.
     4. Press `Ctrl + S` (`Cmd + S` on macOS) or select "File -> Save" to save.

     <p align="center">
       <img src="assets/tampermonkey-add-script.png" alt="Tampermonkey Add New Script" width="420" />
     </p>

   - **Option B: One-Click Online Install**
     - Open [`muse-auto-approve.user.js`](./muse-auto-approve.user.js) in your browser and click **Raw**; Tampermonkey will intercept and prompt the installation dialog. Click **Install**.

4. Open [muse.ai](https://muse.ai) — the status badge will appear in the top-right corner.

### Method 2: Chrome Extension Installation (Developer Mode)

1. Download the pre-packaged `MuseAutoApprove-v7.2.0.zip` from the [Releases page](https://github.com/waw666waw666/MuseAutoApprove/releases) and extract it (or clone this repository).
2. Navigate to `chrome://extensions/` in your Chromium-based browser (Chrome, Edge, Brave, Arc, etc.).
3. Toggle on **"Developer mode"** in the top-right corner.
4. Click **"Load unpacked"** in the top-left corner.
5. Select the extracted folder to complete installation.

---

## Floating Badge Controls

| Action | Result | Visual Indicator |
| :--- | :--- | :--- |
| **Left Click** | Toggle Auto / Paused state | Green glow (Auto) / Gray dim (Paused) |
| **Click & Drag** | Move badge to any position on screen | Coordinates saved to storage upon release |
| **Right Click** | Reset cumulative approval count | Badge counter resets to `0` |

---

## Project Structure

```text
MuseAutoApprove/
├── manifest.json                  # Chrome Extension Manifest (V3)
├── content.js                     # Extension Content Script
├── muse-auto-approve.user.js      # Userscript source (with standard metadata headers)
├── tests/
│   └── auto-approve.test.mjs      # 7-suite sandbox unit tests (node tests/auto-approve.test.mjs)
├── icons/                         # Extension icons (16x16, 48x48, 128x128)
├── assets/                        # Demo GIF & screenshot assets
│   ├── demo.gif                   # Animation demo
│   ├── preview.png                # High-res screenshot
│   ├── tampermonkey-permission.png# User script permission guide screenshot
│   └── tampermonkey-add-script.png# Tampermonkey menu guide screenshot
├── LICENSE                        # MIT License
├── README.md                      # Documentation (Simplified Chinese)
└── README_en.md                   # Documentation (English)
```

---

## Disclaimer

1. **Purpose & Scope**: This tool is provided solely for educational, technical research, and personal workflow automation purposes. Users must independently ensure strict compliance with the Terms of Service and policies of any target platform (including but not limited to Muse.ai).
2. **Account & Restriction Risks**: This tool automates UI approval workflows via synthetic event dispatch. Any potential consequences resulting from automated interactions—including but not limited to **account suspension, banning, freezing, rate-limiting, feature throttling, or risk-control flagging**—are the sole responsibility of the user.
3. **Data & Asset Liability**: Automated approvals rapidly authorize actions (such as file uploads and public link generation) without manual intervention. The author shall not be held liable for any accidental misoperations, data modifications, privacy exposure, or potential financial losses.
4. **Provided "AS IS"**: This project is provided on an "AS IS" basis without warranty of any kind, express or implied. Downloading, installing, or using this tool constitutes full acknowledgment and acceptance of all terms in this disclaimer.

---

## License

This project is licensed under the [MIT License](./LICENSE).

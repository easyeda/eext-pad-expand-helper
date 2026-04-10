# 焊盘阻焊外扩 / 禁止区域（Pad Solder Mask Expansion）

本扩展用于在 **PCB 编辑器**中，根据所选 **焊盘或器件**，在 **顶层 / 底层阻焊层**上自动生成 **外扩后的禁止区域外环**，便于控制阻焊开窗与工艺禁区。

## 功能示意图

![功能流程示意：选中焊盘或器件 → 输入阻焊外扩并预览 → 在阻焊层生成禁止区域](./images/readme-feature-flow.png)

**扩展标识**

| 属性 | 值 |
|------|-----|
| name | `pad-solder-mask-guard` |
| uuid | `23d6d62d80c44cc28c5c608ac3126f32` |
| displayName | 生成禁止区域 |
| version | 见 `extension.json` |
| license | Apache-2.0 |
| categories | PCB |
| 入口 entry | `./dist/index`（构建产物为 `dist/index.js`） |

> **name 唯一性**：扩展商店要求 **不同 uuid 的扩展不能使用相同的 `name`**。若上架审核提示命名冲突，请将 `extension.json` 中的 `name` 改为未占用的名称（仅小写字母、数字、中划线，长度 5–30），并重新构建上传。

## 功能说明

### 适用场景

- 需要按 **固定外扩宽度** 在阻焊层快速生成与焊盘形状对应的 **禁止区域**。
- 批量处理多个焊盘，或选中 **整个器件** 后一次性处理其下全部焊盘。

### 具体能力

- **选择方式**
  - 直接选中 **焊盘（Pad）** 或 **器件焊盘（ComponentPad）**。
  - 选中 **器件（Component）** 时，自动展开其包含的所有焊盘并去重后处理。
  - 支持混合多选。
- **分层规则**
  - 顶层焊盘 → 在 **顶层阻焊层** 生成图元。
  - 底层焊盘 → 在 **底层阻焊层** 生成图元。
  - 跨层 / 多层焊盘 → **顶层与底层阻焊层** 各生成对应图元。
- **几何形状**：支持圆形、矩形、椭圆、多边形及复杂多边形等常见焊盘轮廓。
- **单位**：读取当前 **画布单位**，将您输入的“阻焊外扩宽度”换算为 PCB 内部所用单位（如 mil）。
- **预览**：可先 **仅预览** 统计信息（数量、层等），确认后再 **创建图元**，避免误操作。

### 资源与配置（extension.json）

- **logo**：`./images/logo.png`（正方形图标，建议 ≥500×500，PNG/JPEG；当前为 AI 生成图标）。
- **banner**：`./images/banner.jpg`（扩展商店横幅，比例 **64:27**，JPEG，见[官方说明](https://prodocs.lceda.cn/cn/api/guide/extension-json.html)）。

## 使用说明

### 环境要求

- **嘉立创 EDA 专业版 / EasyEDA 专业版**，版本需满足 `extension.json` 中 `engines.eda`（当前为 `^3.0.0`）。

### 操作步骤

1. 打开 **PCB** 设计文件。
2. 在画布中 **选中** 一个或多个目标：**焊盘**、**器件焊盘** 或 **器件**。
3. 在顶部菜单栏找到 **`Solder Mask Tools`** → **`Pad solder mask expansion...`**。
4. 在对话框中输入 **阻焊外扩宽度**（数值单位与 **当前画布单位** 一致）。
5. 确认基础信息后，按提示选择模式：
   - 输入 **`1`**：**仅预览** — 仅弹出统计信息，**不创建** 任何图元。
  - 输入 **`2`**：**直接创建** — 在对应阻焊层生成 **禁止区域（外环）** 图元。
6. 根据结果弹窗核对统计信息；若使用预览模式满意后，可再次执行并选择 **`2`** 正式生成。

### 菜单说明

| 菜单项 | 作用 |
|--------|------|
| Pad solder mask expansion... | 打开阻焊外扩 / 禁止区域生成流程 |
| About... | 显示当前扩展版本号 |

### 常见问题

- **未选中有效对象**：请先选中至少一个焊盘或包含焊盘的器件。
- **看不到菜单**：请在 **PCB 编辑器** 界面使用；本扩展在 `home` / `sch` / `pcb` 等均注册了入口，主要功能针对 PCB。
- **上传商店报 banner 缺失**：确保打包内存在 `images/banner.jpg`，且 `extension.json` 的 `images.banner` 为 `./images/banner.jpg`。本地可用 `scripts/gen-banner.ps1` 重新生成占位横幅后再 `npm run build`。

## 开发与构建

```bash
npm install
npm run compile   # 生成 dist/index.js
npm run lint
npm run build     # 编译并打包 .eext 到 build/dist
```

构建完成后，在 `build/dist` 目录获取 **`pad-solder-mask-guard_v<version>.eext`**，在客户端中安装该扩展包。

**入口文件**：`extension.json` 中 `entry` 为 `./dist/index`；发布前请务必执行 `npm run compile`（或 `npm run build`），保证 **`dist/index.js` 存在且与源码一致**。

## API 与许可

- 开发指南：<https://prodocs.lceda.cn/cn/api/guide/>
- API 参考：<https://prodocs.lceda.cn/cn/api/reference/pro-api.html>
- 许可：**Apache-2.0**

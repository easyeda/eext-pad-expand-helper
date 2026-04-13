/**
 * 焊盘外扩：折线拟合几何；禁止区域或阻焊填充；PCB_Event 连续选中生成。
 */

import * as extensionConfig from '../extension.json';

const LAYER_TOP = EPCB_LayerId.TOP;
const LAYER_BOTTOM = EPCB_LayerId.BOTTOM;
const LAYER_MULTI = EPCB_LayerId.MULTI;
const LAYER_TOP_SOLDER_MASK = EPCB_LayerId.TOP_SOLDER_MASK;
const LAYER_BOTTOM_SOLDER_MASK = EPCB_LayerId.BOTTOM_SOLDER_MASK;

const PAD_SHAPE_ELLIPSE = EPCB_PrimitivePadShapeType.ELLIPSE;
const PAD_SHAPE_OVAL = EPCB_PrimitivePadShapeType.OBLONG;
const PAD_SHAPE_RECT = EPCB_PrimitivePadShapeType.RECTANGLE;
const PAD_SHAPE_NGON = EPCB_PrimitivePadShapeType.REGULAR_POLYGON;
const PAD_SHAPE_POLYGON = EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON;

const FILL_SOLID = EPCB_PrimitiveFillMode.SOLID;
const MAX_EXP_MIL = 2000;
const ELLIPSE_POLYLINE_SEGMENTS = 48;
const SELECT_DEBOUNCE_MS = 120;
/** Toast 自动关闭：`showToastMessage` 第 3 参为秒数，`0` 为不自动关闭（勿误传毫秒） */
const TOAST_AUTO_CLOSE_SEC = 6;

const MOUSE_LISTENER_ID = `${extensionConfig.uuid}-pad-exp-mouse`;

export type PadExpansionOutputKind = 'forbidden_pour' | 'forbidden_fill' | 'solder_mask';

export interface PadExpansionSettings {
	outputKind: PadExpansionOutputKind;
	expMil: number;
}

let activeInteractiveSettings: PadExpansionSettings | undefined;
let selectionDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let interactiveProcessing = false;
let pendingInteractiveSelection = false;
/** 处理中再次触发选中时保留最近一次事件的 props，供 finally 重试（勿无参 schedule，否则会丢框选/点选信息） */
let pendingInteractiveMouseProps: PcbMouseSelectProp[] | undefined;

let interactiveKeydownHandler: ((e: Event) => void) | undefined;
let interactiveContextMenuHandler: ((e: Event) => void) | undefined;

type GlobalEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

function getGlobalEventTarget(): GlobalEventTarget | undefined {
	if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
		return globalThis as unknown as GlobalEventTarget;
	}
	return undefined;
}

/** 吐司：约 20s 自动关闭（timer 为秒）。勿传「关闭」按钮与空回调：空字符串会导致按钮无效。 */
function showPadExpToast(
	message: string,
	messageType: ESYS_ToastMessageType,
	_t?: (k: string, ...a: string[]) => string,
): void {
	eda.sys_Message.showToastMessage(message, messageType, TOAST_AUTO_CLOSE_SEC);
}

function unregisterInteractiveExitListeners(): void {
	const g = getGlobalEventTarget();
	if (!g) {
		return;
	}
	if (interactiveKeydownHandler) {
		g.removeEventListener('keydown', interactiveKeydownHandler, true);
		interactiveKeydownHandler = undefined;
	}
	if (interactiveContextMenuHandler) {
		g.removeEventListener('contextmenu', interactiveContextMenuHandler, true);
		interactiveContextMenuHandler = undefined;
	}
}

function registerInteractiveExitListeners(t: (k: string, ...a: string[]) => string): void {
	unregisterInteractiveExitListeners();
	const g = getGlobalEventTarget();
	if (!g) {
		return;
	}
	interactiveKeydownHandler = (e: Event) => {
		if (!activeInteractiveSettings) {
			return;
		}
		const ke = e as KeyboardEvent;
		if (ke.key !== 'Escape') {
			return;
		}
		ke.preventDefault();
		ke.stopPropagation();
		exitInteractiveModeWithNotify(t, 'esc');
	};
	interactiveContextMenuHandler = (e: Event) => {
		if (!activeInteractiveSettings) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		exitInteractiveModeWithNotify(t, 'contextmenu');
	};
	g.addEventListener('keydown', interactiveKeydownHandler, true);
	g.addEventListener('contextmenu', interactiveContextMenuHandler, true);
}

function exitInteractiveModeWithNotify(t: (k: string, ...a: string[]) => string, reason: 'esc' | 'contextmenu'): void {
	if (!activeInteractiveSettings) {
		return;
	}
	stopInteractiveMode();
	const key = reason === 'esc' ? 'SolderMaskExpExitEsc' : 'SolderMaskExpExitRightClick';
	showPadExpToast(t(key), ESYS_ToastMessageType.INFO, t);
}

/** {@link PCB_Event.addMouseEventListener} 回调中 props 的单项形状 */
interface PcbMouseSelectProp {
	primitiveId: string;
	primitiveType: EPCB_PrimitiveType;
	net?: string;
	designator?: string;
	parentComponentPrimitiveId?: string;
	parentComponentDesignator?: string;
}

function normalizeMouseProps(raw: unknown): PcbMouseSelectProp[] | undefined {
	if (raw == null) {
		return undefined;
	}
	if (Array.isArray(raw)) {
		if (raw.length === 0) {
			return undefined;
		}
		const first = raw[0];
		// 部分宿主将 props 传为 [[{ id }, …]] 嵌套数组
		if (Array.isArray(first)) {
			return first.length > 0 ? (first as PcbMouseSelectProp[]) : undefined;
		}
		return raw as PcbMouseSelectProp[];
	}
	if (typeof raw === 'object' && 'primitiveId' in raw) {
		return [raw as PcbMouseSelectProp];
	}
	return undefined;
}

/**
 * 选中列表：先等一帧再读（弹窗关闭后选中状态可能尚未同步）；若仍为空则用事件携带的 primitiveId 拉取图元（部分环境下仅 SELECTED 监听不可靠）。
 */
async function resolveSelectedPrimitives(mouseProps?: PcbMouseSelectProp[]): Promise<IPCB_Primitive[]> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	let list = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	if (list.length === 0 && mouseProps?.length) {
		// 点选后选中列表可能晚于鼠标事件，再延迟一帧拉取
		await new Promise<void>(resolve => setTimeout(resolve, 120));
		list = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	}
	if (list.length > 0) {
		return list;
	}
	if (mouseProps?.length) {
		const ids = [...new Set(mouseProps.map(p => p.primitiveId))];
		try {
			const got = await eda.pcb_Primitive.getPrimitivesByPrimitiveId(ids);
			return got.filter((p): p is IPCB_Primitive => p != null);
		}
		catch {
			return [];
		}
	}
	return [];
}

type PadPrimitive = IPCB_PrimitivePad | IPCB_PrimitiveComponentPad;
type PadShape = TPCB_PrimitivePadShape;
/** 解析几何焊盘形状（ELLIPSE/OBLONG/REGULAR_POLYGON/RECTANGLE），不含 POLYGON */
type AnalyticPadShape = Exclude<PadShape, [EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON, unknown]>;
type SpecialPad = TPCB_PrimitiveSpecialPadShape;
type PolygonSource = TPCB_PolygonSourceArray;
type PolyData = Extract<PadShape, [typeof PAD_SHAPE_POLYGON, unknown]>[1];
type FillLayer = Parameters<typeof eda.pcb_PrimitiveFill.create>[0];
type FillPolygon = IPCB_Polygon | IPCB_ComplexPolygon;

const VALID_OUTPUT_KINDS = new Set<PadExpansionOutputKind>(['forbidden_pour', 'forbidden_fill', 'solder_mask']);

function isPadExpansionOutputKind(v: string): v is PadExpansionOutputKind {
	return VALID_OUTPUT_KINDS.has(v as PadExpansionOutputKind);
}

function padLabel(pad: PadPrimitive): string {
	return pad.getState_PadNumber() ?? '?';
}

function checkPcbDocumentActive(): Promise<boolean> {
	return eda.dmt_SelectControl.getCurrentDocumentInfo()
		.then(doc => doc?.documentType === EDMT_EditorDocumentType.PCB)
		.catch(() => false);
}

function isPadPrimitive(p: IPCB_Primitive): p is PadPrimitive {
	const t = p.getState_PrimitiveType();
	return t === EPCB_PrimitiveType.PAD || t === EPCB_PrimitiveType.COMPONENT_PAD;
}

function isComponentPrimitive(p: IPCB_Primitive): p is IPCB_PrimitiveComponent {
	return p.getState_PrimitiveType() === EPCB_PrimitiveType.COMPONENT;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function convertInputToMil(raw: string, unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>): number | null {
	const n = Number.parseFloat(String(raw).trim().replace(/,/g, ''));
	if (!Number.isFinite(n) || n < 0) {
		return null;
	}
	const u = unit ?? 'mm';
	const sys = eda.sys_Unit;
	if (u === 'mm') {
		return sys.mmToMil(n, 6);
	}
	if (u === 'mil') {
		return n;
	}
	if (u === 'inch' || u === 'in') {
		return sys.inchToMil(n, 6);
	}
	if (u === 'cm') {
		return sys.mmToMil(n * 10, 6);
	}
	if (u === 'dm') {
		return sys.mmToMil(n * 100, 6);
	}
	if (u === 'm') {
		return sys.mmToMil(n * 1000, 6);
	}
	return sys.mmToMil(n, 6);
}

function unitHint(unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>): string {
	const u = unit ?? 'mm';
	const map: Record<string, string> = { mm: 'mm', mil: 'mil', inch: 'inch', in: 'in', cm: 'cm', dm: 'dm', m: 'm' };
	return map[u as string] ?? String(u);
}

function rangeCoversOuterLayer(startLayer: number, endLayer: number, outer: number): boolean {
	const lo = Math.min(startLayer, endLayer);
	const hi = Math.max(startLayer, endLayer);
	return lo <= outer && hi >= outer;
}

function solderMaskTargetsForPad(layer: TPCB_LayersOfPad, specialPad: SpecialPad | undefined): Set<FillLayer> {
	const layers = new Set<FillLayer>();
	if (specialPad?.length) {
		for (const [a, b] of specialPad) {
			if (rangeCoversOuterLayer(a, b, LAYER_TOP)) {
				layers.add(LAYER_TOP_SOLDER_MASK);
			}
			if (rangeCoversOuterLayer(a, b, LAYER_BOTTOM)) {
				layers.add(LAYER_BOTTOM_SOLDER_MASK);
			}
		}
		return layers;
	}
	if (layer === LAYER_TOP) {
		layers.add(LAYER_TOP_SOLDER_MASK);
	}
	else if (layer === LAYER_BOTTOM) {
		layers.add(LAYER_BOTTOM_SOLDER_MASK);
	}
	else if (layer === LAYER_MULTI) {
		layers.add(LAYER_TOP_SOLDER_MASK);
		layers.add(LAYER_BOTTOM_SOLDER_MASK);
	}
	return layers;
}

function bboxToExpandedRectSource(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	expMil: number,
): PolygonSource {
	const w = bbox.maxX - bbox.minX + 2 * expMil;
	const h = bbox.maxY - bbox.minY + 2 * expMil;
	return ['R', bbox.minX - expMil, bbox.maxY + expMil, w, h, 0, 0];
}

function bboxToRectContourSource(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	expMil: number,
	clockwise: boolean,
): PolygonSource {
	const left = bbox.minX - expMil;
	const right = bbox.maxX + expMil;
	const top = bbox.maxY + expMil;
	const bottom = bbox.minY - expMil;
	if (clockwise) {
		return [left, top, 'L', right, top, right, bottom, left, bottom];
	}
	return [left, top, 'L', left, bottom, right, bottom, right, top];
}

function rectContourToRectSource(source: PolygonSource): PolygonSource | undefined {
	if (
		source.length !== 9
		|| source[2] !== 'L'
		|| typeof source[0] !== 'number'
		|| typeof source[1] !== 'number'
		|| typeof source[3] !== 'number'
		|| typeof source[4] !== 'number'
		|| typeof source[5] !== 'number'
		|| typeof source[6] !== 'number'
		|| typeof source[7] !== 'number'
		|| typeof source[8] !== 'number'
	) {
		return undefined;
	}
	const xs = [source[0], source[3], source[5], source[7]];
	const ys = [source[1], source[4], source[6], source[8]];
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	return ['R', minX, maxY, maxX - minX, maxY - minY, 0, 0];
}

/** 半径 r、顶点数 n 的闭合折线（正多边形、椭圆采样等；圆焊盘优先用 {@link circlePolygonSource}） */
function closedRadialPolyline(cx: number, cy: number, r: number, vertexCount: number, clockwise: boolean): PolygonSource {
	const n = Math.max(3, Math.floor(vertexCount));
	const pts: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const a = clockwise ? -t * 2 * Math.PI : t * 2 * Math.PI;
		pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
	}
	return [pts[0], pts[1], 'L', ...pts.slice(2)] as PolygonSource;
}

/** 原生 CIRCLE 多边形源（TPCB_PolygonSourceArray：`CIRCLE cx cy radius`），比 L 折线圆更易通过填充/布尔校验 */
function circlePolygonSource(cx: number, cy: number, r: number): PolygonSource {
	return ['CIRCLE', cx, cy, r] as PolygonSource;
}

/**
 * `R` 模式首两点为未旋转时的左上角；旋转角作用在左上角锚点上。
 * Y 向上、中心在 (cx,cy) 时：中心 = 左上 + (w/2, -h/2)，故带旋转时左上角 = 中心 − R(θ)(w/2, -h/2)。
 * rotDeg=0 时退化为 (cx - w/2, cy + h/2)，与现有矩形焊盘写法一致。
 */
function rectTopLeftFromCenter(cx: number, cy: number, w: number, h: number, rotDeg: number): { x: number; y: number } {
	const rad = (rotDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = w / 2;
	const dy = -h / 2;
	const rx = dx * cos - dy * sin;
	const ry = dx * sin + dy * cos;
	return { x: cx - rx, y: cy - ry };
}

/**
 * 跑道形（OBLONG）多边形源：使用官方 `R` 圆角矩形，`round = min(w,h)/2` 时即为胶囊（两端半圆+直边），
 * 与 L 折线逼近相比更易被 pcb_PrimitiveFill 接受（与圆焊盘用 CIRCLE 同理）。
 */
function stadiumPolygonSource(cx: number, cy: number, rotDeg: number, w: number, h: number): PolygonSource {
	if (Math.abs(w - h) < 1e-6) {
		return circlePolygonSource(cx, cy, Math.max(w, h) / 2);
	}
	const round = Math.min(w, h) / 2;
	const tl = rectTopLeftFromCenter(cx, cy, w, h, rotDeg);
	return ['R', tl.x, tl.y, w, h, rotDeg, round] as PolygonSource;
}

/** 椭圆闭合折线（半轴 rx, ry；均匀外扩近似为半轴各 +exp） */
function closedEllipsePolygonSource(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	rotDeg: number,
	segments: number,
	clockwise: boolean,
): PolygonSource {
	const n = Math.max(8, Math.floor(segments));
	const rad = (rotDeg * Math.PI) / 180;
	const cosR = Math.cos(rad);
	const sinR = Math.sin(rad);
	const flat: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n;
		const a = clockwise ? -t * 2 * Math.PI : t * 2 * Math.PI;
		const lx = rx * Math.cos(a);
		const ly = ry * Math.sin(a);
		flat.push(cx + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR);
	}
	return [flat[0], flat[1], 'L', ...flat.slice(2)] as PolygonSource;
}

function expandLocalPolygonPadData(
	data: PolyData,
	cx: number,
	cy: number,
	rotDeg: number,
	expMil: number,
): PolygonSource | undefined {
	const complex = eda.pcb_MathPolygon.createComplexPolygon(data);
	if (!complex) {
		return undefined;
	}
	const w = eda.pcb_MathPolygon.calculateWidth(complex);
	const h = eda.pcb_MathPolygon.calculateHeight(complex);
	if (!(w > 0 && h > 0)) {
		return undefined;
	}
	const lc = complex.getCenter();
	const rad = (rotDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const wx = cx + lc.x * cos - lc.y * sin;
	const wy = cy + lc.x * sin + lc.y * cos;
	const ew = w + 2 * expMil;
	const eh = h + 2 * expMil;
	const tl = rectTopLeftFromCenter(wx, wy, ew, eh, rotDeg);
	return ['R', tl.x, tl.y, ew, eh, rotDeg, 0];
}

function expandAnalyticShapeToPolylineSource(
	padShape: PadShape,
	cx: number,
	cy: number,
	rotDeg: number,
	expMil: number,
): PolygonSource | undefined {
	const e2 = expMil * 2;
	if (padShape[0] === PAD_SHAPE_ELLIPSE) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		if (Math.abs(w - h) < 1e-6) {
			return circlePolygonSource(cx, cy, Math.max(w, h) / 2);
		}
		return closedEllipsePolygonSource(cx, cy, w / 2, h / 2, rotDeg, ELLIPSE_POLYLINE_SEGMENTS, true);
	}
	if (padShape[0] === PAD_SHAPE_OVAL) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		return stadiumPolygonSource(cx, cy, rotDeg, w, h);
	}
	if (padShape[0] === PAD_SHAPE_RECT) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		const tl = rectTopLeftFromCenter(cx, cy, w, h, rotDeg);
		return ['R', tl.x, tl.y, w, h, rotDeg, 0];
	}
	if (padShape[0] === PAD_SHAPE_NGON) {
		const diameter = padShape[1] + e2;
		const sides = Math.min(64, Math.max(3, typeof padShape[2] === 'number' ? padShape[2] : 6));
		return closedRadialPolyline(cx, cy, Math.max(diameter / 2, 0), sides, true);
	}
	return undefined;
}

/** 已用解析几何处理跑道/椭圆外扩，不再依赖整焊盘 AABB 矩形 */
function shapeNeedsWholePadBBox(_s: PadShape): boolean {
	return false;
}

/** 类型守卫：判断是否为圆形焊盘（ELLIPSE 且宽高相等），并收窄 shape 为解析几何类型 */
function isCirclePadShape(shape: PadShape): shape is AnalyticPadShape {
	if (shape[0] !== PAD_SHAPE_ELLIPSE) {
		return false;
	}
	// 对于 ELLIPSE，shape 是 [type, number, number]
	const w = shape[1] as number;
	const h = shape[2] as number;
	return Math.abs(w - h) < 1e-6;
}

async function getPadWorldBBox(pad: PadPrimitive): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | undefined> {
	try {
		return (await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()])) ?? undefined;
	}
	catch {
		return undefined;
	}
}

/**
 * 跑道形焊盘外扩用 `getState_Rotation()` 在「仅点选焊盘」时可能不可靠；世界包围盒与长宽 L、W 可反推转角。
 * 优先用 bbox 长宽比判断横置/纵置：bbox 常因钻孔、描边等略大于标称 L、W，仅靠 |bw−L| 闭合会失败并落入矩阵反解，产生斜向错误角。
 * 再辅以与 (L,W) 的轴对齐比对；一般角用 |cos|、|sin| 的 AABB 公式反解（θ∈[0,π/2]）。
 */
function inferOblongRotationDegFromAabb(
	w0: number,
	h0: number,
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	rotApi: number,
): number {
	const bw = bbox.maxX - bbox.minX;
	const bh = bbox.maxY - bbox.minY;
	const tol = Math.max(0.5, 0.002 * Math.max(w0, h0, bw, bh));
	const errAt = (deg: number): number => {
		const rad = (deg * Math.PI) / 180;
		const pw = Math.abs(w0 * Math.cos(rad)) + Math.abs(h0 * Math.sin(rad));
		const ph = Math.abs(w0 * Math.sin(rad)) + Math.abs(h0 * Math.cos(rad));
		return Math.abs(pw - bw) + Math.abs(ph - bh);
	};

	// 明显拉长的跑道：世界 AABB 哪边更长即长轴朝向，不必与 L、W 数值严格相等（避免横置被误判为斜向）
	const elong = Math.abs(w0 - h0);
	const minElong = Math.max(1e-6, 0.02 * Math.max(w0, h0));
	if (elong > minElong) {
		const gap = Math.abs(bw - bh);
		const orientTol = Math.max(tol, 0.03 * Math.max(bw, bh));
		if (gap > orientTol) {
			// 轴对齐时直接比较 0° 与 90° 哪个更贴近 bbox，兼容不同库元的宽高基准。
			return errAt(0) <= errAt(90) ? 0 : 90;
		}
	}

	const axisAligned0
		= errAt(0) < 2 * tol;
	const axisAligned90
		= errAt(90) < 2 * tol;
	if (axisAligned0 && !axisAligned90) {
		return 0;
	}
	if (axisAligned90 && !axisAligned0) {
		return 90;
	}
	if (axisAligned0 && axisAligned90) {
		const d0 = errAt(0);
		const d90 = errAt(90);
		return d0 <= d90 ? 0 : 90;
	}

	const L = Math.max(w0, h0);
	const W = Math.min(w0, h0);
	const det = L * L - W * W;
	if (Math.abs(det) < 1e-9) {
		return rotApi;
	}
	const c = (L * bw - W * bh) / det;
	const s = (L * bh - W * bw) / det;
	const n = Math.hypot(c, s);
	if (n < 1e-9) {
		return rotApi;
	}
	const cn = c / n;
	const sn = s / n;
	if (cn < -0.02 || sn < -0.02) {
		return rotApi;
	}
	const thetaDeg = (Math.atan2(sn, cn) * 180) / Math.PI;
	const rad = (thetaDeg * Math.PI) / 180;
	const predW = L * Math.abs(Math.cos(rad)) + W * Math.abs(Math.sin(rad));
	const predH = L * Math.abs(Math.sin(rad)) + W * Math.abs(Math.cos(rad));
	if (Math.abs(predW - bw) > tol || Math.abs(predH - bh) > tol) {
		return rotApi;
	}
	return thetaDeg;
}

async function buildExpandedMaskSource(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	rotationDeg: number,
): Promise<PolygonSource | undefined> {
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rot = rotationDeg;
	if (padShape[0] === PAD_SHAPE_POLYGON) {
		return expandLocalPolygonPadData((padShape as [typeof PAD_SHAPE_POLYGON, PolyData])[1], cx, cy, rot, expMil);
	}
	return expandAnalyticShapeToPolylineSource(padShape, cx, cy, rot, expMil);
}

function tryComplexRing(outer: PolygonSource, inner: PolygonSource, worldBBox: { minX: number; minY: number; maxX: number; maxY: number }, expMil: number): FillPolygon | undefined {
	const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
	if (ring) {
		return ring;
	}
	const outerOnly = eda.pcb_MathPolygon.createPolygon(bboxToExpandedRectSource(worldBBox, expMil));
	return outerOnly ?? undefined;
}

async function buildExpandedMaskPolygon(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	_useWholePadBBox: boolean,
): Promise<FillPolygon | undefined> {
	const worldBBox = await getPadWorldBBox(pad);
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rotApi = pad.getState_Rotation();
	let rot = rotApi;
	if (worldBBox && padShape[0] === PAD_SHAPE_OVAL) {
		const w0 = padShape[1];
		const h0 = padShape[2];
		if (typeof w0 === 'number' && typeof h0 === 'number' && w0 > 0 && h0 > 0) {
			rot = inferOblongRotationDegFromAabb(w0, h0, worldBBox, rotApi);
		}
	}
	const e2 = expMil * 2;

	// 圆焊盘：用焊盘中心与 padShape 直径（与 bbox 解耦，避免 bbox 与焊盘不一致时孔洞无效导致 create fill 失败）
	if (isCirclePadShape(padShape)) {
		const rInner = Math.min(padShape[1], padShape[2]) / 2;
		if (rInner > 1e-9 && expMil > 1e-9) {
			const ccx = pad.getState_X();
			const ccy = pad.getState_Y();
			const rOuter = rInner + expMil;
			const outer = circlePolygonSource(ccx, ccy, rOuter);
			const inner = circlePolygonSource(ccx, ccy, rInner);
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_OVAL) {
		const w0 = padShape[1];
		const h0 = padShape[2];
		if (typeof w0 === 'number' && typeof h0 === 'number' && w0 > 0 && h0 > 0) {
			const outer = stadiumPolygonSource(cx, cy, rot, w0 + e2, h0 + e2);
			const inner = stadiumPolygonSource(cx, cy, rot, w0, h0);
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_ELLIPSE && !isCirclePadShape(padShape)) {
		const w0 = padShape[1];
		const h0 = padShape[2];
		if (typeof w0 === 'number' && typeof h0 === 'number' && w0 > 0 && h0 > 0) {
			const outer = closedEllipsePolygonSource(cx, cy, (w0 + e2) / 2, (h0 + e2) / 2, rot, ELLIPSE_POLYLINE_SEGMENTS, true);
			const inner = closedEllipsePolygonSource(cx, cy, w0 / 2, h0 / 2, rot, ELLIPSE_POLYLINE_SEGMENTS, false);
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outer);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}

	if (worldBBox && padShape[0] === PAD_SHAPE_RECT) {
		const outer = bboxToRectContourSource(worldBBox, expMil, true);
		const inner = bboxToRectContourSource(worldBBox, 0, false);
		return tryComplexRing(outer, inner, worldBBox, expMil);
	}

	if (worldBBox) {
		const outer = bboxToRectContourSource(worldBBox, expMil, true);
		const inner = bboxToRectContourSource(worldBBox, 0, false);
		return tryComplexRing(outer, inner, worldBBox, expMil);
	}
	const source = await buildExpandedMaskSource(pad, padShape, expMil, rot);
	if (!source) {
		return undefined;
	}
	return eda.pcb_MathPolygon.createPolygon(source);
}

async function fillCreate(layer: FillLayer, polygon: IPCB_Polygon | IPCB_ComplexPolygon): Promise<IPCB_PrimitiveFill | undefined> {
	// 宿主 API 第二参名义为 IPCB_Polygon，实际接受复杂多边形或双轮廓源，勿强转为错误形态
	return eda.pcb_PrimitiveFill.create(layer, polygon as unknown as IPCB_Polygon, undefined, FILL_SOLID, 0, false);
}

async function createMaskFill(layer: FillLayer, maskPolygon: FillPolygon): ReturnType<typeof eda.pcb_PrimitiveFill.create> {
	const tryFill = (poly: IPCB_Polygon | IPCB_ComplexPolygon | PolygonSource[]) =>
		eda.pcb_PrimitiveFill.create(layer, poly as unknown as IPCB_Polygon, undefined, FILL_SOLID, 0, false);

	// 优先尝试「多轮廓源数组」：部分宿主对 IPCB_ComplexPolygon 包装不创建，对双轮廓数组可接受
	if ('getSourceStrictComplex' in maskPolygon && typeof (maskPolygon as IPCB_ComplexPolygon).getSourceStrictComplex === 'function') {
		const strict = (maskPolygon as IPCB_ComplexPolygon).getSourceStrictComplex();
		if (Array.isArray(strict) && strict.length >= 2) {
			try {
				const r = await tryFill(strict);
				if (r) {
					return r;
				}
			}
			catch {
				// fall through
			}
		}
	}
	if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
		const src = maskPolygon.getSource();
		if (Array.isArray(src) && src.length >= 2 && Array.isArray(src[0])) {
			try {
				const r = await tryFill(src as PolygonSource[]);
				if (r) {
					return r;
				}
			}
			catch {
				// fall through
			}
		}
	}

	try {
		return await fillCreate(layer, maskPolygon as IPCB_ComplexPolygon);
	}
	catch {
		if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
			const src = maskPolygon.getSource();
			if (Array.isArray(src) && src.length > 0 && Array.isArray(src[0])) {
				try {
					const outer = eda.pcb_MathPolygon.createPolygon(src[0] as PolygonSource);
					if (outer) {
						return await fillCreate(layer, outer);
					}
				}
				catch {
					const rectSource = rectContourToRectSource(src[0] as PolygonSource);
					if (rectSource) {
						const rect = eda.pcb_MathPolygon.createPolygon(rectSource);
						if (rect) {
							return await fillCreate(layer, rect);
						}
					}
				}
			}
		}
		throw new Error('create fill failed');
	}
}

async function finalizeFillForSettings(
	fill: IPCB_PrimitiveFill,
	settings: PadExpansionSettings,
	padElectricalLayer: TPCB_LayersOfPad,
): Promise<boolean> {
	fill.setState_FillMode(FILL_SOLID);
	if (settings.outputKind === 'solder_mask') {
		if (fill.isAsync()) {
			await fill.done();
		}
		return true;
	}
	const region = await fill.convertToRegion();
	if (!region) {
		try {
			await eda.pcb_PrimitiveFill.delete(fill);
		}
		catch {
			// ignore
		}
		return false;
	}
	region.setState_RuleType([settings.outputKind === 'forbidden_fill'
		? EPCB_PrimitiveRegionRuleType.NO_FILLS
		: EPCB_PrimitiveRegionRuleType.NO_POURS]);
	region.setState_Layer(padElectricalLayer as TPCB_LayersOfRegion);
	region.setState_LineWidth(0);
	if (region.isAsync()) {
		await region.done();
	}
	return true;
}

function showInputDialogAsync(before: string, after: string, title: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showInputDialog(before, after, title, 'number', '', { placeholder: '0', step: 0.000_001 }, resolve);
	});
}

function showConfirmationAsync(
	content: string,
	title: string,
	mainButtonTitle?: string,
	cancelButtonTitle?: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, mainButtonTitle, cancelButtonTitle, ok => resolve(Boolean(ok)));
	});
}

function showSelectKindAsync(t: (k: string, ...a: string[]) => string): Promise<PadExpansionOutputKind | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showSelectDialog(
			[
				{ value: 'forbidden_pour', displayContent: t('SolderMaskExpKindForbiddenPour') },
				{ value: 'forbidden_fill', displayContent: t('SolderMaskExpKindForbiddenFill') },
				{ value: 'solder_mask', displayContent: t('SolderMaskExpKindSolderMask') },
			],
			t('SolderMaskExpSelectKindBefore'),
			t('SolderMaskExpSelectKindAfter'),
			t('SolderMaskExpTitle'),
			'forbidden_pour',
			false,
			(v: string | undefined) => {
				resolve(v !== undefined && v !== '' && isPadExpansionOutputKind(v) ? v : undefined);
			},
		);
	});
}

async function collectPadsFromSelection(selected: IPCB_Primitive[]): Promise<{ pads: PadPrimitive[]; errors: string[] }> {
	const uniqueById = new Map<string, PadPrimitive>();
	const errors: string[] = [];
	for (const p of selected) {
		if (isPadPrimitive(p)) {
			uniqueById.set(p.getState_PrimitiveId(), p);
		}
	}
	for (const comp of selected.filter(isComponentPrimitive)) {
		try {
			const id = comp.getState_PrimitiveId();
			const byStatic = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
			const pinList = byStatic?.length
				? byStatic
				: await comp.toSync().getAllPins();
			for (const pad of pinList) {
				uniqueById.set(pad.getState_PrimitiveId(), pad);
			}
		}
		catch (e) {
			errors.push(`${comp.getState_Designator() ?? '?'}: ${errorMessage(e)}`);
		}
	}
	return { pads: [...uniqueById.values()], errors };
}

async function processPads(
	targetPads: PadPrimitive[],
	settings: PadExpansionSettings,
): Promise<{ created: number; errors: string[] }> {
	const te = (key: string) => eda.sys_I18n.text(key, undefined, undefined);
	let created = 0;
	const errors: string[] = [];

	for (const pad of targetPads) {
		const layer = pad.getState_Layer();
		const special = pad.getState_SpecialPad();
		const padShape = pad.getState_Pad();
		const label = padLabel(pad);

		if (!special?.length && !padShape) {
			errors.push(`${label}: no pad shape`);
			continue;
		}

		const maskLayers = solderMaskTargetsForPad(layer, special);
		const shapesToPlace: Array<{ shape: PadShape; layers: Set<FillLayer> }> = [];

		if (special?.length) {
			for (const [sa, sb, sh] of special) {
				const sub = new Set<FillLayer>();
				if (rangeCoversOuterLayer(sa, sb, LAYER_TOP)) {
					sub.add(LAYER_TOP_SOLDER_MASK);
				}
				if (rangeCoversOuterLayer(sa, sb, LAYER_BOTTOM)) {
					sub.add(LAYER_BOTTOM_SOLDER_MASK);
				}
				if (sub.size > 0) {
					shapesToPlace.push({ shape: sh, layers: sub });
				}
			}
		}
		else {
			if (!padShape) {
				errors.push(`${label}: no pad shape`);
				continue;
			}
			if (maskLayers.size === 0) {
				errors.push(`${label}: ${te('SolderMaskExpNoSolderMaskLayer')}`);
				continue;
			}
			shapesToPlace.push({ shape: padShape, layers: maskLayers });
		}

		if (shapesToPlace.length === 0) {
			errors.push(`${label}: ${te('SolderMaskExpNoShapeForSolderMask')}`);
			continue;
		}

		for (const { shape, layers } of shapesToPlace) {
			const useWholePadBBox = shapeNeedsWholePadBBox(shape) && !special?.length;
			for (const smLayer of layers) {
				const ipcMaskPoly = await buildExpandedMaskPolygon(pad, shape, settings.expMil, useWholePadBBox);
				if (!ipcMaskPoly) {
					errors.push(`${label}: invalid geometry`);
					continue;
				}
				let fill: IPCB_PrimitiveFill | undefined;
				try {
					fill = await createMaskFill(smLayer, ipcMaskPoly);
				}
				catch (e) {
					errors.push(`${label}: create fill failed (${errorMessage(e)})`);
					continue;
				}
				if (!fill) {
					errors.push(`${label}: create fill returned empty`);
					continue;
				}
				try {
					if (await finalizeFillForSettings(fill, settings, layer)) {
						created++;
					}
					else {
						errors.push(`${label}: ${te('SolderMaskExpFinalizeRegionFailed')}`);
					}
				}
				catch (e) {
					errors.push(`${label}: finalize failed (${errorMessage(e)})`);
				}
			}
		}
	}

	return { created, errors };
}

async function runInteractiveSelectionHandler(mouseProps?: PcbMouseSelectProp[]): Promise<void> {
	const settings = activeInteractiveSettings;
	if (!settings) {
		return;
	}
	if (interactiveProcessing) {
		pendingInteractiveSelection = true;
		pendingInteractiveMouseProps = mouseProps;
		return;
	}
	const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);
	interactiveProcessing = true;
	try {
		const selected = await resolveSelectedPrimitives(mouseProps);
		const { pads, errors: collectErrors } = await collectPadsFromSelection(selected);
		if (pads.length === 0) {
			// 已选中对象但未找到焊盘时提示用户
			if (selected.length > 0) {
				showPadExpToast(t('SolderMaskExpNoPadsInSelection'), ESYS_ToastMessageType.WARNING, t);
			}
			return;
		}
		const { created, errors } = await processPads(pads, settings);
		const allErr = [...collectErrors, ...errors];
		const errTail = allErr.length
			? `\n${t('SolderMaskExpErrors')}\n${allErr.slice(0, 5).join('\n')}${allErr.length > 5 ? '\n…' : ''}`
			: '';
		const toastType = allErr.length === 0
			? ESYS_ToastMessageType.SUCCESS
			: created === 0
				? ESYS_ToastMessageType.ERROR
				: ESYS_ToastMessageType.WARNING;
		showPadExpToast(
			t('SolderMaskExpInteractiveToast', String(created), String(pads.length)) + errTail,
			toastType,
			t,
		);
	}
	catch (e) {
		showPadExpToast(t('SolderMaskExpFailed', errorMessage(e)), ESYS_ToastMessageType.ERROR, t);
	}
	finally {
		interactiveProcessing = false;
		if (pendingInteractiveSelection && activeInteractiveSettings) {
			pendingInteractiveSelection = false;
			const nextProps = pendingInteractiveMouseProps;
			pendingInteractiveMouseProps = undefined;
			// 直接处理下一轮，避免再经 debounce 丢 props 或额外延迟
			void runInteractiveSelectionHandler(nextProps);
		}
	}
}

function scheduleInteractiveProcess(mouseProps?: PcbMouseSelectProp[]): void {
	if (selectionDebounceTimer !== undefined) {
		clearTimeout(selectionDebounceTimer);
	}
	const captured: PcbMouseSelectProp[] | undefined = mouseProps === undefined
		? undefined
		: (mouseProps.length > 0 ? mouseProps : undefined);
	selectionDebounceTimer = setTimeout(() => {
		selectionDebounceTimer = undefined;
		void runInteractiveSelectionHandler(captured);
	}, SELECT_DEBOUNCE_MS);
}

function registerInteractiveMouseListener(t: (k: string, ...a: string[]) => string): void {
	eda.pcb_Event.removeEventListener(MOUSE_LISTENER_ID);
	// 使用 'all' 再过滤 SELECTED：部分环境下仅注册 SELECTED 时回调不触发
	eda.pcb_Event.addMouseEventListener(
		MOUSE_LISTENER_ID,
		'all',
		(eventType, props) => {
			// 使用字符串比较，避免 EPCB_MouseEventType 运行时未定义
			const et = String(eventType).toLowerCase();
			const isSelected = et === 'selected';
			if (!isSelected || !activeInteractiveSettings) {
				return;
			}
			scheduleInteractiveProcess(normalizeMouseProps(props));
		},
	);
	showPadExpToast(t('SolderMaskExpInteractiveHint'), ESYS_ToastMessageType.INFO, t);
	registerInteractiveExitListeners(t);
	// 应用后立即尝试当前选中（无需再等一次选中事件）
	scheduleInteractiveProcess();
}

function stopInteractiveMode(): void {
	eda.pcb_Event.removeEventListener(MOUSE_LISTENER_ID);
	unregisterInteractiveExitListeners();
	activeInteractiveSettings = undefined;
	interactiveProcessing = false;
	pendingInteractiveSelection = false;
	pendingInteractiveMouseProps = undefined;
	if (selectionDebounceTimer !== undefined) {
		clearTimeout(selectionDebounceTimer);
		selectionDebounceTimer = undefined;
	}
}

async function promptExpansionMil(
	unit: Awaited<ReturnType<typeof eda.sys_Unit.getFrontendDataUnit>>,
	hint: string,
	t: (k: string, ...a: string[]) => string,
): Promise<number | undefined> {
	for (;;) {
		const input = await showInputDialogAsync(
			t('SolderMaskExpInputBefore', hint),
			t('SolderMaskExpInputAfter', String(MAX_EXP_MIL)),
			t('SolderMaskExpInputTitle'),
		);
		if (input === undefined) {
			return undefined;
		}
		const converted = convertInputToMil(String(input), unit);
		if (converted === null) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpInvalidNumber'), t('SolderMaskExpTitle'));
			continue;
		}
		if (converted <= 0) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpNeedPositive'), t('SolderMaskExpTitle'));
			continue;
		}
		if (converted > MAX_EXP_MIL) {
			eda.sys_Dialog.showInformationMessage(t('SolderMaskExpTooLarge', String(MAX_EXP_MIL)), t('SolderMaskExpTitle'));
			continue;
		}
		return converted;
	}
}

export async function runPadSolderMaskExpansion(): Promise<void> {
	const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);
	stopInteractiveMode();
	try {
		if (!(await checkPcbDocumentActive())) {
			eda.sys_Dialog.showConfirmationMessage(t('SolderMaskExpNeedPcb'), t('SolderMaskExpTitle'));
			return;
		}
		const kind = await showSelectKindAsync(t);
		if (kind === undefined) {
			return;
		}
		const unit = await eda.sys_Unit.getFrontendDataUnit();
		const expMil = await promptExpansionMil(unit, unitHint(unit), t);
		if (expMil === undefined) {
			return;
		}
		if (!(await showConfirmationAsync(
			t('SolderMaskExpApplyInteractiveBefore', unitHint(unit)),
			t('SolderMaskExpTitle'),
			t('SolderMaskExpApplyInteractiveMain'),
			t('SolderMaskExpApplyInteractiveCancel'),
		))) {
			return;
		}
		activeInteractiveSettings = { outputKind: kind, expMil };
		registerInteractiveMouseListener(t);
	}
	catch (err) {
		eda.sys_Dialog.showConfirmationMessage(
			eda.sys_I18n.text('SolderMaskExpFailed', undefined, undefined, err instanceof Error ? err.message : String(err)),
			t('SolderMaskExpTitle'),
		);
	}
}

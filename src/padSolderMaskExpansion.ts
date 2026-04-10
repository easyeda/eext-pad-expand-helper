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
const CIRCLE_POLYLINE_SEGMENTS = 48;
const SELECT_DEBOUNCE_MS = 120;
/** Toast 自动关闭：`showToastMessage` 第 3 参为秒数，`0` 为不自动关闭（勿误传毫秒） */
const TOAST_AUTO_CLOSE_SEC = 20;

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

/** 半径 r、顶点数 n 的闭合折线（圆与正多边形共用） */
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
	return ['R', wx - ew / 2, wy + eh / 2, ew, eh, rotDeg, 0];
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
			return closedRadialPolyline(cx, cy, Math.max(w, h) / 2, CIRCLE_POLYLINE_SEGMENTS, true);
		}
		return ['R', cx - w / 2, cy + h / 2, w, h, rotDeg, 0];
	}
	if (padShape[0] === PAD_SHAPE_RECT) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		return ['R', cx - w / 2, cy + h / 2, w, h, rotDeg, 0];
	}
	if (padShape[0] === PAD_SHAPE_NGON) {
		const diameter = padShape[1] + e2;
		const sides = Math.min(64, Math.max(3, typeof padShape[2] === 'number' ? padShape[2] : 6));
		return closedRadialPolyline(cx, cy, Math.max(diameter / 2, 0), sides, true);
	}
	return undefined;
}

function shapeNeedsWholePadBBox(s: PadShape): boolean {
	return s[0] === PAD_SHAPE_OVAL
		|| (s[0] === PAD_SHAPE_ELLIPSE && Math.abs(s[1] - s[2]) >= 1e-6);
}

function isCirclePadShape(shape: PadShape): boolean {
	return shape[0] === PAD_SHAPE_ELLIPSE && Math.abs(shape[1] - shape[2]) < 1e-6;
}

function circleInnerFromWorldBBox(bbox: { minX: number; minY: number; maxX: number; maxY: number }): {
	cx: number;
	cy: number;
	rInner: number;
} | undefined {
	const w = bbox.maxX - bbox.minX;
	const h = bbox.maxY - bbox.minY;
	const rInner = Math.min(w, h) / 2;
	if (!(rInner > 0)) {
		return undefined;
	}
	return {
		cx: (bbox.minX + bbox.maxX) / 2,
		cy: (bbox.minY + bbox.maxY) / 2,
		rInner,
	};
}

async function getPadWorldBBox(pad: PadPrimitive): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | undefined> {
	try {
		return (await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()])) ?? undefined;
	}
	catch {
		return undefined;
	}
}

async function buildExpandedMaskSource(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	useWholePadBBox: boolean,
	worldBBoxKnownMissing?: boolean,
): Promise<PolygonSource | undefined> {
	const worldBBox = worldBBoxKnownMissing ? undefined : await getPadWorldBBox(pad);
	if (worldBBox) {
		return bboxToExpandedRectSource(worldBBox, expMil);
	}
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rot = pad.getState_Rotation();
	if (padShape[0] === PAD_SHAPE_POLYGON) {
		return expandLocalPolygonPadData((padShape as [typeof PAD_SHAPE_POLYGON, PolyData])[1], cx, cy, rot, expMil);
	}
	if (useWholePadBBox && shapeNeedsWholePadBBox(padShape)) {
		const bbox = await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()]);
		if (bbox) {
			return bboxToExpandedRectSource(bbox, expMil);
		}
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
	useWholePadBBox: boolean,
): Promise<FillPolygon | undefined> {
	const worldBBox = await getPadWorldBBox(pad);
	if (worldBBox && isCirclePadShape(padShape)) {
		const g = circleInnerFromWorldBBox(worldBBox);
		if (g) {
			const { cx, cy, rInner } = g;
			const rOuter = rInner + expMil;
			const outer = closedRadialPolyline(cx, cy, rOuter, CIRCLE_POLYLINE_SEGMENTS, true);
			const inner = closedRadialPolyline(cx, cy, rInner, CIRCLE_POLYLINE_SEGMENTS, false);
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
	if (worldBBox) {
		const outer = bboxToRectContourSource(worldBBox, expMil, true);
		const inner = bboxToRectContourSource(worldBBox, 0, false);
		return tryComplexRing(outer, inner, worldBBox, expMil);
	}
	const source = await buildExpandedMaskSource(pad, padShape, expMil, useWholePadBBox, !worldBBox);
	if (!source) {
		return undefined;
	}
	return eda.pcb_MathPolygon.createPolygon(source);
}

async function fillCreate(layer: FillLayer, polygon: IPCB_Polygon): Promise<IPCB_PrimitiveFill | undefined> {
	return eda.pcb_PrimitiveFill.create(layer, polygon, undefined, FILL_SOLID, 0, false);
}

async function createMaskFill(layer: FillLayer, maskPolygon: FillPolygon): ReturnType<typeof eda.pcb_PrimitiveFill.create> {
	try {
		return await fillCreate(layer, maskPolygon as IPCB_Polygon);
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
			const isSelected = eventType === EPCB_MouseEventType.SELECTED
				|| String(eventType) === 'selected';
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

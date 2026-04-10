/**
 * 选中焊盘/器件 → 按焊盘外形在顶层/底层阻焊层生成外扩禁止区外环（局部阻焊几何）。
 *
 * - PCB 内部单位：mil（见 {@link SYS_Unit} 说明）
 * - 用户输入单位：{@link SYS_Unit.getFrontendDataUnit}（与 eext-interactive-bom / 画布一致）
 * - 几何：{@link PCB_MathPolygon}、{@link PCB_PrimitiveFill}；椭圆/长圆可用 {@link PCB_Primitive.getPrimitivesBBox} 取世界包围盒
 */

const LAYER_TOP: TPCB_LayersOfPad = EPCB_LayerId.TOP;
const LAYER_BOTTOM: TPCB_LayersOfPad = EPCB_LayerId.BOTTOM;
const LAYER_MULTI: TPCB_LayersOfPad = EPCB_LayerId.MULTI;
const LAYER_TOP_SOLDER_MASK: TPCB_LayersOfFill = EPCB_LayerId.TOP_SOLDER_MASK;
const LAYER_BOTTOM_SOLDER_MASK: TPCB_LayersOfFill = EPCB_LayerId.BOTTOM_SOLDER_MASK;

const PRIMITIVE_COMPONENT = EPCB_PrimitiveType.COMPONENT;
const PRIMITIVE_PAD = EPCB_PrimitiveType.PAD;
const PRIMITIVE_COMPONENT_PAD = EPCB_PrimitiveType.COMPONENT_PAD;

const PAD_SHAPE_ELLIPSE = EPCB_PrimitivePadShapeType.ELLIPSE;
const PAD_SHAPE_OVAL = EPCB_PrimitivePadShapeType.OBLONG;
const PAD_SHAPE_RECT = EPCB_PrimitivePadShapeType.RECTANGLE;
const PAD_SHAPE_NGON = EPCB_PrimitivePadShapeType.REGULAR_POLYGON;
const PAD_SHAPE_POLYGON = EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON;

const FILL_SOLID = EPCB_PrimitiveFillMode.SOLID;
const MAX_EXP_MIL = 2000;

type PadPrimitive = IPCB_PrimitivePad | IPCB_PrimitiveComponentPad;
type PadShape = TPCB_PrimitivePadShape;
type SpecialPad = TPCB_PrimitiveSpecialPadShape;
type PolygonSource = TPCB_PolygonSourceArray;
type PolyData = Extract<PadShape, [typeof PAD_SHAPE_POLYGON, unknown]>[1];
type FillLayer = Parameters<typeof eda.pcb_PrimitiveFill.create>[0];
type FillPolygon = IPCB_Polygon | IPCB_ComplexPolygon;
/** 禁止区域所属层；与 {@link TPCB_LayersOfPad} 的 TOP / BOTTOM / MULTI 兼容 */
type RegionLayer = TPCB_LayersOfRegion;

function degToRad(d: number): number {
	return (d * Math.PI) / 180;
}

function checkPcbDocumentActive(): Promise<boolean> {
	return eda.dmt_SelectControl.getCurrentDocumentInfo()
		.then(doc => doc?.documentType === EDMT_EditorDocumentType.PCB)
		.catch(() => false);
}

function isPadPrimitive(p: IPCB_Primitive): p is PadPrimitive {
	const t = p.getState_PrimitiveType();
	return t === PRIMITIVE_PAD || t === PRIMITIVE_COMPONENT_PAD;
}

function isComponentPrimitive(p: IPCB_Primitive): p is IPCB_PrimitiveComponent {
	return p.getState_PrimitiveType() === PRIMITIVE_COMPONENT;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * 禁止区域图元图层与焊盘电气层一致（官方 {@link TPCB_LayersOfPad} ⊆ {@link TPCB_LayersOfRegion} 中的 TOP / BOTTOM / MULTI）。
 */
function padLayerToRegionLayer(layer: TPCB_LayersOfPad): RegionLayer {
	return layer as RegionLayer;
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

function rangeTouchesOuterTop(startLayer: number, endLayer: number): boolean {
	const lo = Math.min(startLayer, endLayer);
	const hi = Math.max(startLayer, endLayer);
	return lo <= LAYER_TOP && hi >= LAYER_TOP;
}

function rangeTouchesOuterBottom(startLayer: number, endLayer: number): boolean {
	const lo = Math.min(startLayer, endLayer);
	const hi = Math.max(startLayer, endLayer);
	return lo <= LAYER_BOTTOM && hi >= LAYER_BOTTOM;
}

/** 无特殊焊堆叠时，由焊盘电气层推断要画的阻焊侧 */
function solderMaskTargetsForPad(layer: TPCB_LayersOfPad, specialPad: SpecialPad | undefined): Set<FillLayer> {
	const layers = new Set<FillLayer>();
	if (specialPad && specialPad.length > 0) {
		for (const [a, b] of specialPad) {
			if (rangeTouchesOuterTop(a, b)) {
				layers.add(LAYER_TOP_SOLDER_MASK);
			}
			if (rangeTouchesOuterBottom(a, b)) {
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

/**
 * 世界轴对齐包围盒各边外扩 expMil 后的 R 多边形（旋转 0）。
 * PCB 数据坐标为 Y 轴向上；{@link TPCB_PolygonSourceArray} 中 R 的 x,y 为矩形**左上角**（非中心）。
 */
function bboxToExpandedRectSource(
	bbox: { minX: number; minY: number; maxX: number; maxY: number },
	expMil: number,
): PolygonSource {
	const w = bbox.maxX - bbox.minX + 2 * expMil;
	const h = bbox.maxY - bbox.minY + 2 * expMil;
	const topLeftX = bbox.minX - expMil;
	const topLeftY = bbox.maxY + expMil;
	return ['R', topLeftX, topLeftY, w, h, 0, 0];
}

/**
 * 世界坐标 BBox -> 矩形折线源（用于复杂多边形布尔组合）
 * clockwise=true 生成顺时针，false 生成逆时针。
 */
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

/**
 * 将由 bboxToRectContourSource 生成的折线矩形源还原成 R 源。
 * 用于运行时不接受折线复杂多边形时的保底降级。
 */
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

/**
 * 折线/复杂多边形焊盘：以外形数学包围盒中心相对焊盘锚点旋转到世界坐标，再外扩为 R（与焊盘旋转一致）。
 */
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
	const rad = degToRad(rotDeg);
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const wx = cx + lc.x * cos - lc.y * sin;
	const wy = cy + lc.x * sin + lc.y * cos;
	const ew = w + 2 * expMil;
	const eh = h + 2 * expMil;
	// R：左上角；wx/wy 为外形中心（世界坐标，Y 向上）
	return ['R', wx - ew / 2, wy + eh / 2, ew, eh, rotDeg, 0];
}

/** 解析型几何：圆、矩形、正多边形（外接圆近似） */
function expandAnalyticShapeToSource(
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
			const r = Math.max(w, h) / 2;
			return ['CIRCLE', cx, cy, r];
		}
		// 非圆椭圆：由调用方改走 BBox
		return ['R', cx - w / 2, cy + h / 2, w, h, rotDeg, 0];
	}

	if (padShape[0] === PAD_SHAPE_RECT) {
		const w = padShape[1] + e2;
		const h = padShape[2] + e2;
		const round = Math.max(0, padShape[3] + expMil);
		return ['R', cx - w / 2, cy + h / 2, w, h, rotDeg, round];
	}

	if (padShape[0] === PAD_SHAPE_NGON) {
		const diameter = padShape[1] + e2;
		const r = Math.max(diameter / 2, 0);
		return ['CIRCLE', cx, cy, r];
	}

	return undefined;
}

function shapeIsPolylinePolygon(s: PadShape): boolean {
	return s[0] === PAD_SHAPE_POLYGON;
}

function shapeNeedsWholePadBBox(s: PadShape): boolean {
	if (s[0] === PAD_SHAPE_OVAL) {
		return true;
	}
	if (s[0] === PAD_SHAPE_ELLIPSE && Math.abs(s[1] - s[2]) >= 1e-6) {
		return true;
	}
	return false;
}

/** 圆形焊盘：椭圆外形且宽高相等（与 {@link expandAnalyticShapeToSource} 中圆判据一致） */
function isCirclePadShape(shape: PadShape): boolean {
	return shape[0] === PAD_SHAPE_ELLIPSE && Math.abs(shape[1] - shape[2]) < 1e-6;
}

/**
 * 由世界轴对齐包围盒得到圆形焊盘的世界圆心与内圆半径（mil）。
 * 仅当 {@link isCirclePadShape} 为真时调用；用 min(w,h)/2 抗数值误差。
 */
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

/**
 * 获取焊盘的世界坐标边界框。
 * 对 ComponentPad 必须使用此方法，因为其 getState_X/Y 返回的是相对于器件的本地坐标。
 */
async function getPadWorldBBox(pad: PadPrimitive): Promise<{ minX: number; minY: number; maxX: number; maxY: number } | undefined> {
	try {
		const bbox = await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()]);
		if (bbox) {
			return bbox;
		}
	}
	catch {
		// 忽略错误，返回 undefined
	}
	return undefined;
}

/**
 * 生成阻焊层用的外扩单多边形数据源。
 *
 * @param pad - 器件焊盘图元
 * @param padShape - 焊盘外形（与 special 段一致）
 * @param expMil - 外扩量（mil）
 * @param useWholePadBBox - 仅当无法取得世界 BBox 时：对长圆/非圆椭圆等用整块焊盘 BBox 外扩（特殊焊分层上应为 false）
 */
async function buildExpandedMaskSource(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	useWholePadBBox: boolean,
): Promise<PolygonSource | undefined> {
	// 优先使用世界坐标边界框，确保 ComponentPad 的位置正确
	const worldBBox = await getPadWorldBBox(pad);
	if (worldBBox) {
		// 一律用世界坐标轴对齐包围盒外扩：getPrimitivesBBox 已反映焊盘在板上的真实位置与旋转后的范围。
		// 若在此用「BBox 中心 + R 矩形 + rot」重建解析外形，多边形里 R 的旋转支点若与焊盘中心不一致，
		// 禁止区会相对铜皮偏移（底层/旋转器件上尤其明显）。
		return bboxToExpandedRectSource(worldBBox, expMil);
	}

	// 回退到原来的本地坐标方法（适用于自由焊盘）
	const cx = pad.getState_X();
	const cy = pad.getState_Y();
	const rot = pad.getState_Rotation();

	if (shapeIsPolylinePolygon(padShape)) {
		return expandLocalPolygonPadData((padShape as [typeof PAD_SHAPE_POLYGON, PolyData])[1], cx, cy, rot, expMil);
	}

	if (useWholePadBBox && shapeNeedsWholePadBBox(padShape)) {
		const bbox = await eda.pcb_Primitive.getPrimitivesBBox([pad.getState_PrimitiveId()]);
		if (bbox) {
			return bboxToExpandedRectSource(bbox, expMil);
		}
	}

	return expandAnalyticShapeToSource(padShape, cx, cy, rot, expMil);
}

/**
 * 构建用于禁止区的多边形：
 * - 优先使用世界 BBox 生成“外框 - 内框”的外环，避免 ComponentPad 坐标系带来的偏移
 * - 回退到原有单多边形逻辑
 */
async function buildExpandedMaskPolygon(
	pad: PadPrimitive,
	padShape: PadShape,
	expMil: number,
	useWholePadBBox: boolean,
): Promise<FillPolygon | undefined> {
	const worldBBox = await getPadWorldBBox(pad);
	if (worldBBox && isCirclePadShape(padShape)) {
		const circleGeom = circleInnerFromWorldBBox(worldBBox);
		if (circleGeom) {
			const { cx, cy, rInner } = circleGeom;
			const rOuter = rInner + expMil;
			const outerCircle: PolygonSource = ['CIRCLE', cx, cy, rOuter];
			const innerCircle: PolygonSource = ['CIRCLE', cx, cy, rInner];
			const ring = eda.pcb_MathPolygon.createComplexPolygon([outerCircle, innerCircle]);
			if (ring) {
				return ring;
			}
			const outerOnly = eda.pcb_MathPolygon.createPolygon(outerCircle);
			if (outerOnly) {
				return outerOnly;
			}
		}
	}
	if (worldBBox) {
		const outer = bboxToRectContourSource(worldBBox, expMil, true);
		const inner = bboxToRectContourSource(worldBBox, 0, false);
		const ring = eda.pcb_MathPolygon.createComplexPolygon([outer, inner]);
		if (ring) {
			return ring;
		}
		const outerOnly = eda.pcb_MathPolygon.createPolygon(bboxToExpandedRectSource(worldBBox, expMil));
		if (outerOnly) {
			return outerOnly;
		}
		return undefined;
	}

	const source = await buildExpandedMaskSource(pad, padShape, expMil, useWholePadBBox);
	if (!source) {
		return undefined;
	}
	return eda.pcb_MathPolygon.createPolygon(source);
}

/**
 * SDK 类型声明里 create() 第 2 参数为 IPCB_Polygon；
 * 运行时可接受 IPCB_ComplexPolygon（用于外环）。这里集中收口一次断言，避免主流程散落。
 */
async function createMaskFill(
	layer: FillLayer,
	maskPolygon: FillPolygon,
): ReturnType<typeof eda.pcb_PrimitiveFill.create> {
	try {
		return await eda.pcb_PrimitiveFill.create(
			layer,
			maskPolygon as IPCB_Polygon,
			undefined,
			FILL_SOLID,
			0,
			false,
		);
	}
	catch {
		// 某些运行时版本不接受 IPCB_ComplexPolygon 作为 create() 第 2 参数；
		// 回退为复杂多边形的第一条外轮廓，保证命令可继续执行。
		if ('getSource' in maskPolygon && typeof maskPolygon.getSource === 'function') {
			const src = maskPolygon.getSource();
			if (Array.isArray(src) && src.length > 0 && Array.isArray(src[0])) {
				try {
					const outer = eda.pcb_MathPolygon.createPolygon(src[0] as PolygonSource);
					if (outer) {
						return await eda.pcb_PrimitiveFill.create(
							layer,
							outer,
							undefined,
							FILL_SOLID,
							0,
							false,
						);
					}
				}
				catch {
					const first = src[0] as PolygonSource;
					if (first[0] === 'CIRCLE') {
						const circle = eda.pcb_MathPolygon.createPolygon(first);
						if (circle) {
							return eda.pcb_PrimitiveFill.create(
								layer,
								circle,
								undefined,
								FILL_SOLID,
								0,
								false,
							);
						}
					}
					const rectSource = rectContourToRectSource(first);
					if (rectSource) {
						const rect = eda.pcb_MathPolygon.createPolygon(rectSource);
						if (rect) {
							return eda.pcb_PrimitiveFill.create(
								layer,
								rect,
								undefined,
								FILL_SOLID,
								0,
								false,
							);
						}
					}
				}
			}
		}
		throw new Error('create fill failed');
	}
}

// 不再需要 commitFillIfNeeded，创建后直接转换为禁止区域

function showInputDialogAsync(before: string, after: string, title: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showInputDialog(
			before,
			after,
			title,
			'number',
			'',
			{ placeholder: '0', step: 0.000_001 },
			(v: string | undefined) => resolve(v),
		);
	});
}

function showConfirmationAsync(
	content: string,
	title: string,
	mainButtonTitle?: string,
	cancelButtonTitle?: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(
			content,
			title,
			mainButtonTitle,
			cancelButtonTitle,
			ok => resolve(Boolean(ok)),
		);
	});
}

async function collectSelectedPads(
	selected: IPCB_Primitive[],
): Promise<{ pads: PadPrimitive[]; selectedPadCount: number; selectedComponentCount: number; errors: string[] }> {
	const selectedPads = selected.filter(isPadPrimitive);
	const components = selected.filter(isComponentPrimitive);

	const uniqueById = new Map<string, PadPrimitive>();
	const errors: string[] = [];

	for (const pad of selectedPads) {
		uniqueById.set(pad.getState_PrimitiveId(), pad);
	}

	// 如果用户已经直接选中了焊盘，则只按焊盘处理，不再额外展开器件，避免“多生成到同器件其它焊盘”的误判
	if (selectedPads.length > 0) {
		return {
			pads: Array.from(uniqueById.values()),
			selectedPadCount: selectedPads.length,
			selectedComponentCount: components.length,
			errors,
		};
	}

	for (const comp of components) {
		try {
			const pins = await comp.getAllPins();
			for (const pad of pins) {
				uniqueById.set(pad.getState_PrimitiveId(), pad);
			}
		}
		catch (e) {
			errors.push(`${comp.getState_Designator() ?? '?'}: ${errorMessage(e)}`);
		}
	}

	return {
		pads: Array.from(uniqueById.values()),
		selectedPadCount: selectedPads.length,
		selectedComponentCount: components.length,
		errors,
	};
}

export async function runPadSolderMaskExpansion(): Promise<void> {
	const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

	try {
		if (!(await checkPcbDocumentActive())) {
			eda.sys_Dialog.showConfirmationMessage(t('SolderMaskExpNeedPcb'), t('SolderMaskExpTitle'));
			return;
		}

		const selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();
		const {
			pads: targetPads,
			selectedPadCount,
			selectedComponentCount,
			errors: collectErrors,
		} = await collectSelectedPads(selected);

		if (targetPads.length === 0) {
			eda.sys_Dialog.showConfirmationMessage(t('SolderMaskExpSelectPad'), t('SolderMaskExpTitle'));
			return;
		}

		const unit = await eda.sys_Unit.getFrontendDataUnit();
		const hint = unitHint(unit);
		let expMil = -1;
		let marginInput = '';
		// 允许用户在同一命令里修正输入，不需要重复点菜单
		for (;;) {
			const input = await showInputDialogAsync(
				t('SolderMaskExpInputBefore', hint),
				t('SolderMaskExpInputAfter', String(MAX_EXP_MIL)),
				t('SolderMaskExpInputTitle'),
			);
			if (input === undefined) {
				return;
			}

			marginInput = String(input);
			const converted = convertInputToMil(marginInput, unit);
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
			expMil = converted;
			break;
		}

		const confirmCreate = await showConfirmationAsync(
			t('SolderMaskExpConfirm', String(targetPads.length), String(selected.length), marginInput, hint),
			t('SolderMaskExpTitle'),
			t('SolderMaskExpConfirmMain'),
			t('SolderMaskExpConfirmCancel'),
		);
		if (!confirmCreate) {
			return;
		}

		const modeInput = await showInputDialogAsync(
			t('SolderMaskExpModeInputBefore'),
			t('SolderMaskExpModeInputAfter'),
			t('SolderMaskExpModeInputTitle'),
		);
		if (modeInput === undefined) {
			return;
		}
		const previewOnly = String(modeInput).trim() === '1';

		let plannedFillCount = 0;
		let plannedTopFillCount = 0;
		let plannedBottomFillCount = 0;
		let createdFillCount = 0;
		let createdTopFillCount = 0;
		let createdBottomFillCount = 0;
		let processedPadCount = 0;
		const errors: string[] = [...collectErrors];
		const startAt = Date.now();

		for (const pad of targetPads) {
			processedPadCount++;
			const layer = pad.getState_Layer();
			const special = pad.getState_SpecialPad();
			const padShape = pad.getState_Pad();

			if (!special?.length && !padShape) {
				errors.push(`${pad.getState_PadNumber() ?? '?'}: no pad shape`);
				continue;
			}

			const maskLayers = solderMaskTargetsForPad(layer, special);
			const shapesToPlace: Array<{ shape: PadShape; layers: Set<number> }> = [];

			if (special?.length) {
				for (const [sa, sb, sh] of special) {
					const sub = new Set<FillLayer>();
					if (rangeTouchesOuterTop(sa, sb)) {
						sub.add(LAYER_TOP_SOLDER_MASK);
					}
					if (rangeTouchesOuterBottom(sa, sb)) {
						sub.add(LAYER_BOTTOM_SOLDER_MASK);
					}
					if (sub.size > 0) {
						shapesToPlace.push({ shape: sh, layers: sub });
					}
				}
			}
			else {
				const baseShape = padShape;
				if (!baseShape) {
					errors.push(`${pad.getState_PadNumber() ?? '?'}: no pad shape`);
					continue;
				}
				shapesToPlace.push({ shape: baseShape, layers: maskLayers });
			}

			for (const { shape, layers } of shapesToPlace) {
				const useWholePadBBox = shapeNeedsWholePadBBox(shape) && !special?.length;

				for (const smLayer of layers) {
					const ipcMaskPoly = await buildExpandedMaskPolygon(pad, shape, expMil, useWholePadBBox);
					if (!ipcMaskPoly) {
						errors.push(`${pad.getState_PadNumber() ?? '?'}: invalid geometry`);
						continue;
					}
					plannedFillCount++;
					if (smLayer === LAYER_TOP_SOLDER_MASK) {
						plannedTopFillCount++;
					}
					else if (smLayer === LAYER_BOTTOM_SOLDER_MASK) {
						plannedBottomFillCount++;
					}
					if (previewOnly) {
						continue;
					}
					let fill: IPCB_PrimitiveFill | undefined;
					try {
						fill = await createMaskFill(smLayer, ipcMaskPoly);
					}
					catch (e) {
						errors.push(`${pad.getState_PadNumber() ?? '?'}: create fill failed (${errorMessage(e)})`);
						continue;
					}
					if (!fill) {
						errors.push(`${pad.getState_PadNumber() ?? '?'}: create fill returned empty`);
						continue;
					}
					// 转为禁止区 Region，并设置为“禁止填充区域”
					fill.setState_FillMode(FILL_SOLID);
					const region = await fill.convertToRegion();
					if (!region) {
						continue;
					}
					region.setState_RuleType([EPCB_PrimitiveRegionRuleType.NO_FILLS]);
					region.setState_Layer(padLayerToRegionLayer(layer));
					region.setState_LineWidth(0);
					if (region.isAsync()) {
						await region.done();
					}
					createdFillCount++;
					if (smLayer === LAYER_TOP_SOLDER_MASK) {
						createdTopFillCount++;
					}
					else if (smLayer === LAYER_BOTTOM_SOLDER_MASK) {
						createdBottomFillCount++;
					}
				}
			}
		}

		const errTail = errors.length
			? `\n\n${t('SolderMaskExpErrors')}\n${errors.slice(0, 8).join('\n')}${errors.length > 8 ? '\n…' : ''}`
			: '';
		const elapsedMs = Date.now() - startAt;
		const resultKey = previewOnly ? 'SolderMaskExpPreviewResult' : 'SolderMaskExpResult';
		eda.sys_Dialog.showInformationMessage(
			t(
				resultKey,
				String(targetPads.length),
				String(processedPadCount),
				String(previewOnly ? plannedFillCount : createdFillCount),
				hint,
				String(previewOnly ? plannedTopFillCount : createdTopFillCount),
				String(previewOnly ? plannedBottomFillCount : createdBottomFillCount),
				String(elapsedMs),
				String(selectedPadCount),
				String(selectedComponentCount),
			) + errTail,
			t('SolderMaskExpDoneTitle'),
		);
	}
	catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		eda.sys_Dialog.showConfirmationMessage(
			eda.sys_I18n.text('SolderMaskExpFailed', undefined, undefined, msg),
			t('SolderMaskExpTitle'),
		);
	}
}

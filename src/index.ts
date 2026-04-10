/**
 * 入口文件
 *
 * 本文件为默认扩展入口文件，如果你想要配置其它文件作为入口文件，
 * 请修改 `extension.json` 中的 `entry` 字段；
 *
 * 请在此处使用 `export`  导出所有你希望在 `headerMenus` 中引用的方法，
 * 方法通过方法名与 `headerMenus` 关联。
 *
 * 如需了解更多开发细节，请阅读：
 * https://prodocs.lceda.cn/cn/api/guide/
 */
import * as extensionConfig from '../extension.json';

import { runPadSolderMaskExpansion } from './padSolderMaskExpansion';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

/** 配置类型与外扩尺寸 → 连续点选/框选焊盘或器件，按焊盘生成禁止区域或阻焊层填充（折线拟合） */
export function generatePadSolderMaskExpansion(): void {
	runPadSolderMaskExpansion().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		eda.sys_Dialog.showConfirmationMessage(
			eda.sys_I18n.text('SolderMaskExpFailed', undefined, undefined, msg),
			eda.sys_I18n.text('SolderMaskExpTitle', undefined, undefined),
		);
	});
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('PadSolderMaskGuardVersion', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

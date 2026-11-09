// 资源管理器右键菜单：只写当前用户HKCU，无需管理员权限，也不修改默认打开方式。
// 本模块不依赖electron，便于scripts/menu.mjs在纯Node环境复用。

'use strict';

const {execFileSync} = require('node:child_process');

/** 注册表菜单键的固定前缀，卸载时按此前缀整体删除 */
const TOOL_KEY = 'MermaidDrawioTool';

/** 需要注册右键菜单的扩展名 */
const EXTENSIONS = ['.mmd', '.mermaid', '.drawio', '.dio'];

/**
 * 执行reg.exe命令。
 * @param {string[]} args 参数数组，避免shell拼接
 * @returns {string} 标准输出
 * @throws {Error} reg.exe返回非零码时抛出
 */
function runReg(args) {
	try {
		return execFileSync('reg.exe', args, {windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
	} catch (error) {
		const stderr = error.stderr ? String(error.stderr).trim() : '';
		throw new Error(`reg ${args.slice(0, 2).join(' ')} 失败: ${stderr || error.message}`);
	}
}

/**
 * 写入默认值。
 * @param {string} key 注册表键
 * @param {string} value 值内容
 */
function setDefault(key, value) {
	runReg(['add', key, '/ve', '/d', value, '/f']);
}

/**
 * 写入命名值。
 * @param {string} key 注册表键
 * @param {string} name 值名称
 * @param {string} value 值内容
 */
function setValue(key, name, value) {
	runReg(['add', key, '/v', name, '/d', value, '/f']);
}

/**
 * 生成菜单项命令，开发态需要附带应用目录参数。
 * @param {string} exe 可执行文件路径
 * @param {string|null} appRoot 应用根目录，打包后为null
 * @param {string} flag 命令行开关
 * @returns {string} 完整命令行
 */
function buildCommand(exe, appRoot, flag) {
	const parts = [`"${exe}"`];
	if (appRoot) {
		parts.push(`"${appRoot}"`);
	}
	parts.push(flag, '"%1"');
	return parts.join(' ');
}

/**
 * 按扩展名生成菜单项定义。
 * @param {string} ext 扩展名，含前导点
 * @returns {Array<{verb: string, label: string, flag: string}>} 菜单项
 */
function verbsFor(ext) {
	const list = [{verb: 'Preview', label: '打开Mermaid预览', flag: '--preview'}];
	if (ext === '.mmd' || ext === '.mermaid') {
		list.push({verb: 'ToDrawio', label: '转为Drawio文件', flag: '--to-drawio'});
	}
	list.push({verb: 'ToPng', label: '转为PNG图片', flag: '--to-png'});
	return list;
}

/**
 * 安装右键菜单与"打开方式"候选。
 * @param {{exe: string, appRoot: string|null}} options 可执行文件与应用根目录
 * @returns {{ok: boolean, message: string}} 安装结果
 */
function registerContextMenu(options) {
	if (process.platform !== 'win32') {
		return {ok: false, message: '右键菜单仅支持Windows系统'};
	}
	const {exe, appRoot} = options;
	try {
		for (const ext of EXTENSIONS) {
			for (const verb of verbsFor(ext)) {
				const key = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\${TOOL_KEY}.${verb.verb}`;
				setValue(key, 'MUIVerb', verb.label);
				setValue(key, 'Icon', `${exe},0`);
				setDefault(`${key}\\command`, buildCommand(exe, appRoot, verb.flag));
			}
		}

		// 额外注册ProgID并挂到OpenWithProgids，让"打开方式"里也能选到本工具
		const progIds = [
			{ext: '.mmd', progId: `${TOOL_KEY}.mmd`, label: 'Mermaid图表文件'},
			{ext: '.drawio', progId: `${TOOL_KEY}.drawio`, label: 'Drawio图表文件'}
		];
		for (const item of progIds) {
			const progKey = `HKCU\\Software\\Classes\\${item.progId}`;
			setDefault(progKey, item.label);
			setDefault(`${progKey}\\DefaultIcon`, `${exe},0`);
			setDefault(`${progKey}\\shell\\open\\command`, buildCommand(exe, appRoot, '--preview'));
			const openWithKey = `HKCU\\Software\\Classes\\${item.ext}\\OpenWithProgids`;
			setValue(openWithKey, item.progId, '');
		}
		return {ok: true, message: `已注册${EXTENSIONS.join('、')}的右键菜单`};
	} catch (error) {
		// 注册中途失败时尝试回滚，避免留下半套菜单
		try {
			unregisterContextMenu();
		} catch (rollbackError) {
			console.warn(`回滚右键菜单失败: ${rollbackError.message}`);
		}
		return {ok: false, message: error.message};
	}
}

/**
 * 删除右键菜单与ProgID注册。
 * @returns {{ok: boolean, message: string}} 卸载结果
 */
function unregisterContextMenu() {
	if (process.platform !== 'win32') {
		return {ok: false, message: '右键菜单仅支持Windows系统'};
	}
	const errors = [];
	for (const ext of EXTENSIONS) {
		const key = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\${TOOL_KEY}`;
		const verbs = ['Preview', 'ToDrawio', 'ToPng'].map((verb) => `${key}.${verb}`);
		for (const fullKey of [...verbs, key]) {
			try {
				runReg(['delete', fullKey, '/f']);
			} catch (error) {
				// 键不存在属正常情况（只装过部分菜单），忽略即可
			}
		}
	}
	for (const progId of [`${TOOL_KEY}.mmd`, `${TOOL_KEY}.drawio`]) {
		try {
			runReg(['delete', `HKCU\\Software\\Classes\\${progId}`, '/f']);
		} catch (error) {
			// 同上，未注册时删除失败无需上报
		}
	}
	try {
		runReg(['delete', `HKCU\\Software\\Classes\\.mmd\\OpenWithProgids`, '/v', `${TOOL_KEY}.mmd`, '/f']);
	} catch (error) {
		errors.push(error.message);
	}
	try {
		runReg(['delete', `HKCU\\Software\\Classes\\.drawio\\OpenWithProgids`, '/v', `${TOOL_KEY}.drawio`, '/f']);
	} catch (error) {
		errors.push(error.message);
	}
	return {
		ok: true,
		message: errors.length === 0 ? '已移除右键菜单' : `已移除右键菜单，部分"打开方式"注册项不存在`
	};
}

/**
 * 查询菜单是否已注册，用于界面显示状态。
 * @returns {boolean} 已注册返回true
 */
function isContextMenuRegistered() {
	if (process.platform !== 'win32') {
		return false;
	}
	try {
		runReg(['query', `HKCU\\Software\\Classes\\SystemFileAssociations\\.mmd\\shell\\${TOOL_KEY}.Preview`]);
		return true;
	} catch (error) {
		return false;
	}
}

module.exports = {registerContextMenu, unregisterContextMenu, isContextMenuRegistered, EXTENSIONS};

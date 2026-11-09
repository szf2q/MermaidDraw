// 主窗口预加载脚本：向渲染进程暴露受控的文件、转换、导出与菜单接口。

'use strict';

const {contextBridge, ipcRenderer, webUtils} = require('electron');

contextBridge.exposeInMainWorld('api', {
	/**
	 * 弹出打开文件对话框。
	 * @returns {Promise<{ok: boolean, filePath?: string, canceled?: boolean}>} 选择结果
	 */
	openDialog() {
		return ipcRenderer.invoke('dialog:open');
	},
	/**
	 * 读取文本文件。
	 * @param {string} filePath 绝对路径
	 * @returns {Promise<{ok: boolean, content?: string, filePath?: string, error?: string}>} 内容
	 */
	readTextFile(filePath) {
		return ipcRenderer.invoke('file:read', filePath);
	},
	/**
	 * 保存文本到指定路径。
	 * @param {string} filePath 目标路径
	 * @param {string} text 文本内容
	 * @returns {Promise<{ok: boolean, filePath?: string, error?: string}>} 结果
	 */
	saveTextFile(filePath, text) {
		return ipcRenderer.invoke('file:save', {path: filePath, text});
	},
	/**
	 * 另存为新的mermaid文件。
	 * @param {string} name 默认文件名
	 * @param {string} text 文本内容
	 * @returns {Promise<{ok: boolean, filePath?: string, canceled?: boolean, error?: string}>} 结果
	 */
	saveTextFileAs(name, text) {
		return ipcRenderer.invoke('file:saveAs', {name, text});
	},
	/**
	 * 解析drawio文件为按页的mxGraphModel列表。
	 * @param {string} filePath 文件路径
	 * @returns {Promise<{ok: boolean, pages?: Array<object>, error?: string}>} 解析结果
	 */
	parseDrawio(filePath) {
		return ipcRenderer.invoke('drawio:parse', filePath);
	},
	/**
	 * 把mermaid文本转换为drawio文件。
	 * @param {{text: string, name: string, sourcePath?: string|null}} payload 参数
	 * @returns {Promise<{ok: boolean, outPath?: string, mode?: string, warning?: string, error?: string}>} 结果
	 */
	convertToDrawio(payload) {
		return ipcRenderer.invoke('convert:drawio', payload);
	},
	/**
	 * 导出PNG。
	 * @param {object} payload 导出参数，见主进程handleExportPng
	 * @returns {Promise<{ok: boolean, outPath?: string, width?: number, height?: number, error?: string}>} 结果
	 */
	exportPng(payload) {
		return ipcRenderer.invoke('export:png', payload);
	},
	/**
	 * 安装资源管理器右键菜单。
	 * @returns {Promise<{ok: boolean, message: string}>} 结果
	 */
	installMenu() {
		return ipcRenderer.invoke('menu:install');
	},
	/**
	 * 移除资源管理器右键菜单。
	 * @returns {Promise<{ok: boolean, message: string}>} 结果
	 */
	uninstallMenu() {
		return ipcRenderer.invoke('menu:uninstall');
	},
	/**
	 * 查询右键菜单是否已注册。
	 * @returns {Promise<{registered: boolean}>} 状态
	 */
	menuStatus() {
		return ipcRenderer.invoke('menu:status');
	},
	/**
	 * 在资源管理器中定位文件。
	 * @param {string} filePath 文件路径
	 * @returns {Promise<{ok: boolean}>} 结果
	 */
	reveal(filePath) {
		return ipcRenderer.invoke('shell:reveal', filePath);
	},
	/**
	 * 获取历史打开记录。
	 * @returns {Promise<{ok: boolean, items: string[]}>} 文件绝对路径列表，最新在前
	 */
	historyList() {
		return ipcRenderer.invoke('history:list');
	},
	/**
	 * 清空历史打开记录。
	 * @returns {Promise<{ok: boolean}>} 结果
	 */
	historyClear() {
		return ipcRenderer.invoke('history:clear');
	},
	/**
	 * 获取应用信息。
	 * @returns {Promise<{version: string, packaged: boolean, platform: string}>} 信息
	 */
	appInfo() {
		return ipcRenderer.invoke('app:info');
	},
	/**
	 * 把拖入的File对象还原为本地绝对路径。
	 * Electron 32起File.path被移除，必须经由webUtils取路径。
	 * @param {File} file 拖拽得到的文件对象
	 * @returns {string} 本地绝对路径，无法取得时返回空字符串
	 */
	getPathForFile(file) {
		try {
			return webUtils.getPathForFile(file) || '';
		} catch (error) {
			// 非本地文件或跨进程文件对象取不到路径，返回空串交由上层提示不支持
			return '';
		}
	},
	/**
	 * 监听主进程转发来的待打开文件（右键菜单、命令行、第二实例）。
	 * @param {(filePath: string) => void} callback 回调
	 */
	onOpenFile(callback) {
		ipcRenderer.on('file:open', (event, filePath) => callback(filePath));
	}
});

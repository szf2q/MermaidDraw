// 可视化编辑器预加载脚本：在隔离上下文中暴露受限的IPC接口，页面本身不直接接触Node。
// 仅提供初始化数据接收、保存、导出PNG与在文件夹中显示文件四类能力。

'use strict';

const {contextBridge, ipcRenderer} = require('electron');

/**
 * 初始化事件的监听器集合，用于在页面内注册回调。
 * 当前编辑器只注册一个监听器，仍保留可移除句柄，避免页面重载时重复绑定。
 * @type {Set<Function>}
 */
const initListeners = new Set();

ipcRenderer.on('editor:init', (event, payload) => {
	initListeners.forEach((listener) => {
		try {
			listener(payload);
		} catch (error) {
			// 单个监听器异常不应阻断其他监听器，也不应导致主进程崩溃
			console.error('处理编辑器初始化数据失败:', error);
		}
	});
});

contextBridge.exposeInMainWorld('editorBridge', {
	/**
	 * 通知主进程编辑器页面已加载完成，可以下发初始化数据。
	 * @returns {void}
	 */
	ready: () => {
		ipcRenderer.send('editor:ready');
	},

	/**
	 * 注册初始化数据回调；主进程每次打开文件时都会通过该事件下发页面数据。
	 * @param {(payload: object) => void} callback 初始化回调
	 * @returns {() => void} 取消监听函数
	 */
	onInit: (callback) => {
		if (typeof callback !== 'function') {
			return () => {};
		}
		initListeners.add(callback);
		return () => initListeners.delete(callback);
	},

	/**
	 * 保存编辑结果，主进程根据是否有现成路径决定覆盖还是弹出另存为对话框。
	 * @param {object} payload 页面数据与保存选项
	 * @returns {Promise<{ok: boolean, filePath?: string, canceled?: boolean, error?: string}>} 保存结果
	 */
	save: (payload) => ipcRenderer.invoke('editor:save', payload),

	/**
	 * 复用主进程现有的PNG导出能力，把当前页的mxGraphModel渲染为PNG。
	 * @param {object} payload 导出参数
	 * @returns {Promise<{ok: boolean, outPath?: string, width?: number, height?: number, error?: string}>} 导出结果
	 */
	exportPng: (payload) => ipcRenderer.invoke('export:png', payload),

	/**
	 * 在系统文件管理器中定位文件。
	 * @param {string} filePath 文件绝对路径
	 * @returns {Promise<{ok: boolean}>} 调用结果
	 */
	reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath)
});

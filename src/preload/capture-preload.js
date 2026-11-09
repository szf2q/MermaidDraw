// PNG导出页的预加载脚本：接收渲染任务并回传内容尺寸。

'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('captureBridge', {
	/**
	 * 通知主进程页面已加载完成。
	 */
	ready() {
		ipcRenderer.send('capture:ready');
	},
	/**
	 * 注册渲染任务回调。
	 * @param {(payload: {content: string, theme: string, scale: number, transparent: boolean, capture: boolean}) => void} callback 任务处理函数
	 */
	onRender(callback) {
		ipcRenderer.on('capture:render', (event, payload) => callback(payload));
	},
	/**
	 * 回传渲染完成后的像素尺寸。
	 * @param {{width: number, height: number}} payload 尺寸，已包含倍率
	 */
	rendered(payload) {
		ipcRenderer.send('capture:rendered', payload);
	},
	/**
	 * 回传渲染错误。
	 * @param {string} message 错误信息
	 */
	failed(message) {
		ipcRenderer.send('capture:failed', message);
	}
});

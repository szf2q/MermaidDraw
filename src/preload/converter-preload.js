// 转换工作页的预加载脚本：只暴露转换所需的最小通道。

'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('converterBridge', {
	/**
	 * 通知主进程工作页脚本已就绪，可以开始下发转换任务。
	 */
	ready() {
		ipcRenderer.send('converter:ready');
	},
	/**
	 * 注册转换任务回调。
	 * @param {(payload: {id: number, text: string, name: string, config: object}) => void} callback 任务处理函数
	 */
	onConvert(callback) {
		ipcRenderer.on('converter:convert', (event, payload) => callback(payload));
	},
	/**
	 * 回传转换结果。
	 * @param {{id: number, ok: boolean, xml?: string, mode?: string, error?: string}} payload 结果
	 */
	sendResult(payload) {
		ipcRenderer.send('converter:result', payload);
	},
	/**
	 * 回传探针信息，供开发期确认drawio bundle的接口形态。
	 * @param {object} payload 探针数据
	 */
	sendProbe(payload) {
		ipcRenderer.send('converter:probe', payload);
	}
});

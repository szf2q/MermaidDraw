// drawio在线可视化编辑页：内嵌draw.io官方embed编辑器，并在主界面与编辑器之间转发图形数据。
// 消息链路：主界面 -> 本页 -> embed.diagrams.net；保存时按相反方向回传XML。
// 使用JSON协议（proto=json），编辑器在init事件后等待load动作。

'use strict';

(function () {
	/** draw.io embed编辑器地址：JSON协议、显示图形库、保留保存按钮并隐藏退出按钮 */
	const EMBED_URL =
		'https://embed.diagrams.net/?embed=1&proto=json&spin=1&libraries=1&lang=zh' +
		'&noSaveBtn=0&saveAndExit=0&noExitBtn=1&suppressNewWindows=1';

	/** 等待编辑器init事件的超时时间，超时后提示检查网络 */
	const INIT_TIMEOUT = 20000;

	/** 内嵌编辑器iframe */
	const frame = document.getElementById('frame');

	/** 加载状态提示层 */
	const statusEl = document.getElementById('status');

	/** 编辑器是否已完成初始化（收到init事件） */
	let embedReady = false;

	/** 主界面下发、尚未发送给编辑器的加载参数 */
	let pendingLoad = null;

	/** init超时定时器 */
	let initTimer = null;

	/**
	 * 向主界面发送消息。
	 * @param {string} type 消息类型
	 * @param {object} [payload] 消息内容
	 * @returns {void}
	 */
	function postToParent(type, payload) {
		if (window.parent !== window) {
			window.parent.postMessage({type, payload: payload || {}}, '*');
		}
	}

	/**
	 * 向draw.io embed编辑器发送动作。
	 * @param {object} message 动作对象，会被序列化为JSON字符串
	 * @returns {void}
	 */
	function postToEmbed(message) {
		if (frame.contentWindow) {
			frame.contentWindow.postMessage(JSON.stringify(message), '*');
		}
	}

	/**
	 * 把主界面下发的图形数据交给编辑器。
	 * 编辑器未初始化时保持等待，收到init后再发送，避免消息丢失。
	 * @returns {void}
	 */
	function flushLoad() {
		if (!embedReady || !pendingLoad) {
			return;
		}
		const payload = pendingLoad;
		pendingLoad = null;
		postToEmbed({
			action: 'load',
			xml: payload.xml,
			title: payload.title || '',
			autosave: 1,
			noSaveBtn: 0,
			saveAndExit: 0,
			noExitBtn: 1
		});
	}

	/**
	 * 隐藏加载提示。
	 * @returns {void}
	 */
	function hideStatus() {
		if (statusEl) {
			statusEl.hidden = true;
		}
	}

	/**
	 * 处理draw.io编辑器发来的消息。
	 * 只接受来自内嵌编辑器窗口的消息，防止页面内其他帧伪造。
	 * @param {MessageEvent} event 消息事件
	 * @returns {void}
	 */
	function onEmbedMessage(event) {
		if (!frame.contentWindow || event.source !== frame.contentWindow) {
			return;
		}
		let data;
		try {
			data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
		} catch (error) {
			// 编辑器可能发送非JSON的握手消息，无法解析时直接忽略
			return;
		}
		if (!data || !data.event) {
			return;
		}
		if (data.event === 'init') {
			embedReady = true;
			clearTimeout(initTimer);
			hideStatus();
			flushLoad();
			postToParent('drawio-ready');
			return;
		}
		if (data.event === 'autosave') {
			postToParent('drawio-autosave', {xml: data.xml || ''});
			return;
		}
		if (data.event === 'save') {
			postToParent('drawio-save', {xml: data.xml || '', exit: data.exit === true});
			return;
		}
		if (data.event === 'exit') {
			postToParent('drawio-exit', {modified: data.modified === true});
			return;
		}
		// 未知消息带error时上报，便于界面提示
		if (data.error) {
			postToParent('drawio-error', {message: String(data.error)});
		}
	}

	/**
	 * 处理主界面下发的消息。
	 * @param {MessageEvent} event 消息事件
	 * @returns {void}
	 */
	function onParentMessage(event) {
		if (window.parent === window || event.source !== window.parent) {
			return;
		}
		const data = event.data || {};
		if (data.type === 'drawio-load') {
			pendingLoad = data.payload || null;
			flushLoad();
			return;
		}
		if (data.type === 'drawio-save-result') {
			const result = data.payload || {};
			postToEmbed({
				action: 'status',
				message: result.ok ? '已保存到本地文件' : `保存失败：${result.message || ''}`
			});
		}
	}

	window.addEventListener('message', onEmbedMessage);
	window.addEventListener('message', onParentMessage);

	// 页面脚本就绪后通知主界面，主界面再下发待加载的图形数据
	postToParent('ready');
	frame.src = EMBED_URL;

	initTimer = setTimeout(() => {
		if (embedReady) {
			return;
		}
		if (statusEl) {
			statusEl.hidden = false;
			statusEl.textContent = '在线编辑器加载超时，请检查网络，或点击“在浏览器中打开”后编辑';
		}
		postToParent('drawio-error', {message: '在线编辑器加载超时'});
	}, INIT_TIMEOUT);
})();

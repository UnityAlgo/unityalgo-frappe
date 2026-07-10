frappe.csrf_token = $("body").attr("data-csrf_token");

(function () {
    'use strict';

    const API = {
        getConversations: 'unityalgo.www.chat.get_conversations',
        getMessages: 'unityalgo.www.chat.get_messages',
        createConversation: 'unityalgo.www.chat.create_conversation',
        sendMessage: 'unityalgo.www.chat.send_message',
        deleteConversation: 'unityalgo.www.chat.delete_conversation',
        renameConversation: 'unityalgo.www.chat.rename_conversation'
    };

    const REALTIME_EVENTS = {
        chunk: 'algo_chat:stream_chunk',
        done: 'algo_chat:stream_done',
        error: 'algo_chat:stream_error'
    };

	const state = {
		conversations: [],
		activeConversationId: null,
		messagesByConversation: new Map(),
		isSending: false,
		streamingMessageId: null,
		contextMenuConversationId: null
	};

	const dom = {};

	function cacheDom() {
		dom.root = document.getElementById('algo-chat-root');
		dom.convList = document.getElementById('conversation-list');
		dom.convListEmpty = document.getElementById('conv-list-empty');
		dom.convListLoading = document.getElementById('conv-list-loading');
		dom.newChatBtn = document.getElementById('new-chat-btn');
		dom.messages = document.getElementById('messages');
		dom.emptyState = document.getElementById('empty-state');
		dom.chatInput = document.getElementById('chat-input');
		dom.sendBtn = document.getElementById('send-btn');
		dom.conversationTitle = document.getElementById('conversation-title');
		dom.statusDot = document.getElementById('status-dot');
		dom.statusLabel = document.getElementById('status-label');
		dom.contextMenu = document.getElementById('conversation-context-menu');
		dom.menuRenameBtn = document.getElementById('menu-rename-btn');
		dom.menuDeleteBtn = document.getElementById('menu-delete-btn');
		dom.renameModal = document.getElementById('rename-modal');
		dom.renameInput = document.getElementById('rename-input');
		dom.renameCancelBtn = document.getElementById('rename-cancel-btn');
		dom.renameConfirmBtn = document.getElementById('rename-confirm-btn');
		dom.deleteModal = document.getElementById('delete-modal');
		dom.deleteCancelBtn = document.getElementById('delete-cancel-btn');
		dom.deleteConfirmBtn = document.getElementById('delete-confirm-btn');
		dom.sidebar = document.getElementById('sidebar');
		dom.sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
	}

	function escapeHtml(str) {
		const div = document.createElement('div');
		div.textContent = str || '';
		return div.innerHTML;
	}

	function extractBlocks(content) {
		// content may be an already-parsed blocks array, a serialized
		// {version, blocks:[...]} JSON string, or a plain text string.
		if (Array.isArray(content)) return content;
		if (typeof content !== 'string') return [{ type: 'text', data: { markdown: '' } }];

		const trimmed = content.trim();
		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed.blocks)) return parsed.blocks;
			} catch (error) {
				// fall through to plain text
			}
		}
		return [{ type: 'text', data: { markdown: content } }];
	}

	// Remove/collapse algo:table & algo:chart fences from streaming text so the
	// user never sees raw JSON mid-stream — just a small placeholder.
	function stripRichFences(text) {
		let out = text.replace(/```algo:(table|chart)[\s\S]*?```/g, (m, kind) => `\n[${kind} ready]\n`);
		out = out.replace(/```algo:(table|chart)[\s\S]*$/, (m, kind) => `\n[Preparing ${kind}…]\n`);
		return out;
	}

	function destroyCharts(container) {
		container.querySelectorAll('canvas').forEach(canvas => {
			if (canvas._algoChart) {
				canvas._algoChart.destroy();
				canvas._algoChart = null;
			}
		});
	}

	function renderTable(data) {
		const wrapper = document.createElement('div');
		wrapper.className = 'algo-table-wrapper overflow-x-auto my-2';

		if (data && data.title) {
			const caption = document.createElement('div');
			caption.className = 'text-xs font-semibold mb-1 text-[var(--color-text-secondary)]';
			caption.textContent = data.title;
			wrapper.appendChild(caption);
		}

		const table = document.createElement('table');
		table.className = 'algo-table text-sm';
		const columns = (data && data.columns) || [];
		const rows = (data && data.rows) || [];

		if (columns.length) {
			const thead = document.createElement('thead');
			const tr = document.createElement('tr');
			columns.forEach(col => {
				const th = document.createElement('th');
				th.textContent = col;
				tr.appendChild(th);
			});
			thead.appendChild(tr);
			table.appendChild(thead);
		}

		const tbody = document.createElement('tbody');
		rows.forEach(row => {
			const tr = document.createElement('tr');
			(row || []).forEach(cell => {
				const td = document.createElement('td');
				td.textContent = cell === null || cell === undefined ? '' : String(cell);
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrapper.appendChild(table);
		return wrapper;
	}

	const CHART_COLORS = ['#6366F1', '#22C55E', '#F59E0B', '#EF4444', '#06B6D4', '#A855F7', '#EC4899'];

	function renderChart(data) {
		const wrapper = document.createElement('div');
		wrapper.className = 'algo-chart my-2';

		if (data && data.title) {
			const caption = document.createElement('div');
			caption.className = 'text-xs font-semibold mb-1 text-[var(--color-text-secondary)]';
			caption.textContent = data.title;
			wrapper.appendChild(caption);
		}

		const canvas = document.createElement('canvas');
		wrapper.appendChild(canvas);

		const type = (data && data.chartType) || 'bar';
		const labels = (data && data.labels) || [];
		const datasets = ((data && data.datasets) || []).map((ds, i) => ({
			label: ds.label || `Series ${i + 1}`,
			data: ds.data || [],
			backgroundColor: type === 'pie'
				? (ds.data || []).map((_, j) => CHART_COLORS[j % CHART_COLORS.length])
				: CHART_COLORS[i % CHART_COLORS.length],
			borderColor: CHART_COLORS[i % CHART_COLORS.length],
			borderWidth: type === 'line' ? 2 : 1,
			fill: false,
		}));

		// Instantiate once the canvas is attached so it sizes correctly.
		requestAnimationFrame(() => {
			if (typeof Chart === 'undefined' || !canvas.isConnected) return;
			canvas._algoChart = new Chart(canvas.getContext('2d'), {
				type,
				data: { labels, datasets },
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: { legend: { display: datasets.length > 1 || type === 'pie' } },
				},
			});
		});
		return wrapper;
	}

	function renderSources(data) {
		const items = (data && data.items) || [];
		const wrapper = document.createElement('div');
		wrapper.className = 'algo-sources';
		const label = document.createElement('div');
		label.className = 'algo-sources-label';
		label.textContent = 'Sources';
		wrapper.appendChild(label);
		const list = document.createElement('div');
		list.className = 'algo-sources-list';
		items.forEach(item => {
			const chip = item.url ? document.createElement('a') : document.createElement('span');
			chip.className = 'algo-source-chip';
			if (item.url) {
				chip.href = item.url;
				chip.target = '_blank';
				chip.rel = 'noopener';
			}
			const title = item.title || item.docname || item.doctype || '';
			chip.textContent = `[${item.n}] ${title}`;
			chip.title = `${item.doctype || ''} ${item.docname || ''}`.trim();
			list.appendChild(chip);
		});
		wrapper.appendChild(list);
		return wrapper;
	}

	function renderBlocks(container, blocks) {
		destroyCharts(container);
		container.innerHTML = '';
		(blocks || []).forEach(block => {
			if (block.type === 'table') {
				container.appendChild(renderTable(block.data || {}));
			} else if (block.type === 'chart') {
				container.appendChild(renderChart(block.data || {}));
			} else if (block.type === 'sources') {
				container.appendChild(renderSources(block.data || {}));
			} else {
				const div = document.createElement('div');
				div.innerHTML = renderMarkdownLite((block.data && block.data.markdown) || '');
				container.appendChild(div);
			}
		});
	}

	function renderMarkdownLite(text) {
		const escaped = escapeHtml(text);
		const withCode = escaped.replace(/```([\s\S]*?)```/g, (match, code) => {
			return `<pre><code>${code.trim()}</code></pre>`;
		});
		const withInlineCode = withCode.replace(/`([^`]+)`/g, '<code>$1</code>');
		const withBold = withInlineCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		const paragraphs = withBold.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`);
		return paragraphs.join('');
	}

	function setStatus(online, label) {
		dom.statusDot.style.backgroundColor = online ? 'var(--color-success)' : '#EF4444';
		dom.statusLabel.textContent = label;
	}

	function setSending(isSending) {
		state.isSending = isSending;
		dom.chatInput.disabled = isSending;
		updateSendButtonState();
	}

	function updateSendButtonState() {
		const hasText = dom.chatInput.value.trim().length > 0;
		dom.sendBtn.disabled = !hasText || state.isSending;
	}

	function toggleEmptyState() {
		const hasMessages = dom.messages.querySelectorAll('[data-message-id]').length > 0;
		dom.emptyState.hidden = hasMessages;
	}

	function scrollMessagesToBottom() {
		dom.messages.scrollTop = dom.messages.scrollHeight;
	}

	function buildMessageNode(message) {
		const isUser = message.role === 'user';
		const wrapper = document.createElement('div');
		wrapper.className = `flex msg-enter ${isUser ? 'justify-end' : 'justify-start'}`;
		wrapper.dataset.messageId = message.id;

		const bubble = document.createElement('div');
		bubble.className = isUser
			? 'max-w-xl bg-[var(--color-surface-secondary)] px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed'
			: 'px-4 py-2.5 rounded-md text-sm leading-relaxed prose-msg hover:bg-zinc-100';

		const content = document.createElement('div');
		content.className = 'message-content';
		if (isUser) {
			const blocks = extractBlocks(message.content);
			const text = blocks.filter(b => b.type === 'text').map(b => b.data && b.data.markdown ? b.data.markdown : '').join('\n\n');
			content.innerHTML = escapeHtml(text);
		} else if (message.streaming) {
			content.innerHTML = '';
		} else {
			renderBlocks(content, extractBlocks(message.content));
		}
		bubble.appendChild(content);

		if (!isUser && message.streaming) {
			const caret = document.createElement('span');
			caret.className = 'stream-caret';
			caret.dataset.role = 'caret';
			content.appendChild(caret);
		}

		wrapper.appendChild(bubble);
		return wrapper;
	}

	function appendMessage(message) {
		const node = buildMessageNode(message);
		dom.messages.appendChild(node);
		toggleEmptyState();
		scrollMessagesToBottom();
		return node;
	}

	function updateStreamingMessage(messageId, fullText) {
		const node = dom.messages.querySelector(`[data-message-id="${messageId}"]`);
		if (!node) return;
		const content = node.querySelector('.message-content');
		destroyCharts(content);
		content.innerHTML = renderMarkdownLite(stripRichFences(fullText));
		const caret = document.createElement('span');
		caret.className = 'stream-caret';
		content.appendChild(caret);
		scrollMessagesToBottom();
	}

	// Error paths pass a plain string; the done path passes parsed blocks.
	function finalizeStreamingMessage(messageId, fullText) {
		finalizeStreamingBlocks(messageId, [{ type: 'text', data: { markdown: fullText } }]);
	}

	function finalizeStreamingBlocks(messageId, blocks) {
		const node = dom.messages.querySelector(`[data-message-id="${messageId}"]`);
		if (!node) return;
		const content = node.querySelector('.message-content');
		renderBlocks(content, blocks);
		scrollMessagesToBottom();
	}

	function clearMessages() {
		dom.messages.querySelectorAll('[data-message-id]').forEach(node => node.remove());
		toggleEmptyState();
	}

	function renderMessageList(messages) {
		clearMessages();
		messages.forEach(message => appendMessage(message));
	}

	function getConversationMessages(conversationId) {
		if (!state.messagesByConversation.has(conversationId)) {
			state.messagesByConversation.set(conversationId, []);
		}
		return state.messagesByConversation.get(conversationId);
	}

	function buildConversationNode(conversation) {
		const node = document.createElement('div');
		node.className = 'conv-item w-full text-left px-2 py-1.5 rounded-lg mb-1 border border-transparent hover:bg-[var(--color-surface-secondary)] transition-colors duration-150 group flex items-center gap-2 cursor-pointer relative overflow-hidden';
		node.dataset.conversationId = conversation.id;
		node.dataset.active = String(conversation.id === state.activeConversationId);

		const icon = document.createElement('div');
		icon.className = 'shrink-0 text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)] transition-colors';
		icon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;

		const title = document.createElement('span');
		title.className = 'conv-title text-xs text-[var(--color-text-secondary)] truncate flex-1 sidebar-text transition-opacity duration-200';
		title.textContent = conversation.title || 'Untitled';

		const actions = document.createElement('div');
		actions.className = 'conv-actions flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
		
		const menuBtn = document.createElement('button');
		menuBtn.className = 'p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] rounded hover:bg-[var(--color-border)]';
		menuBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>`;
		
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			showContextMenu(e, conversation.id, conversation.title);
		});

		actions.appendChild(menuBtn);

		node.appendChild(icon);
		node.appendChild(title);
		node.appendChild(actions);

		node.addEventListener('click', () => selectConversation(conversation.id));
		return node;
	}

	function renderConversationList() {
		dom.convList.querySelectorAll('[data-conversation-id]').forEach(node => node.remove());
		dom.convListEmpty.hidden = state.conversations.length > 0;

		state.conversations.forEach(conversation => {
			dom.convList.appendChild(buildConversationNode(conversation));
		});
	}

	function markActiveConversationInList() {
		dom.convList.querySelectorAll('[data-conversation-id]').forEach(node => {
			node.dataset.active = String(node.dataset.conversationId === String(state.activeConversationId));
		});
	}

	async function loadConversations() {
		dom.convListLoading.hidden = false;
		try {
			const response = await frappe.call({ method: API.getConversations });
			state.conversations = (response.message || []).map(c => ({
				id: c.name,
				title: c.title
			}));
			renderConversationList();
		} catch (error) {
			console.error(error);
		} finally {
			dom.convListLoading.hidden = true;
		}
	}

	async function loadMessages(conversationId) {
		if (state.messagesByConversation.has(conversationId)) {
			renderMessageList(getConversationMessages(conversationId));
			return;
		}

		try {
			const response = await frappe.call({
				method: API.getMessages,
				args: { conversation: conversationId }
			});
			const messages = (response.message || []).map(m => ({
				id: m.name,
				role: m.role,
				content: m.content
			}));
			state.messagesByConversation.set(conversationId, messages);
			renderMessageList(messages);
		} catch (error) {
			console.error(error);
		}
	}

	async function selectConversation(conversationId) {
		if (state.activeConversationId === conversationId) return;
		state.activeConversationId = conversationId;
		markActiveConversationInList();

		const conversation = state.conversations.find(c => c.id === conversationId);
		dom.conversationTitle.textContent = conversation ? conversation.title : 'New Chat';

		await loadMessages(conversationId);
	}

	function startNewConversation() {
		state.activeConversationId = null;
		dom.conversationTitle.textContent = 'New Chat';
		clearMessages();
		markActiveConversationInList();
		dom.chatInput.focus();
	}

	async function ensureActiveConversation(firstMessageText) {
		if (state.activeConversationId) return state.activeConversationId;

		const response = await frappe.call({
			method: API.createConversation,
			args: { title: firstMessageText.slice(0, 60) }
		});

		const conversation = { id: response.message.name, title: response.message.title };
		state.conversations.unshift(conversation);
		state.messagesByConversation.set(conversation.id, []);
		state.activeConversationId = conversation.id;

		renderConversationList();
		markActiveConversationInList();
		dom.conversationTitle.textContent = conversation.title;

		return conversation.id;
	}

	function attachStreamingListeners(conversationId, assistantMessageId) {
		let fullText = '';

		const onChunk = (data) => {
			if (data.message_id !== assistantMessageId) return;
			fullText += data.chunk;
			updateStreamingMessage(assistantMessageId, fullText);
		};

		const onDone = (data) => {
			if (data.message_id !== assistantMessageId) return;
			const blocks = Array.isArray(data.blocks)
				? data.blocks
				: [{ type: 'text', data: { markdown: data.content || fullText } }];
			finalizeStreamingBlocks(assistantMessageId, blocks);
			getConversationMessages(conversationId).push({
				id: assistantMessageId,
				role: 'assistant',
				content: blocks
			});
			state.streamingMessageId = null;
			setSending(false);
			detach();
		};

		const onError = (data) => {
			if (data.message_id !== assistantMessageId) return;
			finalizeStreamingMessage(assistantMessageId, data.message || 'Something went wrong generating a response.');
			state.streamingMessageId = null;
			setSending(false);
			detach();
		};

		function detach() {
			frappe.realtime.off(REALTIME_EVENTS.chunk, onChunk);
			frappe.realtime.off(REALTIME_EVENTS.done, onDone);
			frappe.realtime.off(REALTIME_EVENTS.error, onError);
		}

		frappe.realtime.on(REALTIME_EVENTS.chunk, onChunk);
		frappe.realtime.on(REALTIME_EVENTS.done, onDone);
		frappe.realtime.on(REALTIME_EVENTS.error, onError);
	}

	async function sendMessage() {
		const text = dom.chatInput.value.trim();
		if (!text || state.isSending) return;

		setSending(true);
		dom.chatInput.value = '';
		updateSendButtonState();

		const conversationId = await ensureActiveConversation(text);

		const userMessage = { id: `local-${Date.now()}`, role: 'user', content: text };
		getConversationMessages(conversationId).push(userMessage);
		appendMessage(userMessage);

		const placeholderId = `streaming-${Date.now()}`;
		state.streamingMessageId = placeholderId;
		appendMessage({ id: placeholderId, role: 'assistant', content: '', streaming: true });

		attachStreamingListeners(conversationId, placeholderId);

		try {
			await frappe.call({
				method: API.sendMessage,
				args: {
					conversation: conversationId,
					content: text,
					message_id: placeholderId
				}
			});
		} catch (error) {
			console.error(error);
			finalizeStreamingMessage(placeholderId, 'Something went wrong sending that message.');
			setSending(false);
		}
	}

	function handleInputKeydown(event) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendMessage();
		}
	}

	function setupRealtimeConnectionStatus() {
		if (!frappe.realtime || !frappe.realtime.socket) {
			setStatus(true, 'connected');
			return;
		}
		frappe.realtime.socket.on('connect', () => setStatus(true, 'connected'));
		frappe.realtime.socket.on('disconnect', () => setStatus(false, 'disconnected'));
	}

	function hideContextMenu() {
		if (dom.contextMenu) dom.contextMenu.classList.add('hidden');
	}

	function showContextMenu(e, conversationId, currentTitle) {
		state.contextMenuConversationId = conversationId;
		dom.contextMenu.classList.remove('hidden');
		
		const rect = e.target.closest('button').getBoundingClientRect();
		dom.contextMenu.style.top = `${rect.bottom + window.scrollY}px`;
		dom.contextMenu.style.left = `${rect.right - dom.contextMenu.offsetWidth + window.scrollX}px`;

		dom.contextMenu.dataset.title = currentTitle || 'Untitled';
	}

	function handleRename() {
		hideContextMenu();
		if (!state.contextMenuConversationId) return;
		dom.renameInput.value = dom.contextMenu.dataset.title || '';
		dom.renameModal.classList.remove('hidden');
		dom.renameInput.focus();
	}

	async function confirmRename() {
		if (!state.contextMenuConversationId) return;
		const newTitle = dom.renameInput.value.trim();
		if (!newTitle) return;

		try {
			await frappe.call({
				method: API.renameConversation,
				args: {
					conversation: state.contextMenuConversationId,
					title: newTitle
				}
			});
			const conv = state.conversations.find(c => c.id === state.contextMenuConversationId);
			if (conv) conv.title = newTitle;
			if (state.activeConversationId === state.contextMenuConversationId) {
				dom.conversationTitle.textContent = newTitle;
			}
			renderConversationList();
			dom.renameModal.classList.add('hidden');
		} catch (err) {
			console.error(err);
		}
	}

	function handleDelete() {
		hideContextMenu();
		if (!state.contextMenuConversationId) return;
		dom.deleteModal.classList.remove('hidden');
	}

	async function confirmDelete() {
		if (!state.contextMenuConversationId) return;
		
		try {
			await frappe.call({
				method: API.deleteConversation,
				args: { conversation: state.contextMenuConversationId }
			});
			state.conversations = state.conversations.filter(c => c.id !== state.contextMenuConversationId);
			if (state.activeConversationId === state.contextMenuConversationId) {
				startNewConversation();
			}
			renderConversationList();
			dom.deleteModal.classList.add('hidden');
		} catch (err) {
			console.error(err);
		}
	}

	function bindEvents() {
		dom.newChatBtn.addEventListener('click', startNewConversation);
		dom.sendBtn.addEventListener('click', sendMessage);
		dom.chatInput.addEventListener('keydown', handleInputKeydown);
		dom.chatInput.addEventListener('input', updateSendButtonState);
		
		if (dom.menuRenameBtn) dom.menuRenameBtn.addEventListener('click', handleRename);
		if (dom.menuDeleteBtn) dom.menuDeleteBtn.addEventListener('click', handleDelete);

		if (dom.renameCancelBtn) dom.renameCancelBtn.addEventListener('click', () => dom.renameModal.classList.add('hidden'));
		if (dom.renameConfirmBtn) dom.renameConfirmBtn.addEventListener('click', confirmRename);
		if (dom.renameInput) {
			dom.renameInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') confirmRename();
				if (e.key === 'Escape') dom.renameModal.classList.add('hidden');
			});
		}

		if (dom.deleteCancelBtn) dom.deleteCancelBtn.addEventListener('click', () => dom.deleteModal.classList.add('hidden'));
		if (dom.deleteConfirmBtn) dom.deleteConfirmBtn.addEventListener('click', confirmDelete);

		if (dom.sidebarToggleBtn) {
			dom.sidebarToggleBtn.addEventListener('click', () => {
				dom.sidebar.classList.toggle('collapsed');
			});
		}

		document.addEventListener('keydown', (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
				e.preventDefault();
				if (dom.sidebarToggleBtn) dom.sidebarToggleBtn.click();
			}
			if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
				e.preventDefault();
				if (dom.newChatBtn) dom.newChatBtn.click();
			}
		});

		document.addEventListener('click', (e) => {
			if (dom.contextMenu && !dom.contextMenu.contains(e.target) && !e.target.closest('.conv-item button')) {
				hideContextMenu();
			}
			if (e.target === dom.renameModal) {
				dom.renameModal.classList.add('hidden');
			}
			if (e.target === dom.deleteModal) {
				dom.deleteModal.classList.add('hidden');
			}
		});
	}

	function init() {
		cacheDom();
		bindEvents();
		setupRealtimeConnectionStatus();
		toggleEmptyState();
		loadConversations();
	}

	frappe.ready(init);
})();
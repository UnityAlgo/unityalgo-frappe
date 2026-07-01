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
		streamingMessageId: null
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
	}

	function escapeHtml(str) {
		const div = document.createElement('div');
		div.textContent = str || '';
		return div.innerHTML;
	}

	function extractTextFromContent(content) {
		if (typeof content !== 'string') return '';
		const trimmed = content.trim();
		if (!trimmed.startsWith('{')) return content;

		try {
			const parsed = JSON.parse(trimmed);
			const blocks = parsed.blocks || [];
			return blocks
				.filter(block => block.type === 'text')
				.map(block => block.data && block.data.markdown ? block.data.markdown : '')
				.join('\n\n');
		} catch (error) {
			return content;
		}
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
		dom.statusDot.style.backgroundColor = online ? 'var(--algo-online)' : '#EF4444';
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
			? 'max-w-xl bg-[var(--algo-accent)] text-white px-4 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed'
			: 'px-4 py-2.5 rounded-md text-sm leading-relaxed prose-msg hover:bg-zinc-100';

		const content = document.createElement('div');
		content.className = 'message-content';
		const displayText = isUser ? message.content : extractTextFromContent(message.content);
		content.innerHTML = isUser ? escapeHtml(displayText) : renderMarkdownLite(displayText);
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
		content.innerHTML = renderMarkdownLite(fullText);
		const caret = document.createElement('span');
		caret.className = 'stream-caret';
		content.appendChild(caret);
		scrollMessagesToBottom();
	}

	function finalizeStreamingMessage(messageId, fullText) {
		const node = dom.messages.querySelector(`[data-message-id="${messageId}"]`);
		if (!node) return;
		const content = node.querySelector('.message-content');
		content.innerHTML = renderMarkdownLite(fullText);
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
		const node = document.createElement('button');
		node.className = 'conv-item w-full text-left px-3 py-2.5 rounded-lg mb-1 border border-transparent hover:bg-[var(--algo-panel-raised)] transition-colors duration-150 group flex items-center justify-between gap-2';
		node.dataset.conversationId = conversation.id;
		node.dataset.active = String(conversation.id === state.activeConversationId);

		const title = document.createElement('span');
		title.className = 'conv-title text-sm text-[var(--algo-text-dim)] truncate';
		title.textContent = conversation.title || 'Untitled';

		node.appendChild(title);
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
			finalizeStreamingMessage(assistantMessageId, data.content || fullText);
			getConversationMessages(conversationId).push({
				id: assistantMessageId,
				role: 'assistant',
				content: data.content || fullText
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

	function bindEvents() {
		dom.newChatBtn.addEventListener('click', startNewConversation);
		dom.sendBtn.addEventListener('click', sendMessage);
		dom.chatInput.addEventListener('keydown', handleInputKeydown);
		dom.chatInput.addEventListener('input', updateSendButtonState);
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
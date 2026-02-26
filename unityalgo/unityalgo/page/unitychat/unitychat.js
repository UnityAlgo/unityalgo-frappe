
frappe.pages['unitychat'].on_page_load = function ($wrapper) {
	const page = frappe.ui.make_app_page({
		parent: $wrapper,
		title: 'UnityChat',
		single_column: true
	});

	frappe.require([
		'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
		'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js',
		'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/github-dark.min.css'
	], function () {
		new UnityChat($wrapper, page);
	});

};


class UnityChat {
	constructor(wrapper, page) {
		this.wrapper = $(wrapper);
		this.page = page

		// State
		this.currentChatId = null;
		this.isGenerating = false;

		// Initialize
		this.render_layout();
		this.bind_events();
		this.load_history();

		// Configure Marked (Markdown Parser)
		marked.setOptions({
			highlight: function (code, lang) {
				const language = hljs.getLanguage(lang) ? lang : 'plaintext';
				return hljs.highlight(code, { language }).value;
			},
			langPrefix: 'hljs language-',
			breaks: true
		});
	}

	render_layout() {
		const template = `
            <div class="unitychat-wrapper">
                <div class="chat-sidebar" id="chatSidebar">
                    <div class="sidebar-header">
                        <button class="new-chat-btn" id="newChatBtn">
                            <span class="icon">${frappe.utils.icon('add', 'sm')}</span>
                            New chat
                        </button>
                    </div>
                    <div class="search-container">
                        <input type="text" class="search-input" id="searchInput" placeholder="Search history..." />
                    </div>
                    <div class="chat-history" id="chatHistory">
                        </div>
                    <div class="sidebar-footer">
                        <div class="user-profile">
                            <div class="user-avatar">${frappe.get_abbr(frappe.session.user_fullname)}</div>
                            <div class="user-name">${frappe.session.user_fullname}</div>
                        </div>
                    </div>
                </div>
                
                <div class="unitychat-container">
                    <div class="chat-header-mobile">
                         <button class="menu-toggle">${frappe.utils.icon('menu', 'sm')}</button>
                         <span>UnityChat</span>
                    </div>

                    <div class="chat-messages" id="chatMessages">
                        ${this.get_empty_state()}
                    </div>
                    
                    <div class="typing-indicator" id="typingIndicator">
                        <div class="typing-content">
                            <div class="message-avatar ai">AI</div>
                            <div class="typing-dots">
                                <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
                            </div>
                        </div>
                    </div>

                    <div class="chat-input-container">
                        <div class="chat-input-wrapper">
                            <textarea id="chatInput" class="chat-input-box" placeholder="Message UnityChat..." rows="1"></textarea>
                            <button class="send-button" id="sendButton" disabled>
                                ${frappe.utils.icon('send', 'sm')}
                            </button>
                        </div>
                        <div class="footer-note">AI can make mistakes. Consider checking important information.</div>
                    </div>
                </div>
            </div>
        `;
		$(this.page.body).html(template);

		// Cache DOM elements
		this.$sidebar = this.wrapper.find('#chatSidebar');
		this.$history = this.wrapper.find('#chatHistory');
		this.$messages = this.wrapper.find('#chatMessages');
		this.$input = this.wrapper.find('#chatInput');
		this.$sendBtn = this.wrapper.find('#sendButton');
		this.$typing = this.wrapper.find('#typingIndicator');
	}

	get_empty_state() {
		return `
            <div class="empty-state">
                <div class="logo-wrapper">🧠</div>
                <h4>How can I help you today?</h4>
                <div class="suggestion-chips">
                    <div class="suggestion-chip" data-prompt="Explain quantum computing in simple terms">
                        <span class="chip-title">Explain quantum computing</span>
                        <span class="chip-sub">in simple terms</span>
                    </div>
                    <div class="suggestion-chip" data-prompt="Write a professional email for a project update">
                        <span class="chip-title">Write an email</span>
                        <span class="chip-sub">project update</span>
                    </div>
                    <div class="suggestion-chip" data-prompt="Debug this Python code: print('hello world'">
                        <span class="chip-title">Debug code</span>
                        <span class="chip-sub">Python snippet</span>
                    </div>
                </div>
            </div>
        `;
	}

	bind_events() {
		// Input auto-resize
		this.$input.on('input', (e) => {
			const el = e.target;
			el.style.height = 'auto';
			el.style.height = Math.min(el.scrollHeight, 200) + 'px';
			this.$sendBtn.prop('disabled', !el.value.trim());
		});

		// Enter to send
		this.$input.on('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.send_message();
			}
		});

		// Click actions
		this.$sendBtn.on('click', () => this.send_message());
		this.wrapper.find('#newChatBtn').on('click', () => this.start_new_chat());
		this.wrapper.find('#searchInput').on('input', (e) => this.load_history(e.target.value));

		// Suggestion Chips (Delegated)
		this.$messages.on('click', '.suggestion-chip', (e) => {
			const prompt = $(e.currentTarget).data('prompt');
			this.$input.val(prompt).trigger('input');
			this.send_message();
		});

		// Copy Code Button (Delegated)
		this.$messages.on('click', '.copy-code-btn', (e) => {
			const btn = $(e.currentTarget);
			const code = btn.siblings('code').text();
			frappe.utils.copy_to_clipboard(code);
			btn.html(frappe.utils.icon('check', 'xs'));
			setTimeout(() => btn.html(frappe.utils.icon('copy', 'xs')), 2000);
		});

		// Mobile Toggle
		this.wrapper.find('.menu-toggle').on('click', () => {
			this.$sidebar.toggleClass('mobile-open');
		});
	}

	load_history(searchTerm = null) {
		frappe.call({
			method: 'unityalgo.unityalgo.page.unitychat.api.get_chat_list',
			args: { search_term: searchTerm },
			callback: (r) => {
				if (r.message && r.message.success) {
					this.render_history_sidebar(r.message.chats);
				}
			}
		});
	}

	render_history_sidebar(chats) {
		this.$history.empty();
		const sections = [
			{ key: 'today', title: 'Today' },
			{ key: 'yesterday', title: 'Yesterday' },
			{ key: 'previous_7_days', title: 'Previous 7 Days' },
			{ key: 'older', title: 'Older' }
		];

		sections.forEach(section => {
			if (chats[section.key] && chats[section.key].length > 0) {
				const $section = $(`<div class="history-section"><div class="section-title">${section.title}</div></div>`);

				chats[section.key].forEach(chat => {
					const $item = $(`
                        <div class="history-item ${chat.name === this.currentChatId ? 'active' : ''}" data-id="${chat.name}">
                            <span class="history-text">${chat.title}</span>
                            <div class="history-actions">
                                <button class="action-btn edit-btn" title="Rename">${frappe.utils.icon('edit', 'xs')}</button>
                                <button class="action-btn delete-btn" title="Delete">${frappe.utils.icon('delete', 'xs')}</button>
                            </div>
                        </div>
                    `);

					// Load Chat
					$item.on('click', (e) => {
						if (!$(e.target).closest('.action-btn').length) this.load_chat_messages(chat.name);
					});

					// Delete
					$item.find('.delete-btn').on('click', (e) => {
						e.stopPropagation();
						this.delete_chat(chat.name);
					});

					// Rename (Simple prompt for now)
					$item.find('.edit-btn').on('click', (e) => {
						e.stopPropagation();
						frappe.prompt({ fieldname: 'new_title', label: 'New Title', fieldtype: 'Data', reqd: 1, default: chat.title }, (values) => {
							this.rename_chat(chat.name, values.new_title);
						});
					});

					$section.append($item);
				});
				this.$history.append($section);
			}
		});
	}

	load_chat_messages(chatId) {
		if (this.isGenerating) return;
		this.currentChatId = chatId;

		// Update sidebar active state
		this.$history.find('.history-item').removeClass('active');
		this.$history.find(`[data-id="${chatId}"]`).addClass('active');

		// Mobile: close sidebar
		this.$sidebar.removeClass('mobile-open');

		frappe.call({
			method: 'unityalgo.unityalgo.page.unitychat.api.get_chat_messages',
			args: { chat_id: chatId },
			callback: (r) => {
				if (r.message && r.message.success) {
					this.$messages.empty();
					r.message.messages.forEach(msg => {
						this.append_message(msg.content, msg.role, false);
					});
					this.scroll_to_bottom();
				}
			}
		});
	}

	send_message() {
		const message = this.$input.val().trim();
		if (!message || this.isGenerating) return;

		// UI Updates
		this.$messages.find('.empty-state').remove();
		this.append_message(message, 'user');
		this.$input.val('').trigger('input');
		this.isGenerating = true;
		this.$typing.addClass('active');
		this.scroll_to_bottom();

		frappe.call({
			method: 'unityalgo.unityalgo.page.unitychat.api.send_message',
			args: {
				message: message,
				chat_id: this.currentChatId
			},
			callback: (r) => {
				this.$typing.removeClass('active');
				this.isGenerating = false;

				if (r.message && r.message.success) {
					this.append_message(r.message.response, 'assistant');

					// If new chat created
					if (this.currentChatId !== r.message.chat_id) {
						this.currentChatId = r.message.chat_id;
						this.load_history(); // Refresh sidebar
					}
				} else {
					frappe.show_alert({ message: 'Failed to get response', indicator: 'red' });
					this.append_message("Error: Could not connect to AI service.", 'assistant');
				}
				this.scroll_to_bottom();
			}
		});
	}

	append_message(text, role, animate = true) {
		const isUser = role === 'user';
		const avatar = isUser ? frappe.get_abbr(frappe.session.user_fullname) : 'AI';

		// Parse Markdown for Assistant only (or both if you prefer)
		const contentHtml = isUser ?
			frappe.utils.escape_html(text).replace(/\n/g, '<br>') :
			marked.parse(text);

		const $row = $(`
            <div class="message-row ${role} ${animate ? 'animate-in' : ''}">
                <div class="message-inner">
                    <div class="message-avatar ${role}">${avatar}</div>
                    <div class="message-content markdown-body">
                        ${contentHtml}
                    </div>
                    ${!isUser ? `
                    <div class="message-actions">
                        <button class="msg-action-btn copy-msg" title="Copy text">
                            ${frappe.utils.icon('copy', 'xs')}
                        </button>
                    </div>` : ''}
                </div>
            </div>
        `);

		// Add copy-to-clipboard functionality for whole message
		if (!isUser) {
			$row.find('.copy-msg').on('click', () => {
				frappe.utils.copy_to_clipboard(text);
				frappe.show_alert({ message: 'Copied to clipboard', indicator: 'green' });
			});

			// Add copy buttons to code blocks
			$row.find('pre').each(function () {
				$(this).append(`<button class="copy-code-btn">${frappe.utils.icon('copy', 'xs')}</button>`);
			});
		}

		this.$messages.append($row);
	}

	start_new_chat() {
		this.currentChatId = null;
		this.$messages.html(this.get_empty_state());
		this.$history.find('.history-item').removeClass('active');
		this.$input.focus();
	}

	rename_chat(chatId, newTitle) {
		frappe.call({
			method: 'unityalgo.unityalgo.page.unitychat.api.rename_chat',
			args: { chat_id: chatId, new_title: newTitle },
			callback: (r) => {
				if (r.message.success) this.load_history();
			}
		});
	}

	delete_chat(chatId) {
		frappe.confirm('Are you sure you want to delete this chat?', () => {
			frappe.call({
				method: 'unityalgo.unityalgo.page.unitychat.api.delete_chat',
				args: { chat_id: chatId },
				callback: (r) => {
					if (r.message && r.message.success) {
						if (chatId === this.currentChatId) this.start_new_chat();
						this.load_history();
					}
				}
			});
		});
	}

	scroll_to_bottom() {
		const el = this.$messages[0];
		$(el).animate({ scrollTop: el.scrollHeight }, 300);
	}
}




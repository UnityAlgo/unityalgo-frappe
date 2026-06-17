/**
 * AlgoERP AI Chat — chat-unity.js
 * Class-based architecture for the ERP AI chat interface.
 */

/* ─────────────────────────────────────────────
   MessageFactory — builds message HTML strings
───────────────────────────────────────────── */
class MessageFactory {
  static timestamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  static user(text) {
    return `
      <div class="row user" data-role="user">
        <div class="row-av user"><i class="ti ti-user" aria-hidden="true"></i></div>
        <div class="row-body">
          <div class="row-meta">You · ${this.timestamp()}</div>
          <div class="bubble user">${this._escape(text)}</div>
        </div>
      </div>`;
  }

  static ai(html, chips = []) {
    const chipHTML = chips.length
      ? `<div class="chips">${chips.map(c =>
          `<div class="chip" data-action="chip"><i class="ti ti-${c.icon}" aria-hidden="true"></i> ${c.label}</div>`
        ).join('')}</div>`
      : '';
    return `
      <div class="row" data-role="ai">
        <div class="row-av ai"><i class="ti ti-cpu" aria-hidden="true"></i></div>
        <div class="row-body">
          <div class="row-meta">AlgoERP AI · ${this.timestamp()}</div>
          <div class="bubble ai">${html}</div>
          ${chipHTML}
        </div>
      </div>`;
  }

  static typing() {
    return `
      <div class="row" id="typingRow" data-role="typing">
        <div class="row-av ai"><i class="ti ti-cpu" aria-hidden="true"></i></div>
        <div class="row-body">
          <div class="row-meta">AlgoERP AI</div>
          <div class="bubble ai">
            <div class="typing">
              <div class="td"></div><div class="td"></div><div class="td"></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  static divider(label) {
    return `<div class="divline">${this._escape(label)}</div>`;
  }

  static kpiCard(label, value, delta, type) {
    return `
      <div class="kpi">
        <div class="kpi-l">${this._escape(label)}</div>
        <div class="kpi-v">${this._escape(value)}</div>
        <div class="kpi-d ${type}">${this._escape(delta)}</div>
      </div>`;
  }

  static flagRow(label, pct, severity) {
    const cls = severity === 'error' ? 'err' : 'wrn';
    const iconColor = severity === 'error' ? '#991b1b' : '#92400e';
    return `
      <div class="flag ${cls}">
        <i class="ti ti-alert-triangle" style="color:${iconColor}" aria-hidden="true"></i>
        <span class="flag-name">${this._escape(label)}</span>
        <span class="flag-pct">${this._escape(pct)}</span>
      </div>`;
  }

  static _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}


/* ─────────────────────────────────────────────
   ReplyEngine — generates AI response content
───────────────────────────────────────────── */
class ReplyEngine {
  constructor() {
    this.rules = [
      {
        match: ['cash', 'forecast'],
        respond: () => this._cashForecast(),
      },
      {
        match: ['headcount', 'head count', 'department', 'hr', 'employee'],
        respond: () => this._headcount(),
      },
      {
        match: ['vendor', 'supplier', 'spend'],
        respond: () => this._vendors(),
      },
      {
        match: ['receiv', 'outstanding', 'aged'],
        respond: () => this._receivables(),
      },
      {
        match: ['variance', 'q3', 'q2', 'opex', 'operating'],
        respond: () => this._variance(),
      },
      {
        match: ['overdue', 'po', 'purchase order'],
        respond: () => this._overduePOs(),
      },
      {
        match: ['revenue', 'breakdown', 'sales'],
        respond: () => this._revenue(),
      },
    ];
  }

  getReply(text) {
    const lower = text.toLowerCase();
    for (const rule of this.rules) {
      if (rule.match.some(kw => lower.includes(kw))) {
        return rule.respond();
      }
    }
    return this._fallback();
  }

  _cashForecast() {
    return {
      html: `Cash flow forecast for next month: <strong>$1.1M net positive</strong>, assuming current AR collection rate of 82%. Three large receivables totalling $340K are due within 14 days.`,
      chips: [
        { icon: 'chart-line', label: 'View full forecast' },
        { icon: 'download', label: 'Export to Excel' },
      ],
    };
  }

  _headcount() {
    return {
      html: `Current headcount: <strong>284 employees</strong> across 9 departments. Engineering (64), Sales (52), Operations (48) are the largest. 3 Finance positions are pending approval.`,
      chips: [
        { icon: 'users', label: 'View org chart' },
        { icon: 'file-export', label: 'Export headcount' },
      ],
    };
  }

  _vendors() {
    return {
      html: `Top vendor by Q3 spend: AWS at $182K, Salesforce at $94K, DHL Logistics at $78K. AWS accounts for the 38.2% variance flagged in operating expenses.`,
      chips: [
        { icon: 'table', label: 'Full vendor list' },
        { icon: 'mail', label: 'Contact procurement' },
      ],
    };
  }

  _receivables() {
    return {
      html: `Aged receivables: <strong>$1.24M outstanding</strong>. 61% current (0–30 days), 24% at 31–60 days. $89K is 90+ days overdue — recommend flagging 4 accounts for collections.`,
      chips: [
        { icon: 'alert-circle', label: 'Flag for collections' },
        { icon: 'download', label: 'Download AR report' },
      ],
    };
  }

  _variance() {
    const flags = [
      MessageFactory.flagRow('Cloud infrastructure', '+38.2%', 'error'),
      MessageFactory.flagRow('Contractor fees', '+22.7%', 'warning'),
      MessageFactory.flagRow('Marketing spend', '+17.1%', 'warning'),
    ].join('');
    return {
      html: `Analysis complete. Found 3 line items exceeding your 15% threshold:
        <div class="flags">${flags}</div>
        <div style="margin-top:8px;font-size:12px;color:#9ca3af">
          Full report saved as <code style="font-family:monospace;font-size:11px;background:#f3f4f6;padding:1px 4px;border-radius:4px">variance_q3_q2.xlsx</code>.
        </div>`,
      chips: [
        { icon: 'bug', label: 'Root cause: cloud infra' },
        { icon: 'download', label: 'Download report' },
        { icon: 'mail', label: 'Email to board' },
      ],
    };
  }

  _overduePOs() {
    return {
      html: `<strong>6 purchase orders</strong> are past their due date. Oldest is 18 days overdue from Vendor: Altech Supply. Total overdue value: $47,200. Recommend escalating 2 critical POs for expedited processing.`,
      chips: [
        { icon: 'list', label: 'View all overdue POs' },
        { icon: 'bell', label: 'Notify vendor managers' },
      ],
    };
  }

  _revenue() {
    return {
      html: `Revenue MTD breakdown — SaaS subscriptions: $1.4M (58%), Professional services: $620K (26%), Licensing: $380K (16%). Overall MTD is <strong>$2.4M</strong>, up 12.4% vs last month.`,
      chips: [
        { icon: 'chart-bar', label: 'View full breakdown' },
        { icon: 'calendar', label: 'Compare by quarter' },
      ],
    };
  }

  _fallback() {
    return {
      html: `I've queried your ERP database. Try narrowing the context filter above to a specific module for faster, more precise results.`,
      chips: [],
    };
  }
}


/* ─────────────────────────────────────────────
   ChatUI — manages DOM interactions
───────────────────────────────────────────── */
class ChatUI {
  constructor(config = {}) {
    this.messagesId = config.messagesId || 'msgs';
    this.inputId = config.inputId || 'inp';
    this.typingDelay = config.typingDelay || 1400;
    this._typingEl = null;
  }

  get messagesEl() {
    return document.getElementById(this.messagesId);
  }

  get inputEl() {
    return document.getElementById(this.inputId);
  }

  getInputValue() {
    return this.inputEl?.value.trim() || '';
  }

  clearInput() {
    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
    }
  }

  focusInput() {
    this.inputEl?.focus();
  }

  setInputValue(val) {
    if (this.inputEl) {
      this.inputEl.value = val;
      this.autoResize(this.inputEl);
      this.focusInput();
    }
  }

  autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  append(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    const node = wrap.firstElementChild;
    this.messagesEl?.appendChild(node);
    this.scrollToBottom();
    return node;
  }

  showTyping() {
    this.removeTyping();
    this._typingEl = this.append(MessageFactory.typing());
  }

  removeTyping() {
    this._typingEl?.remove();
    this._typingEl = null;
  }

  scrollToBottom() {
    const el = this.messagesEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  appendDivider(label) {
    this.append(MessageFactory.divider(label));
  }

  appendUser(text) {
    this.append(MessageFactory.user(text));
  }

  appendAI(html, chips = []) {
    this.append(MessageFactory.ai(html, chips));
  }

  setNavActive(el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }

  setContextPillActive(el) {
    document.querySelectorAll('.ctx-pill').forEach(p => p.classList.remove('on'));
    el.classList.add('on');
  }
}


/* ─────────────────────────────────────────────
   ERPChat — main controller / event hub
───────────────────────────────────────────── */
class ERPChat {
  constructor(config = {}) {
    this.ui = new ChatUI(config.ui);
    this.engine = new ReplyEngine();
    this._busy = false;
  }

  /** Bootstrap: bind all event listeners */
  init() {
    this._bindInput();
    this._bindSendButton();
    this._bindNav();
    this._bindContextPills();
    this._bindHints();
    this._bindDelegatedChips();
    console.log('[ERPChat] Initialised.');
  }

  /** Send a user message and trigger AI response */
  async sendMessage(text) {
    if (!text || this._busy) return;
    this._busy = true;

    this.ui.appendUser(text);
    this.ui.showTyping();

    await this._delay(this.ui.typingDelay);

    const { html, chips } = this.engine.getReply(text);
    this.ui.removeTyping();
    this.ui.appendAI(html, chips);

    this._busy = false;
  }

  /** Send from input field */
  sendFromInput() {
    const text = this.ui.getInputValue();
    if (!text) return;
    this.ui.clearInput();
    this.sendMessage(text);
  }

  /** Send from a chip or hint button */
  sendFromChip(text) {
    this.sendMessage(text.trim());
  }

  // ── Private binding helpers ──────────────────

  _bindInput() {
    const el = this.ui.inputEl;
    if (!el) return;

    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendFromInput();
      }
    });

    el.addEventListener('input', () => this.ui.autoResize(el));
  }

  _bindSendButton() {
    const btn = document.getElementById('sendBtn');
    btn?.addEventListener('click', () => this.sendFromInput());
  }

  _bindNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => this.ui.setNavActive(item));
    });
  }

  _bindContextPills() {
    document.querySelectorAll('.ctx-pill').forEach(pill => {
      pill.addEventListener('click', () => this.ui.setContextPillActive(pill));
    });
  }

  _bindHints() {
    document.querySelectorAll('.hint').forEach(hint => {
      hint.addEventListener('click', () => {
        this.ui.setInputValue(hint.textContent.trim());
      });
    });
  }

  /** Delegate chip clicks inside the messages container */
  _bindDelegatedChips() {
    this.ui.messagesEl?.addEventListener('click', e => {
      const chip = e.target.closest('[data-action="chip"]');
      if (chip) this.sendFromChip(chip.textContent);
    });
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}


/* ─────────────────────────────────────────────
   Boot
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const chat = new ERPChat({
    ui: {
      messagesId: 'msgs',
      inputId: 'inp',
      typingDelay: 1400,
    },
  });
  chat.init();

  window.__erpChat = chat;
});
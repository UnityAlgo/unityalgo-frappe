frappe.pages['algopos'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Point Of Sale',
		single_column: true
	});

	new POSController(page, wrapper);
};

// ─────────────────────────────────────────────
// POSItem — Single item card in the grid
// ─────────────────────────────────────────────
class POSItem {
	constructor(item) {
		this.item = item;
		this.$el = this.render();
	}

	render() {
		const img = this.item.image
			? `<img src="${this.item.image}" alt="${this.item.item_name}" />`
			: `<div class="pos-item-placeholder">${frappe.get_abbr(this.item.item_name)}</div>`;

		const stock_html = this.item.actual_qty != null
			? `<span class="pos-item-stock ${this.item.actual_qty <= 0 ? 'out' : ''}">${this.item.actual_qty} in stock</span>`
			: '';

		const el = $(`
			<div class="pos-item-card" data-item-code="${this.item.item_code}">
				<div class="pos-item-image">${img}</div>
				<div class="pos-item-detail">
					<div class="pos-item-name">${this.item.item_name}</div>
					<div class="pos-item-meta">
						<span class="pos-item-rate">${fmt_money(this.item.price_list_rate || this.item.standard_rate || 0, this.item.currency)}</span>
						${stock_html}
					</div>
				</div>
			</div>
		`);
		return el;
	}
}

// ─────────────────────────────────────────────
// POSCart — Cart / Summary panel (right side)
// ─────────────────────────────────────────────
class POSCart {
	constructor(controller) {
		this.controller = controller;
		this.items = [];
		this.discount_percentage = 0;
		this.discount_amount = 0;
		this.additional_discount_type = 'Percentage';
		this.$el = null;
		this.render();
	}

	render() {
		this.$el = $(`
			<div class="pos-cart">
				<!-- Summary Header -->
				<div class="pos-summary-header">
					<div class="pos-summary-title">
						<span>Summary</span>
					</div>
					<div class="pos-summary-badge">
						<span class="pos-item-count">0</span> items
					</div>
				</div>

				<!-- Customer Selector -->
				<div class="pos-cart-customer">
					<div class="pos-customer-field"></div>
				</div>

				<!-- Cart Items -->
				<div class="pos-cart-items-wrapper">
					<div class="pos-cart-items"></div>
					<div class="pos-cart-empty">
						<i class="fa fa-shopping-cart"></i>
						<p>No items added yet</p>
						<small>Click an item to add it here</small>
					</div>
				</div>

				<!-- Discount Row -->
				<div class="pos-cart-discount">
					<div class="pos-discount-toggle">
						<i class="fa fa-tag"></i>
						<span>Add Discount</span>
					</div>
					<div class="pos-discount-input-wrapper" style="display:none;">
						<div class="pos-discount-type-toggle">
							<button class="btn btn-xs btn-default active" data-type="Percentage">%</button>
							<button class="btn btn-xs btn-default" data-type="Amount">${this.controller.currency_symbol || '$'}</button>
						</div>
						<input type="number" class="pos-discount-input" placeholder="0" min="0" step="any" />
						<button class="btn btn-xs btn-danger pos-discount-remove" title="Remove discount">
							<i class="fa fa-times"></i>
						</button>
					</div>
				</div>

				<!-- Totals -->
				<div class="pos-cart-totals">
					<div class="pos-totals-row">
						<span>Subtotal</span>
						<span class="pos-subtotal">0.00</span>
					</div>
					<div class="pos-totals-row pos-discount-row" style="display:none;">
						<span>Discount</span>
						<span class="pos-discount-amount">-0.00</span>
					</div>
					<div class="pos-totals-row pos-tax-row" style="display:none;">
						<span class="pos-tax-label">Tax</span>
						<span class="pos-tax-amount">0.00</span>
					</div>
					<div class="pos-totals-row pos-grand-total-row">
						<span>Grand Total</span>
						<span class="pos-grand-total">0.00</span>
					</div>
				</div>

				<!-- Actions -->
				<div class="pos-cart-actions">
					<button class="btn btn-warning btn-sm pos-btn-clear-cart">Clear Cart</button>
					<button class="btn btn-success btn-sm pos-btn-checkout">
						<i class="fa fa-credit-card"></i> Checkout
					</button>
				</div>
			</div>
		`);
	}

	setup_customer_field() {
		const field_wrapper = this.$el.find('.pos-customer-field');
		this.customer_field = frappe.ui.form.make_control({
			df: {
				fieldtype: 'Link',
				options: 'Customer',
				label: 'Customer',
				placeholder: 'Search customer...',
				reqd: 1,
				onchange: () => {
					const val = this.customer_field.get_value();
					if (val) {
						this.controller.customer = val
					}
				}
			},
			parent: field_wrapper,
			render_input: true
		});
		this.customer_field.$wrapper.find('.control-label').hide();
		if (this.controller.settings.customer) {
			this.customer_field.set_value(this.controller.settings.customer);
		}
	}

	add_item(item_data) {
		const existing = this.items.find(i => i.item_code === item_data.item_code);
		if (existing) {
			existing.qty += 1;
		} else {
			this.items.push({
				item_code: item_data.item_code,
				item_name: item_data.item_name,
				rate: item_data.price_list_rate || item_data.standard_rate || 0,
				qty: 1,
				discount_percentage: 0,
				uom: item_data.stock_uom || 'Nos',
				image: item_data.image || '',
				currency: item_data.currency
			});
		}
		this.render_items();
		this.calculate_totals();
	}

	update_qty(item_code, qty) {
		const item = this.items.find(i => i.item_code === item_code);
		if (!item) return;
		if (qty <= 0) {
			this.remove_item(item_code);
			return;
		}
		item.qty = qty;
		this.render_items();
		this.calculate_totals();
	}

	update_rate(item_code, rate) {
		const item = this.items.find(i => i.item_code === item_code);
		if (!item) return;
		item.rate = Math.max(parseFloat(rate) || 0, 0);
		this.render_items();
		this.calculate_totals();
	}

	update_uom(item_code, uom) {
		const item = this.items.find(i => i.item_code === item_code);
		if (!item) return;
		item.uom = uom;
		// Optionally fetch UOM conversion rate here
	}

	set_item_discount(item_code, discount) {
		const item = this.items.find(i => i.item_code === item_code);
		if (!item) return;
		item.discount_percentage = Math.min(Math.max(parseFloat(discount) || 0, 0), 100);
		this.render_items();
		this.calculate_totals();
	}

	remove_item(item_code) {
		this.items = this.items.filter(i => i.item_code !== item_code);
		this.render_items();
		this.calculate_totals();
	}

	clear() {
		this.items = [];
		this.discount_percentage = 0;
		this.discount_amount = 0;
		this.render_items();
		this.calculate_totals();
		this.$el.find('.pos-discount-input').val('');
		this.$el.find('.pos-discount-input-wrapper').hide();
		this.$el.find('.pos-discount-toggle').show();
	}

	render_items() {
		const $list = this.$el.find('.pos-cart-items');
		const $empty = this.$el.find('.pos-cart-empty');
		$list.empty();

		// Update badge count
		const total_qty = this.items.reduce((sum, i) => sum + i.qty, 0);
		this.$el.find('.pos-item-count').text(total_qty);

		if (this.items.length === 0) {
			$empty.show();
			return;
		}
		$empty.hide();

		this.items.forEach(item => {
			const line_total = item.qty * item.rate * (1 - item.discount_percentage / 100);

			const $row = $(`
				<div class="pos-cart-item" data-item-code="${item.item_code}">
					<div class="pos-cart-item-main">
						<div class="pos-cart-item-img">
							<img src="${item.image || "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRKRJrDYBNTBKwD4ZqwrbzooHmszgc-sQunBw&s"}" alt="${item.item_name}" />
						</div>
						<div class="pos-cart-item-info">
							<div class="pos-cart-item-name">${item.item_name}</div>
							<div class="pos-cart-item-meta-line">
								<span class="pos-cart-item-uom-label">${item.uom}</span>
								<span class="pos-cart-item-qty-label">${item.qty} × ${fmt_money(item.rate, item.currency)}</span>
								${item.discount_percentage > 0
					? `<span class="pos-cart-item-disc-badge">-${item.discount_percentage}%</span>` : ''}	
							</div>

							<div class="pos-cart-item-total">${fmt_money(line_total, item.currency)}</div>
						</div>
						<div class="pos-cart-item-right">
							
							<div class="pos-cart-item-actions">
								<button class="btn btn-xs btn-icon pos-cart-item-edit" title="Edit">
									<i class="fa fa-edit" style="font-size: 1.25rem;"></i>
								</button>
								<button class="btn btn-xs btn-icon pos-cart-item-remove" title="Remove">
									<i class="fa fa-trash-o" style="font-size: 1.25rem;color: var(--danger);"></i>
								</button>
							</div>
						</div>
					</div>
				</div>
			`);

			$list.append($row);
		});
	}

	show_edit_dialog(item_code) {
		const item = this.items.find(i => i.item_code === item_code);
		if (!item) return;

		const self = this;
		const line_total = () => {
			const qty = d.get_value('qty') || 0;
			const rate = d.get_value('rate') || 0;
			const disc = d.get_value('discount_percentage') || 0;
			return qty * rate * (1 - disc / 100);
		};

		const update_summary = () => {
			const total = line_total();
			d.fields_dict.line_summary.$wrapper.html(`
				<div class="pos-dialog-line-summary">
					<span>Line Total:</span>
					<strong>${fmt_money(total, item.currency)}</strong>
				</div>
			`);
		};


		const d = new frappe.ui.Dialog({
			title: __('Edit Item'),
			fields: [
				{
					fieldtype: 'HTML',
					fieldname: 'item_header',
					options: `
						<div style="display:flex;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--border-color,#d1d8dd);margin-bottom:4px;">
							<img src="${item.image || "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRKRJrDYBNTBKwD4ZqwrbzooHmszgc-sQunBw&s"}" style="width: 80px;height: 80px;object-fit: contain;" />
							<div>
								<div style="font-weight:700;font-size:14px;color:var(--text-color);">${item.item_name}</div>
								<div style="font-size:12px;color:var(--text-muted);">${item.item_code}</div>
							</div>
						</div>
					`
				},
				{
					fieldtype: 'Section Break'
				},
				{
					fieldtype: 'Int',
					fieldname: 'qty',
					label: __('Quantity'),
					default: item.qty,
					reqd: 1,
					onchange: update_summary
				},
				{
					fieldtype: 'Column Break'
				},
				{
					fieldtype: 'Currency',
					fieldname: 'rate',
					label: __('Rate'),
					default: item.rate,
					reqd: 1,
					options: 'company:currency',
					onchange: update_summary
				},
				{
					fieldtype: 'Section Break'
				},
				{
					fieldtype: 'Link',
					fieldname: 'uom',
					label: __('UOM'),
					options: 'UOM',
					default: item.uom
				},
				{
					fieldtype: 'Column Break'
				},
				{
					fieldtype: 'Float',
					fieldname: 'discount_percentage',
					label: __('Discount %'),
					default: item.discount_percentage || 0,
					onchange: update_summary
				},
				{
					fieldtype: 'Section Break'
				},
				{
					fieldtype: 'HTML',
					fieldname: 'line_summary',
					options: '<div class="pos-dialog-line-summary"></div>'
				}
			],
			size: 'medium',
			primary_action_label: __('Update'),
			primary_action: (values) => {
				const qty = cint(values.qty);
				if (qty <= 0) {
					self.remove_item(item_code);
				} else {
					item.qty = qty;
					item.rate = Math.max(flt(values.rate), 0);
					item.uom = values.uom || item.uom;
					item.discount_percentage = Math.min(Math.max(flt(values.discount_percentage), 0), 100);
					self.render_items();
					self.calculate_totals();
				}
				d.hide();
			},
			secondary_action_label: __('Remove Item'),
			secondary_action: () => {
				self.remove_item(item_code);
				d.hide();
			}
		});

		d.show();

		// Style the secondary (remove) button red
		d.$wrapper.find('.btn-secondary, .btn-modal-secondary').addClass('btn-danger').removeClass('btn-secondary btn-modal-secondary');
		update_summary();
	}

	calculate_totals() {
		let subtotal = 0;
		this.items.forEach(item => {
			subtotal += item.qty * item.rate * (1 - item.discount_percentage / 100);
		});

		let discount_val = 0;
		if (this.additional_discount_type === 'Percentage') {
			discount_val = subtotal * (this.discount_percentage / 100);
		} else {
			discount_val = this.discount_amount;
		}
		discount_val = Math.min(discount_val, subtotal);

		const net_total = subtotal - discount_val;
		const tax_rate = this.controller.tax_rate || 0;
		const tax_amount = net_total * (tax_rate / 100);
		const grand_total = net_total + tax_amount;

		const currency = this.controller.currency;
		this.$el.find('.pos-subtotal').text(fmt_money(subtotal, currency));

		if (discount_val > 0) {
			this.$el.find('.pos-discount-row').show();
			this.$el.find('.pos-discount-amount').text('-' + fmt_money(discount_val, currency));
		} else {
			this.$el.find('.pos-discount-row').hide();
		}

		if (tax_amount > 0) {
			this.$el.find('.pos-tax-row').show();
			this.$el.find('.pos-tax-amount').text(fmt_money(tax_amount, currency));
		} else {
			this.$el.find('.pos-tax-row').hide();
		}

		this.$el.find('.pos-grand-total').text(fmt_money(grand_total, currency));

		this.controller.totals = { subtotal, discount_val, tax_amount, grand_total, net_total };
	}

	bind_events() {
		const self = this;

		// ── Edit button: open frappe.ui.Dialog ──
		this.$el.on('click', '.pos-cart-item-edit', function (e) {
			e.stopPropagation();
			const item_code = $(this).closest('.pos-cart-item').data('item-code');
			self.show_edit_dialog(item_code);
		});

		// ── Remove item ──
		this.$el.on('click', '.pos-cart-item-remove', function (e) {
			e.stopPropagation();
			const item_code = $(this).closest('.pos-cart-item').data('item-code');
			self.remove_item(item_code);
		});

		// ── Cart-level discount toggle ──
		this.$el.on('click', '.pos-discount-toggle', function () {
			$(this).hide();
			self.$el.find('.pos-discount-input-wrapper').show();
			self.$el.find('.pos-discount-input').focus();
		});

		this.$el.on('click', '.pos-discount-type-toggle .btn', function () {
			$(this).addClass('active').siblings().removeClass('active');
			self.additional_discount_type = $(this).data('type');
			self.apply_cart_discount();
		});

		this.$el.on('input', '.pos-discount-input', function () {
			self.apply_cart_discount();
		});

		this.$el.on('click', '.pos-discount-remove', function () {
			self.discount_percentage = 0;
			self.discount_amount = 0;
			self.$el.find('.pos-discount-input').val('');
			self.$el.find('.pos-discount-input-wrapper').hide();
			self.$el.find('.pos-discount-toggle').show();
			self.calculate_totals();
		});

		// ── Cart actions ──
		this.$el.on('click', '.pos-btn-clear-cart', function () {
			frappe.confirm('Clear all items from cart?', () => self.clear());
		});

		this.$el.on('click', '.pos-btn-checkout', function () {
			self.controller.show_payment_dialog();
		});
	}

	apply_cart_discount() {
		const val = parseFloat(this.$el.find('.pos-discount-input').val()) || 0;
		if (this.additional_discount_type === 'Percentage') {
			this.discount_percentage = Math.min(Math.max(val, 0), 100);
			this.discount_amount = 0;
		} else {
			this.discount_amount = Math.max(val, 0);
			this.discount_percentage = 0;
		}
		this.calculate_totals();
	}
}


// ─────────────────────────────────────────────
// POSPayment — Payment dialog
// ─────────────────────────────────────────────
class POSPayment {
	constructor(controller) {
		this.controller = controller;
		this.payments = [];
		this.dialog = null;
	}

	show() {
		if (!this.controller.customer) {
			frappe.throw(__('Please select a Customer before checkout.'));
			return;
		}
		if (!this.controller.cart.items.length) {
			frappe.throw(__('Cart is empty.'));
			return;
		}

		const grand_total = this.controller.totals.grand_total;
		const currency = this.controller.currency;
		this.payments = [];

		const modes = this.controller.settings.payments || [
			{ mode_of_payment: 'Cash', default: 1 },
			{ mode_of_payment: 'Credit Card', default: 0 }
		];

		let fields = [
			{
				fieldtype: 'HTML',
				fieldname: 'payment_summary',
				options: `
					<div class="pos-payment-summary">
						<div class="pos-payment-total-label">Amount Due</div>
						<div class="pos-payment-total-value">${fmt_money(grand_total, currency)}</div>
					</div>
				`
			},
			{ fieldtype: 'Section Break' }
		];

		modes.forEach((mode, idx) => {
			fields.push({
				fieldtype: 'Currency',
				fieldname: `pay_${idx}`,
				label: mode.mode_of_payment,
				default: mode.default ? grand_total : 0,
				options: 'company:currency',
				onchange: () => this.update_payment_status()
			});
		});

		fields.push(
			{ fieldtype: 'Section Break' },
			{
				fieldtype: 'HTML',
				fieldname: 'payment_status',
				options: '<div class="pos-payment-status"></div>'
			}
		);

		this.dialog = new frappe.ui.Dialog({
			title: 'Payment',
			fields: fields,
			size: 'small',
			primary_action_label: 'Submit',
			primary_action: () => this.submit_payment(modes)
		});

		this.dialog.show();
		this.modes = modes;
		this.update_payment_status();
	}

	update_payment_status() {
		if (!this.dialog) return;
		const grand_total = this.controller.totals.grand_total;
		let paid = 0;
		this.modes.forEach((mode, idx) => {
			paid += flt(this.dialog.get_value(`pay_${idx}`));
		});
		const remaining = grand_total - paid;
		const change = paid > grand_total ? paid - grand_total : 0;

		let html = '';
		if (remaining > 0) {
			html = `<div class="text-warning"><strong>Remaining:</strong> ${fmt_money(remaining, this.controller.currency)}</div>`;
			this.dialog.get_primary_btn().prop('disabled', true);
		} else {
			if (change > 0) {
				html = `<div class="text-success"><strong>Change:</strong> ${fmt_money(change, this.controller.currency)}</div>`;
			} else {
				html = `<div class="text-success"><strong>Fully Paid</strong></div>`;
			}
			this.dialog.get_primary_btn().prop('disabled', false);
		}
		this.dialog.fields_dict.payment_status.$wrapper.html(`<div class="pos-payment-status">${html}</div>`);
	}

	submit_payment(modes) {
		const grand_total = this.controller.totals.grand_total;
		let paid = 0;
		const payment_entries = [];

		modes.forEach((mode, idx) => {
			const amount = flt(this.dialog.get_value(`pay_${idx}`));
			if (amount > 0) {
				payment_entries.push({
					mode_of_payment: mode.mode_of_payment,
					amount: amount
				});
				paid += amount;
			}
		});

		if (paid < grand_total) {
			frappe.throw(__('Paid amount is less than the grand total.'));
			return;
		}

		this.dialog.hide();
		this.controller.submit_order(payment_entries, paid - grand_total);
	}
}


// ─────────────────────────────────────────────
// POSController — Main orchestrator
// ─────────────────────────────────────────────
class POSController {
	constructor(page, wrapper) {
		this.page = page;
		this.customer = null;
		this.settings = {};
		this.items = [];
		this.item_groups = [];
		this.totals = { subtotal: 0, discount_val: 0, tax_amount: 0, grand_total: 0, net_total: 0 };
		this.currency = frappe.defaults.get_default('currency') || 'USD';
		this.currency_symbol = '';
		this.tax_rate = 0;
		this.search_term = '';
		this.selected_group = 'All Item Groups';
		this.$wrapper = $(wrapper);
		this.$page = $(page.body);
		this.cart = null;
		this.payment = null;

		// ── Selections ───────────────
		this.company = frappe.defaults.get_default('company') || '';
		this.branch = '';
		this.sales_person = '';

		this.make();
	}

	make() {
		this.render_layout();
		this.cart = new POSCart(this);
		this.$page.find('.pos-cart-wrapper').append(this.cart.$el);
		this.cart.bind_events();
		this.payment = new POSPayment(this);
		this.setup_selector_fields();

		this.load_settings().then(() => {
			this.cart.setup_customer_field();
			this.apply_settings_to_selectors();
			this.fetch_item_groups();
			this.fetch_items();
		});
	}

	// ── Settings (2-step: find profile name → fetch data) ──
	load_settings() {
		return frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'POS Profile',
				filters: { disabled: 0 },
				fields: ['name'],
				limit_page_length: 1
			}
		}).then(r => {
			if (r && r.message && r.message.length) {
				const profile_name = r.message[0].name;
				return this._fetch_pos_profile_data(profile_name);
			} else {
				frappe.show_alert({
					message: __('No POS Profile found. Using system defaults.'),
					indicator: 'orange'
				});
				this.settings = {};
				return Promise.resolve();
			}
		}).catch(err => {
			console.error('POS load_settings error:', err);
			this.settings = {};
			return Promise.resolve();
		});
	}

	_fetch_pos_profile_data(profile_name) {
		return frappe.call({
			method: 'erpnext.selling.page.point_of_sale.point_of_sale.get_pos_profile_data',
			args: { pos_profile: profile_name },
			freeze: true,
			freeze_message: __('Loading POS Settings...')
		}).then(r => {
			if (r && r.message) {
				this.settings = r.message;
				this.settings.name = this.settings.name || profile_name;
				this.currency = this.settings.currency || this.currency;
				this.currency_symbol = frappe.boot.sysdefaults.currency_symbol || '';
				this.tax_rate = flt(this.settings.tax_rate);
				if (this.settings.customer) {
					this.set_customer(this.settings.customer);
				}
			}
		}).catch(() => {
			return this._load_settings_fallback(profile_name);
		});
	}

	_load_settings_fallback(profile_name) {
		return frappe.call({
			method: 'frappe.client.get',
			args: { doctype: 'POS Profile', name: profile_name }
		}).then(r => {
			if (r && r.message) {
				const profile = r.message;
				this.settings = {
					name: profile.name,
					company: profile.company,
					warehouse: profile.warehouse,
					currency: profile.currency,
					selling_price_list: profile.selling_price_list,
					customer: profile.customer,
					branch: profile.branch || '',
					print_format: profile.print_format || '',
					tax_rate: 0,
					payments: (profile.payments || []).map(p => ({
						mode_of_payment: p.mode_of_payment,
						default: p.default
					}))
				};
				this.currency = profile.currency || this.currency;
				this.currency_symbol = frappe.boot.sysdefaults.currency_symbol || '';
				if (profile.customer) {
					this.set_customer(profile.customer);
				}
			}
		});
	}

	// ── Selector Fields (Company, Branch, Sales Person) ──
	setup_selector_fields() {
		const $bar = this.$page.find('.pos-selectors-bar');

		this.company_field = frappe.ui.form.make_control({
			df: {
				fieldtype: 'Link',
				options: 'Company',
				label: 'Company',
				placeholder: 'Select Company...',
				reqd: 1,
				default: this.company,
				onchange: () => {
					const val = this.company_field.get_value();
					if (val && val !== this.company) {
						this.company = val;
						frappe.db.get_value('Company', val, 'default_currency').then(r => {
							if (r && r.message) {
								this.currency = r.message.default_currency || this.currency;
								this.cart.calculate_totals();
							}
						});
						this.fetch_items();
					}
				}
			},
			parent: $bar.find('.pos-field-company'),
			render_input: true
		});
		this.company_field.$wrapper.find('.control-label').hide();

		this.branch_field = frappe.ui.form.make_control({
			df: {
				fieldtype: 'Link',
				options: 'Branch',
				label: 'Branch',
				placeholder: 'Select Branch...',
				onchange: () => {
					this.branch = this.branch_field.get_value() || '';
				}
			},
			parent: $bar.find('.pos-field-branch'),
			render_input: true
		});
		this.branch_field.$wrapper.find('.control-label').hide();

		this.sales_person_field = frappe.ui.form.make_control({
			df: {
				fieldtype: 'Link',
				options: 'Sales Person',
				label: 'Sales Person',
				placeholder: 'Select Sales Person...',
				onchange: () => {
					this.sales_person = this.sales_person_field.get_value() || '';
				}
			},
			parent: $bar.find('.pos-field-salesperson'),
			render_input: true
		});
		this.sales_person_field.$wrapper.find('.control-label').hide();

		if (this.company) {
			this.company_field.set_value(this.company);
		}
	}

	apply_settings_to_selectors() {
		if (this.settings.company) {
			this.company = this.settings.company;
			this.company_field.set_value(this.company);
		}
		if (this.settings.branch) {
			this.branch = this.settings.branch;
			this.branch_field.set_value(this.branch);
		}
		if (this.settings.sales_person) {
			this.sales_person = this.settings.sales_person;
			this.sales_person_field.set_value(this.sales_person);
		}
	}

	// ── Customer ──────────────────────────────
	set_customer(customer) {
		this.customer = customer;
		if (this.cart.customer_field) {
			this.cart.customer_field.set_value(customer);
		}
	}

	new_customer_dialog() {
		const d = new frappe.ui.Dialog({
			title: 'New Customer',
			fields: [
				{ fieldtype: 'Data', fieldname: 'customer_name', label: 'Customer Name', reqd: 1 },
				{ fieldtype: 'Data', fieldname: 'mobile_no', label: 'Mobile No' },
				{ fieldtype: 'Data', fieldname: 'email_id', label: 'Email' },
				{ fieldtype: 'Link', fieldname: 'customer_group', label: 'Customer Group', options: 'Customer Group' },
				{ fieldtype: 'Link', fieldname: 'territory', label: 'Territory', options: 'Territory' }
			],
			primary_action_label: 'Create',
			primary_action: (values) => {
				frappe.call({
					method: 'frappe.client.insert',
					args: {
						doc: {
							doctype: 'Customer',
							customer_name: values.customer_name,
							customer_type: 'Individual',
							customer_group: values.customer_group || this.settings.customer_group || 'Individual',
							territory: values.territory || this.settings.territory || 'All Territories',
							mobile_no: values.mobile_no,
							email_id: values.email_id
						}
					},
					freeze: true,
					callback: (r) => {
						if (r && r.message) {
							frappe.show_alert({ message: __('Customer created'), indicator: 'green' });
							this.set_customer(r.message.name);
							d.hide();
						}
					}
				});
			}
		});
		d.show();
	}

	// ── Items ─────────────────────────────────
	fetch_item_groups() {
		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Item Group',
				filters: { is_group: 0 },
				fields: ['name', 'image'],
				order_by: 'name asc',
				limit_page_length: 0
			}
		}).then(r => {
			if (r && r.message) {
				this.item_groups = r.message.map(g => g.name);
				this.render_categories();
			}
		}).catch(() => {
			frappe.call({
				method: 'frappe.client.get_list',
				args: {
					doctype: 'Item',
					fields: ['distinct item_group as name'],
					filters: { disabled: 0, has_variants: 0, is_sales_item: 1 },
					limit_page_length: 0
				}
			}).then(r => {
				if (r && r.message) {
					this.item_groups = r.message.map(g => g.name);
					this.render_categories();
				}
			});
		});
	}

	fetch_items() {
		const filters = {
			disabled: 0,
			has_variants: 0,
			is_sales_item: 1
		};
		if (this.selected_group && this.selected_group !== 'All Item Groups') {
			filters.item_group = this.selected_group;
		}
		if (this.search_term) {
			filters.item_name = ['like', `%${this.search_term}%`];
		}

		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Item',
				filters: filters,
				fields: [
					'name as item_code', 'item_name', 'image',
					'standard_rate', 'stock_uom', 'item_group'
				],
				order_by: 'item_name asc',
				limit_page_length: 60
			},
			freeze: !this.items.length,
			freeze_message: __('Fetching items...')
		}).then(r => {
			if (r && r.message) {
				this.items = r.message;
				this.enrich_items_with_price().then(() => {
					this.render_items();
				});
			}
		});
	}

	enrich_items_with_price() {
		const price_list = this.settings.selling_price_list || frappe.defaults.get_default('selling_price_list');
		if (!price_list) {
			this.items.forEach(i => { i.price_list_rate = i.standard_rate; i.currency = this.currency; });
			return Promise.resolve();
		}

		const item_codes = this.items.map(i => i.item_code);
		return frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Item Price',
				filters: {
					price_list: price_list,
					item_code: ['in', item_codes],
					selling: 1
				},
				fields: ['item_code', 'price_list_rate', 'currency'],
				limit_page_length: 0
			}
		}).then(r => {
			const price_map = {};
			if (r && r.message) {
				r.message.forEach(p => { price_map[p.item_code] = p; });
			}
			this.items.forEach(item => {
				if (price_map[item.item_code]) {
					item.price_list_rate = price_map[item.item_code].price_list_rate;
					item.currency = price_map[item.item_code].currency || this.currency;
				} else {
					item.price_list_rate = item.standard_rate;
					item.currency = this.currency;
				}
			});
		});
	}

	// ── Render ─────────────────────────────────
	render_layout() {
		this.$page.html(`
			<div class="pos-container">
				<div class="pos-items-panel">
					<div class="pos-selectors-bar">
						<div class="pos-selector-field pos-field-company"></div>
						<div class="pos-selector-field pos-field-branch"></div>
						<div class="pos-selector-field pos-field-salesperson"></div>
					</div>
					<div class="pos-search-bar">
						<div class="pos-search-input-wrapper">
							<i class="fa fa-search"></i>
							<input type="text" class="pos-search-input" placeholder="Search items by name or barcode..." />
						</div>
					</div>
					<div class="pos-categories">
						<div class="pos-category-list"></div>
					</div>
					<div class="pos-items-grid"></div>
					<div class="pos-items-empty" style="display:none;">
						<i class="fa fa-box-open fa-2x"></i>
						<p>No items found</p>
					</div>
				</div>
				<div class="pos-cart-wrapper"></div>
			</div>
		`);
		this.bind_events();
	}

	render_categories() {
		const $list = this.$page.find('.pos-category-list');
		$list.empty();
		$list.append(`<button class="pos-category-btn active" data-group="All Item Groups">All</button>`);
		this.item_groups.forEach(group => {
			$list.append(`<button class="pos-category-btn" data-group="${group}">${group}</button>`);
		});
	}

	render_items() {
		const $grid = this.$page.find('.pos-items-grid');
		const $empty = this.$page.find('.pos-items-empty');
		$grid.empty();

		if (!this.items.length) {
			$empty.show();
			return;
		}
		$empty.hide();

		this.items.forEach(item => {
			const card = new POSItem(item);
			$grid.append(card.$el);
		});
	}

	// ── Events ────────────────────────────────
	bind_events() {
		const self = this;
		let search_timeout;

		this.$page.on('input', '.pos-search-input', function () {
			clearTimeout(search_timeout);
			search_timeout = setTimeout(() => {
				self.search_term = $(this).val().trim();
				self.fetch_items();
			}, 350);
		});

		this.$page.on('click', '.pos-category-btn', function () {
			$(this).addClass('active').siblings().removeClass('active');
			self.selected_group = $(this).data('group');
			self.fetch_items();
		});

		this.$page.on('click', '.pos-item-card', function () {
			const item_code = $(this).data('item-code');
			const item = self.items.find(i => i.item_code === item_code);
			if (item) {
				self.cart.add_item(item);
				$(this).addClass('pos-item-added');
				setTimeout(() => $(this).removeClass('pos-item-added'), 300);
			}
		});
	}

	// ── Payment ───────────────────────────────
	show_payment_dialog() {
		this.payment.show();
	}

	// ── Submit Order ──────────────────────────
	submit_order(payment_entries, change_amount) {
		const items = this.cart.items.map(item => ({
			item_code: item.item_code,
			item_name: item.item_name,
			qty: item.qty,
			rate: item.rate,
			discount_percentage: item.discount_percentage,
			uom: item.uom
		}));

		const payments = payment_entries.map(p => ({
			mode_of_payment: p.mode_of_payment,
			amount: p.amount
		}));

		const args = {
			customer: this.customer,
			company: this.company || this.settings.company || frappe.defaults.get_default('company'),
			pos_profile: this.settings.name || '',
			branch: this.branch,
			sales_person: this.sales_person,
			items: items,
			payments: payments,
			change_amount: change_amount,
			additional_discount_percentage: this.cart.additional_discount_type === 'Percentage' ? this.cart.discount_percentage : 0,
			discount_amount: this.cart.additional_discount_type === 'Amount' ? this.cart.discount_amount : 0
		};

		this.create_sales_invoice_direct(args);
	}

	create_sales_invoice_direct(args) {
		const invoice = {
			doctype: 'Sales Invoice',
			customer: args.customer,
			company: args.company,
			pos_profile: args.pos_profile,
			is_pos: 1,
			update_stock: 1,
			branch: args.branch || '',
			items: args.items.map(item => ({
				item_code: item.item_code,
				qty: item.qty,
				rate: item.rate,
				uom: item.uom,
				discount_percentage: item.discount_percentage
			})),
			payments: args.payments.map(p => ({
				mode_of_payment: p.mode_of_payment,
				amount: p.amount
			})),
			sales_team: args.sales_person ? [{
				sales_person: args.sales_person,
				allocated_percentage: 100
			}] : [],
			change_amount: args.change_amount,
			additional_discount_percentage: args.additional_discount_percentage,
			discount_amount: args.discount_amount
		};

		frappe.call({
			method: 'frappe.client.save',
			args: { doc: invoice },
			freeze: true,
			freeze_message: __('Saving invoice...'),
			callback: (r) => {
				if (r && r.message) {
					frappe.call({
						method: 'frappe.client.submit',
						args: { doc: r.message },
						callback: (sr) => {
							this.on_order_success(sr.message || r.message);
						}
					});
				}
			}
		});
	}

	on_order_success(invoice) {
		frappe.show_alert({
			message: __('Invoice {0} created successfully', [
				`<a href="/app/sales-invoice/${invoice.name}">${invoice.name}</a>`
			]),
			indicator: 'green'
		}, 8);

		this.show_receipt_dialog(invoice);
		this.cart.clear();
	}

	show_receipt_dialog(invoice) {
		const d = new frappe.ui.Dialog({
			title: `Invoice: ${invoice.name}`,
			size: 'large',
			fields: [
				{
					fieldtype: 'HTML',
					fieldname: 'receipt_html',
					options: `<div class="pos-receipt-loading">Loading receipt...</div>`
				}
			]
		});

		d.set_secondary_action_label('Print');
		d.set_secondary_action(() => {
			frappe.utils.print_dialog(invoice.doctype || 'Sales Invoice', invoice.name);
		});

		d.show();

		frappe.call({
			method: 'frappe.www.printview.get_html_and_style',
			args: {
				doc: invoice.doctype || 'Sales Invoice',
				name: invoice.name,
				print_format: this.settings.print_format || 'POS Invoice'
			},
			callback: (r) => {
				if (r && r.message) {
					d.fields_dict.receipt_html.$wrapper.html(r.message.html);
				} else {
					d.fields_dict.receipt_html.$wrapper.html(`
						<div style="text-align:center;padding:30px;">
							<p><strong>${invoice.name}</strong> created.</p>
							<p>Total: ${fmt_money(invoice.grand_total || invoice.rounded_total, this.currency)}</p>
							<a href="/app/sales-invoice/${invoice.name}" class="btn btn-default btn-sm">
								Open Invoice
							</a>
						</div>
					`);
				}
			}
		});
	}
}

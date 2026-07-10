frappe.pages["cash-flow-and-treasu"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Cash Flow & Treasury",
		single_column: true,
	});

	new CashFlowTreasuryDashboard(page, wrapper);
};

class CashFlowTreasuryDashboard {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = $(wrapper);
		this.currency = "PKR";
		this.horizon = 90;
		this.scenario = "base";
		this.filters = {
			company: "UnityAlgo",
			branch: "All Branches",
			businessUnit: "All Units",
			costCenter: "All Cost Centers",
			project: "All Projects",
			bankAccount: "All Accounts",
		};
		this.data = this.get_seed_data();
		this.manualItems = [...this.data.manualForecastItems];

		this.render();
		this.bind_events();
		this.refresh();
	}

	get_seed_data() {
		const today = this.start_of_day(new Date());
		const addDays = (days) => this.add_days(today, days);

		return {
			cashAccounts: [
				{
					id: "hbl-main",
					name: "HBL Main Operating",
					accountType: "Bank",
					company: "UnityAlgo",
					branch: "Head Office",
					businessUnit: "Core ERP",
					currency: "PKR",
					currentBalance: 7400000,
					minimumRequiredBalance: 1000000,
					restrictedAmount: 250000,
					reservedAmount: 500000,
					reserveType: "minimum balance",
					isPrimaryOperatingAccount: true,
				},
				{
					id: "meezan-payroll",
					name: "Meezan Payroll Account",
					accountType: "Bank",
					company: "UnityAlgo",
					branch: "Head Office",
					businessUnit: "Operations",
					currency: "PKR",
					currentBalance: 1250000,
					minimumRequiredBalance: 300000,
					restrictedAmount: 0,
					reservedAmount: 300000,
					reserveType: "payroll reserve",
					isPayrollAccount: true,
				},
				{
					id: "alfalah-tax",
					name: "Bank Alfalah Tax Reserve",
					accountType: "Bank",
					company: "UnityAlgo",
					branch: "Head Office",
					businessUnit: "Finance",
					currency: "PKR",
					currentBalance: 980000,
					minimumRequiredBalance: 250000,
					restrictedAmount: 420000,
					reservedAmount: 0,
					reserveType: "tax reserve",
					isTaxAccount: true,
				},
				{
					id: "cash-office",
					name: "Office Petty Cash",
					accountType: "Cash",
					company: "UnityAlgo",
					branch: "Lahore",
					businessUnit: "Operations",
					currency: "PKR",
					currentBalance: 375000,
					minimumRequiredBalance: 50000,
					restrictedAmount: 0,
					reservedAmount: 0,
					reserveType: "available",
				},
			],
			inflows: [
				this.inflow("SI-00084", "Sales Invoice", "ABC Textiles", "ERP subscription renewal", 2100000, addDays(5), -2, "High"),
				this.inflow("SI-00091", "Sales Invoice", "Northstar Foods", "Implementation milestone", 1450000, addDays(13), 4, "Medium"),
				this.inflow("SI-00102", "Sales Invoice", "Khyber Retail", "Support retainer", 850000, addDays(21), 11, "Medium"),
				this.inflow("ADV-00011", "Customer Advance", "Premier Logistics", "Committed advance", 1250000, addDays(31), 0, "Confirmed"),
				this.inflow("SI-00118", "Sales Invoice", "Crescent Pharma", "Integration services", 3200000, addDays(48), 18, "Low"),
			],
			outflows: [
				this.outflow("PAY-2026-07", "Payroll", "July salary run", "Employees", 3000000, addDays(7), "Critical", "meezan-payroll"),
				this.outflow("PI-00422", "Purchase Invoice", "Cloud infrastructure", "AWS Partner", 1420000, addDays(10), "High", "hbl-main"),
				this.outflow("RENT-07", "Recurring Expense", "Office rent", "Landlord", 650000, addDays(15), "High", "hbl-main"),
				this.outflow("TAX-ADV-Q1", "Tax", "Advance tax payment", "FBR", 1750000, addDays(24), "Critical", "alfalah-tax"),
				this.outflow("PI-00439", "Purchase Invoice", "Hardware refresh", "Tech Supplier", 2100000, addDays(38), "Normal", "hbl-main"),
				this.outflow("LOAN-08", "Loan Repayment", "Term loan instalment", "Bank", 950000, addDays(58), "Critical", "hbl-main"),
			],
			manualForecastItems: [
				{
					id: "manual-investor",
					type: "INFLOW",
					sourceType: "INVESTOR_FUNDING",
					description: "Expected investor funding",
					expectedDate: addDays(42),
					amount: 5000000,
					probability: 0.45,
					priority: "Normal",
					status: "DRAFT",
					accountId: "hbl-main",
				},
				{
					id: "manual-server",
					type: "OUTFLOW",
					sourceType: "MANUAL",
					description: "Planned server purchase",
					expectedDate: addDays(52),
					amount: 1150000,
					probability: 0.8,
					priority: "Optional",
					status: "APPROVED",
					accountId: "hbl-main",
				},
			],
		};
	}

	inflow(reference, sourceType, customer, description, amount, dueDate, averageDelayDays, confidence) {
		const probability = this.probability_from_delay(dueDate);
		return {
			type: "INFLOW",
			reference,
			sourceType,
			customer,
			description,
			originalAmount: amount,
			outstandingAmount: amount,
			dueDate,
			expectedDate: this.add_days(dueDate, Math.max(0, averageDelayDays)),
			averageDelayDays,
			probability,
			confidence: confidence || this.confidence_label(probability),
			status: "Unpaid",
			accountId: "hbl-main",
		};
	}

	outflow(reference, sourceType, description, party, amount, dueDate, priority, accountId) {
		return {
			type: "OUTFLOW",
			reference,
			sourceType,
			party,
			description,
			outstandingAmount: amount,
			dueDate,
			expectedDate: dueDate,
			probability: 1,
			priority,
			status: "Committed",
			accountId,
		};
	}

	render() {
		$(this.page.body).html(`
			<div class="treasury-dashboard">
				<section class="treasury-filter-band">
					<div class="treasury-filter-grid">
						${this.select_filter("company", "Company", ["UnityAlgo"])}
						${this.select_filter("branch", "Branch", ["All Branches", "Head Office", "Lahore"])}
						${this.select_filter("businessUnit", "Business Unit", ["All Units", "Core ERP", "Operations", "Finance"])}
						${this.select_filter("costCenter", "Cost Center", ["All Cost Centers", "Main - U", "Sales - U", "Admin - U"])}
						${this.select_filter("project", "Project", ["All Projects", "ERP Rollout", "Support Desk"])}
						${this.select_filter("currency", "Currency", ["PKR"])}
						${this.select_filter("bankAccount", "Bank Account", ["All Accounts", ...this.data.cashAccounts.map((a) => a.name)])}
						${this.select_filter("horizon", "Forecast Horizon", ["7 days", "14 days", "30 days", "60 days", "90 days", "6 months", "12 months"])}
						${this.select_filter("scenario", "Scenario", ["Base Case", "Best Case", "Worst Case", "Custom"])}
					</div>
				</section>

				<section class="treasury-kpis" data-section="kpis"></section>

				<section class="treasury-main-grid">
					<div class="treasury-panel treasury-chart-panel">
						<div class="treasury-panel-head">
							<div>
								<h3>Future Cash Balance</h3>
								<p>Daily opening, expected movements, and closing cash.</p>
							</div>
							<div class="treasury-chart-legend">
								<span><i class="legend-line"></i> Closing cash</span>
								<span><i class="legend-reserve"></i> Minimum reserve</span>
							</div>
						</div>
						<div class="treasury-chart" data-section="chart"></div>
					</div>

					<div class="treasury-panel treasury-alert-panel" data-section="alert"></div>
				</section>

				<section class="treasury-two-col">
					<div class="treasury-panel" data-section="cash-in"></div>
					<div class="treasury-panel" data-section="cash-out"></div>
				</section>

				<section class="treasury-panel">
					<div class="treasury-panel-head">
						<div>
							<h3>Bank Account Forecast</h3>
							<p>Current, available, restricted, minimum, and projected balances by account.</p>
						</div>
					</div>
					<div class="treasury-account-grid" data-section="accounts"></div>
				</section>

				<section class="treasury-two-col">
					<div class="treasury-panel" data-section="receivables"></div>
					<div class="treasury-panel" data-section="payables"></div>
				</section>

				<section class="treasury-two-col treasury-bottom-grid">
					<div class="treasury-panel" data-section="recommendations"></div>
					<div class="treasury-panel" data-section="manual"></div>
				</section>
			</div>
		`);
	}

	select_filter(name, label, options) {
		const selected = {
			company: this.filters.company,
			branch: this.filters.branch,
			businessUnit: this.filters.businessUnit,
			costCenter: this.filters.costCenter,
			project: this.filters.project,
			currency: this.currency,
			bankAccount: this.filters.bankAccount,
			horizon: `${this.horizon} days`,
			scenario: "Base Case",
		}[name];

		return `
			<label class="treasury-filter">
				<span>${label}</span>
				<select data-filter="${name}">
					${options.map((option) => `<option ${option === selected ? "selected" : ""}>${option}</option>`).join("")}
				</select>
			</label>
		`;
	}

	bind_events() {
		this.wrapper.on("change", "[data-filter]", (event) => {
			const name = event.currentTarget.dataset.filter;
			const value = event.currentTarget.value;
			if (name === "horizon") {
				this.horizon = this.horizon_to_days(value);
			} else if (name === "scenario") {
				this.scenario = value.toLowerCase().replace(" case", "").replace(/\s+/g, "-");
			} else if (name === "currency") {
				this.currency = value;
			} else {
				this.filters[name] = value;
			}
			this.refresh();
		});

		this.wrapper.on("click", "[data-action='add-manual-item']", () => this.add_manual_item());
		this.wrapper.on("click", "[data-action='reset-manual-items']", () => {
			this.manualItems = [...this.data.manualForecastItems];
			this.refresh();
		});
	}

	refresh() {
		const state = this.build_dashboard_state();
		this.render_kpis(state);
		this.render_chart(state);
		this.render_alert(state);
		this.render_cash_in(state);
		this.render_cash_out(state);
		this.render_accounts(state);
		this.render_receivables(state);
		this.render_payables(state);
		this.render_recommendations(state);
		this.render_manual_form();
	}

	build_dashboard_state() {
		const accounts = this.filtered_accounts();
		const openingCash = accounts.reduce((sum, account) => sum + this.available_cash(account), 0);
		const minimumReserve = accounts.reduce((sum, account) => sum + account.minimumRequiredBalance, 0);
		const events = this.build_events();
		const daily = this.build_forecast(openingCash, events);
		const day7 = this.day_projection(daily, 7);
		const day30 = this.day_projection(daily, 30);
		const lowest = daily.reduce((low, day) => (day.closingCash < low.closingCash ? day : low), daily[0]);
		const shortage = daily.find((day) => day.closingCash < 0);
		const reserveWarning = daily.find((day) => day.closingCash < minimumReserve);
		const outflows30 = events
			.filter((event) => event.type === "OUTFLOW" && this.days_from_today(event.expectedDate) <= 30)
			.reduce((sum, event) => sum + event.weightedAmount, 0);
		const inflows30 = events
			.filter((event) => event.type === "INFLOW" && this.days_from_today(event.expectedDate) <= 30)
			.reduce((sum, event) => sum + event.weightedAmount, 0);
		const monthlyOutflow = Math.max(outflows30, 1);

		return {
			accounts,
			events,
			daily,
			openingCash,
			minimumReserve,
			day7,
			day30,
			lowest,
			shortage,
			reserveWarning,
			inflows30,
			outflows30,
			runwayWithoutInflows: openingCash / monthlyOutflow,
			runwayWithInflows: (openingCash + inflows30) / monthlyOutflow,
			topDrivers: this.top_drivers(events, shortage || reserveWarning || lowest),
		};
	}

	filtered_accounts() {
		return this.data.cashAccounts.filter((account) => {
			const bankMatch = this.filters.bankAccount === "All Accounts" || account.name === this.filters.bankAccount;
			const branchMatch = this.filters.branch === "All Branches" || account.branch === this.filters.branch;
			const unitMatch = this.filters.businessUnit === "All Units" || account.businessUnit === this.filters.businessUnit;
			return bankMatch && branchMatch && unitMatch;
		});
	}

	build_events() {
		const scenario = this.scenario_rules();
		const inflows = this.data.inflows.map((item) => {
			const expectedDate = this.add_days(item.expectedDate, scenario.customerPaymentDelayDays);
			const amount = item.outstandingAmount * (1 + scenario.salesChangePercent / 100);
			const probability = this.clamp(item.probability + scenario.inflowProbabilityShift, 0.15, 1);
			return {
				...item,
				expectedDate,
				amount,
				weightedAmount: amount * probability,
				probability,
				confidence: this.confidence_label(probability),
			};
		});
		const outflows = this.data.outflows.map((item) => {
			const expectedDate = this.add_days(item.expectedDate, scenario.supplierPaymentDelayDays);
			const amount = item.outstandingAmount * (1 + scenario.expenseChangePercent / 100);
			return { ...item, expectedDate, amount, weightedAmount: amount };
		});
		const manual = this.manualItems.map((item) => {
			const signAdjusted = item.amount * (item.type === "INFLOW" ? 1 : 1);
			return { ...item, amount: signAdjusted, weightedAmount: signAdjusted * item.probability };
		});
		return [...inflows, ...outflows, ...manual].filter((event) => this.days_from_today(event.expectedDate) <= this.horizon);
	}

	build_forecast(openingCash, events) {
		let currentCash = openingCash;
		const daily = [];
		for (let index = 0; index < this.horizon; index += 1) {
			const date = this.add_days(new Date(), index);
			const dayEvents = events.filter((event) => this.same_day(event.expectedDate, date));
			const expectedInflows = dayEvents
				.filter((event) => event.type === "INFLOW")
				.reduce((sum, event) => sum + event.weightedAmount, 0);
			const expectedOutflows = dayEvents
				.filter((event) => event.type === "OUTFLOW")
				.reduce((sum, event) => sum + event.weightedAmount, 0);
			const closingCash = currentCash + expectedInflows - expectedOutflows;
			daily.push({
				date,
				openingCash: currentCash,
				expectedInflows,
				expectedOutflows,
				closingCash,
				criticalOutflows: this.sum_priority(dayEvents, "Critical"),
				highPriorityOutflows: this.sum_priority(dayEvents, "High"),
				normalOutflows: this.sum_priority(dayEvents, "Normal"),
				optionalOutflows: this.sum_priority(dayEvents, "Optional"),
			});
			currentCash = closingCash;
		}
		return daily;
	}

	render_kpis(state) {
		const cards = [
			["Total Available Cash", this.money(state.openingCash), "Current usable balance after restrictions and reserves."],
			["7-Day Forecast", this.money(state.day7.closingCash), "Projected closing cash after 7 days."],
			["30-Day Forecast", this.money(state.day30.closingCash), "Projected closing cash after 30 days."],
			["Lowest Forecast Cash", this.money(state.lowest.closingCash), `Lowest point on ${this.format_date(state.lowest.date)}.`],
			["Lowest Cash Date", this.format_date(state.lowest.date), "Date with the weakest forecast balance."],
			["Cash Runway", `${state.runwayWithoutInflows.toFixed(1)} mo`, `${state.runwayWithInflows.toFixed(1)} months with expected receivables.`],
		];
		this.$section("kpis").html(cards.map(([label, value, note]) => `
			<div class="treasury-kpi ${String(value).startsWith("-") ? "danger" : ""}">
				<span>${label}</span>
				<strong>${value}</strong>
				<small>${note}</small>
			</div>
		`).join(""));
	}

	render_chart(state) {
		const width = 920;
		const height = 280;
		const pad = 28;
		const values = state.daily.map((day) => day.closingCash).concat([state.minimumReserve, 0]);
		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = Math.max(max - min, 1);
		const x = (index) => pad + (index / Math.max(state.daily.length - 1, 1)) * (width - pad * 2);
		const y = (value) => height - pad - ((value - min) / range) * (height - pad * 2);
		const points = state.daily.map((day, index) => `${x(index)},${y(day.closingCash)}`).join(" ");
		const zeroY = y(0);
		const reserveY = y(state.minimumReserve);
		const ticks = [0, Math.floor(state.daily.length / 2), state.daily.length - 1];

		this.$section("chart").html(`
			<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily cash balance projection">
				<line x1="${pad}" x2="${width - pad}" y1="${zeroY}" y2="${zeroY}" class="treasury-axis zero"></line>
				<line x1="${pad}" x2="${width - pad}" y1="${reserveY}" y2="${reserveY}" class="treasury-axis reserve"></line>
				<polyline points="${points}" class="treasury-balance-line"></polyline>
				${state.daily.map((day, index) => `<circle cx="${x(index)}" cy="${y(day.closingCash)}" r="${index % 7 === 0 ? 3 : 1.8}" class="treasury-balance-dot"></circle>`).join("")}
				${ticks.map((index) => `
					<text x="${x(index)}" y="${height - 6}" text-anchor="middle" class="treasury-chart-label">${this.short_date(state.daily[index].date)}</text>
				`).join("")}
				<text x="${pad}" y="${Math.max(12, reserveY - 6)}" class="treasury-chart-label">Reserve ${this.money(state.minimumReserve)}</text>
				<text x="${width - pad}" y="${Math.max(12, y(max) - 6)}" text-anchor="end" class="treasury-chart-label">${this.money(max)}</text>
				<text x="${width - pad}" y="${Math.min(height - 10, y(min) + 14)}" text-anchor="end" class="treasury-chart-label">${this.money(min)}</text>
			</svg>
		`);
	}

	render_alert(state) {
		const target = state.shortage || state.reserveWarning;
		const severity = state.shortage ? "CRITICAL" : state.reserveWarning ? "WARNING" : "STABLE";
		const title = state.shortage ? "Cash balance may become negative" : state.reserveWarning ? "Minimum reserve breach expected" : "No shortage detected";
		const shortfall = state.shortage ? Math.abs(state.shortage.closingCash) : Math.max(0, state.minimumReserve - (target ? target.closingCash : state.lowest.closingCash));

		this.$section("alert").html(`
			<div class="treasury-alert ${severity.toLowerCase()}">
				<span>${severity}</span>
				<h3>${title}</h3>
				<p>${target ? `Expected on ${this.format_date(target.date)} with a shortfall of ${this.money(shortfall)}.` : "The selected horizon stays above the configured reserve threshold."}</p>
			</div>
			<div class="treasury-drivers">
				<h4>Why is cash moving?</h4>
				${state.topDrivers.map((driver) => `
					<div>
						<span>${this.escape_html(driver.label)}</span>
						<strong>${driver.type === "INFLOW" ? "+" : "-"}${this.money(driver.amount)}</strong>
					</div>
				`).join("")}
			</div>
		`);
	}

	render_cash_in(state) {
		const inflows = state.events.filter((event) => event.type === "INFLOW").sort(this.by_date);
		this.$section("cash-in").html(`
			${this.panel_title("Expected Cash In", this.money(inflows.reduce((sum, event) => sum + event.weightedAmount, 0)))}
			${this.table(["Date", "Source", "Customer / Description", "Amount", "Confidence"], inflows.slice(0, 6).map((event) => [
				this.short_date(event.expectedDate),
				event.sourceType,
				event.customer || event.description,
				this.money(event.weightedAmount),
				this.badge(event.confidence || this.confidence_label(event.probability)),
			]))}
		`);
	}

	render_cash_out(state) {
		const outflows = state.events.filter((event) => event.type === "OUTFLOW").sort(this.by_date);
		this.$section("cash-out").html(`
			${this.panel_title("Expected Cash Out", this.money(outflows.reduce((sum, event) => sum + event.weightedAmount, 0)))}
			${this.table(["Date", "Source", "Payee / Description", "Amount", "Priority"], outflows.slice(0, 6).map((event) => [
				this.short_date(event.expectedDate),
				event.sourceType,
				event.party || event.description,
				this.money(event.weightedAmount),
				this.badge(event.priority, event.priority.toLowerCase()),
			]))}
		`);
	}

	render_accounts(state) {
		const events = state.events;
		this.$section("accounts").html(state.accounts.map((account) => {
			const accountEvents = events.filter((event) => event.accountId === account.id);
			const available = this.available_cash(account);
			const projected = accountEvents.reduce((sum, event) => sum + (event.type === "INFLOW" ? event.weightedAmount : -event.weightedAmount), available);
			const nextInflow = accountEvents.filter((event) => event.type === "INFLOW").sort(this.by_date)[0];
			const nextOutflow = accountEvents.filter((event) => event.type === "OUTFLOW").sort(this.by_date)[0];
			return `
				<div class="treasury-account-card ${projected < account.minimumRequiredBalance ? "warning" : ""}">
					<div>
						<h4>${this.escape_html(account.name)}</h4>
						<span>${this.escape_html(account.accountType)} / ${this.escape_html(account.branch)}</span>
					</div>
					<div class="treasury-account-metrics">
						${this.metric("Current", this.money(account.currentBalance))}
						${this.metric("Available", this.money(available))}
						${this.metric("Restricted", this.money(account.restrictedAmount + account.reservedAmount))}
						${this.metric(`${this.horizon}-Day`, this.money(projected))}
					</div>
					<div class="treasury-next-lines">
						<span>Next inflow: ${nextInflow ? `${this.escape_html(nextInflow.customer || nextInflow.description)} ${this.money(nextInflow.weightedAmount)}` : "None"}</span>
						<span>Next outflow: ${nextOutflow ? `${this.escape_html(nextOutflow.description)} ${this.money(nextOutflow.weightedAmount)}` : "None"}</span>
					</div>
				</div>
			`;
		}).join(""));
	}

	render_receivables(state) {
		const inflows = state.events.filter((event) => event.type === "INFLOW");
		const buckets = {
			"Not Due": 0,
			"1-30 Days Overdue": 0,
			"31-60 Days": 0,
			"60+ Days": 0,
		};
		inflows.forEach((event) => {
			const overdue = -this.days_from_today(event.dueDate || event.expectedDate);
			if (overdue <= 0) buckets["Not Due"] += event.amount || event.weightedAmount;
			else if (overdue <= 30) buckets["1-30 Days Overdue"] += event.amount || event.weightedAmount;
			else if (overdue <= 60) buckets["31-60 Days"] += event.amount || event.weightedAmount;
			else buckets["60+ Days"] += event.amount || event.weightedAmount;
		});
		const topCustomers = inflows
			.filter((event) => event.customer)
			.sort((a, b) => b.weightedAmount - a.weightedAmount)
			.slice(0, 3);
		this.$section("receivables").html(`
			${this.panel_title("Receivables Intelligence", this.money(inflows.reduce((sum, event) => sum + (event.amount || 0), 0)))}
			<div class="treasury-bucket-grid">
				${Object.entries(buckets).map(([label, amount]) => this.metric(label, this.money(amount))).join("")}
			</div>
			${this.table(["Customer", "Amount", "Avg Delay", "Predicted Date", "Risk"], topCustomers.map((event) => [
				event.customer,
				this.money(event.amount),
				`${event.averageDelayDays} days`,
				this.short_date(event.expectedDate),
				this.badge(event.confidence),
			]))}
		`);
	}

	render_payables(state) {
		const outflows = state.events.filter((event) => event.type === "OUTFLOW");
		const sumWindow = (days) => outflows
			.filter((event) => this.days_from_today(event.expectedDate) <= days)
			.reduce((sum, event) => sum + event.weightedAmount, 0);
		const priority = ["Critical", "High", "Normal", "Optional"].map((name) => [
			name,
			outflows.filter((event) => event.priority === name).reduce((sum, event) => sum + event.weightedAmount, 0),
		]);
		this.$section("payables").html(`
			${this.panel_title("Payables Intelligence", this.money(outflows.reduce((sum, event) => sum + event.weightedAmount, 0)))}
			<div class="treasury-bucket-grid">
				${this.metric("Next 7 Days", this.money(sumWindow(7)))}
				${this.metric("Next 30 Days", this.money(sumWindow(30)))}
				${this.metric("Overdue", this.money(0))}
			</div>
			<div class="treasury-priority-list">
				${priority.map(([label, amount]) => `<div><span>${label}</span><strong>${this.money(amount)}</strong></div>`).join("")}
			</div>
		`);
	}

	render_recommendations(state) {
		const recommendations = [];
		const payrollAccount = state.accounts.find((account) => account.isPayrollAccount);
		if (payrollAccount) {
			const payrollOut = state.events
				.filter((event) => event.accountId === payrollAccount.id && event.type === "OUTFLOW")
				.reduce((sum, event) => sum + event.weightedAmount, 0);
			const available = this.available_cash(payrollAccount);
			const needed = payrollOut + payrollAccount.minimumRequiredBalance - available;
			if (needed > 0) {
				const source = state.accounts
					.filter((account) => account.id !== payrollAccount.id)
					.sort((a, b) => this.available_cash(b) - this.available_cash(a))[0];
				recommendations.push({
					action: `Transfer ${source ? source.name : "operating cash"} to ${payrollAccount.name}`,
					impact: needed,
					reason: "Payroll account falls below required balance.",
				});
			}
		}
		const collectible = state.events
			.filter((event) => event.type === "INFLOW" && event.confidence !== "Very Low")
			.sort((a, b) => b.weightedAmount - a.weightedAmount)[0];
		if (collectible) {
			recommendations.push({
				action: `Collect ${collectible.reference} from ${collectible.customer}`,
				impact: collectible.weightedAmount,
				reason: "Collection improves the near-term cash trough.",
			});
		}
		const optionalOutflow = state.events
			.filter((event) => event.type === "OUTFLOW" && event.priority === "Optional")
			.sort((a, b) => b.weightedAmount - a.weightedAmount)[0];
		if (optionalOutflow) {
			recommendations.push({
				action: `Delay ${optionalOutflow.description}`,
				impact: optionalOutflow.weightedAmount,
				reason: "Optional outflow can be moved without changing accounting actuals.",
			});
		}

		this.$section("recommendations").html(`
			${this.panel_title("Treasury Recommendations", `${recommendations.length} actions`)}
			<div class="treasury-recommendations">
				${recommendations.map((item) => `
					<div>
						<strong>${this.escape_html(item.action)}</strong>
						<span>${this.escape_html(item.reason)}</span>
						<b>+${this.money(item.impact)}</b>
					</div>
				`).join("")}
			</div>
		`);
	}

	render_manual_form() {
		this.$section("manual").html(`
			${this.panel_title("Manual Forecast Item", "Planning only")}
			<div class="treasury-manual-form">
				<select data-manual="type">
					<option>INFLOW</option>
					<option>OUTFLOW</option>
				</select>
				<input data-manual="description" placeholder="Description" value="Expected tax refund">
				<input data-manual="amount" type="number" min="0" step="1000" value="750000">
				<input data-manual="date" type="date" value="${this.iso_date(this.add_days(new Date(), 20))}">
				<select data-manual="probability">
					<option value="1">100% Confirmed</option>
					<option value="0.8" selected>80% High</option>
					<option value="0.6">60% Medium</option>
					<option value="0.4">40% Low</option>
				</select>
				<div class="treasury-manual-actions">
					<button class="btn btn-primary btn-sm" data-action="add-manual-item">Add Forecast Item</button>
					<button class="btn btn-default btn-sm" data-action="reset-manual-items">Reset</button>
				</div>
			</div>
			<p class="treasury-form-note">Manual forecast entries affect projection only and do not post to the General Ledger.</p>
		`);
	}

	add_manual_item() {
		const get = (field) => this.wrapper.find(`[data-manual="${field}"]`).val();
		const amount = Math.max(Number(get("amount")) || 0, 0);
		const description = String(get("description") || "").trim();
		if (!amount || !description) {
			frappe.show_alert({ message: "Add a description and amount first.", indicator: "orange" });
			return;
		}
		this.manualItems.push({
			id: `manual-${Date.now()}`,
			type: get("type"),
			sourceType: "MANUAL",
			description,
			expectedDate: this.start_of_day(new Date(get("date"))),
			amount,
			probability: Number(get("probability")) || 1,
			priority: get("type") === "OUTFLOW" ? "Normal" : "Normal",
			status: "DRAFT",
			accountId: "hbl-main",
		});
		frappe.show_alert({ message: "Forecast item added.", indicator: "green" });
		this.refresh();
	}

	panel_title(title, value) {
		return `
			<div class="treasury-panel-head">
				<div><h3>${title}</h3></div>
				<strong>${value}</strong>
			</div>
		`;
	}

	table(headers, rows) {
		return `
			<div class="treasury-table-wrap">
				<table class="treasury-table">
					<thead><tr>${headers.map((head) => `<th>${head}</th>`).join("")}</tr></thead>
					<tbody>
						${rows.map((row) => `<tr>${row.map((cell) => `<td>${this.safe_cell(cell)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${headers.length}">No records in this horizon.</td></tr>`}
					</tbody>
				</table>
			</div>
		`;
	}

	metric(label, value) {
		return `<div class="treasury-metric"><span>${label}</span><strong>${value}</strong></div>`;
	}

	badge(text, tone = "") {
		return `<span class="treasury-badge ${this.escape_html(tone)}">${this.escape_html(text)}</span>`;
	}

	safe_cell(cell) {
		const value = String(cell ?? "");
		if (value.startsWith('<span class="treasury-badge')) {
			return value;
		}
		return this.escape_html(value);
	}

	escape_html(value) {
		return String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	$section(name) {
		return this.wrapper.find(`[data-section="${name}"]`);
	}

	scenario_rules() {
		const rules = {
			base: { customerPaymentDelayDays: 0, supplierPaymentDelayDays: 0, salesChangePercent: 0, expenseChangePercent: 0, inflowProbabilityShift: 0 },
			best: { customerPaymentDelayDays: -7, supplierPaymentDelayDays: 7, salesChangePercent: 10, expenseChangePercent: -5, inflowProbabilityShift: 0.12 },
			worst: { customerPaymentDelayDays: 30, supplierPaymentDelayDays: 0, salesChangePercent: -20, expenseChangePercent: 10, inflowProbabilityShift: -0.18 },
			custom: { customerPaymentDelayDays: 12, supplierPaymentDelayDays: 3, salesChangePercent: -8, expenseChangePercent: 6, inflowProbabilityShift: -0.08 },
		};
		return rules[this.scenario] || rules.base;
	}

	day_projection(daily, days) {
		return daily[Math.min(days - 1, daily.length - 1)] || daily[daily.length - 1];
	}

	available_cash(account) {
		return account.currentBalance - account.restrictedAmount - account.minimumRequiredBalance - account.reservedAmount;
	}

	sum_priority(events, priority) {
		return events
			.filter((event) => event.type === "OUTFLOW" && event.priority === priority)
			.reduce((sum, event) => sum + event.weightedAmount, 0);
	}

	top_drivers(events, targetDay) {
		const targetDate = targetDay ? targetDay.date : new Date();
		return events
			.filter((event) => Math.abs(this.days_between(event.expectedDate, targetDate)) <= 7)
			.map((event) => ({
				label: event.description || event.customer || event.sourceType,
				amount: event.weightedAmount,
				type: event.type,
			}))
			.sort((a, b) => b.amount - a.amount)
			.slice(0, 4);
	}

	probability_from_delay(dueDate) {
		const days = this.days_from_today(dueDate);
		if (days >= 0) return 0.8;
		const overdue = Math.abs(days);
		if (overdue <= 15) return 0.6;
		if (overdue <= 30) return 0.4;
		return 0.2;
	}

	confidence_label(probability) {
		if (probability >= 0.9) return "Confirmed";
		if (probability >= 0.7) return "High";
		if (probability >= 0.5) return "Medium";
		if (probability >= 0.3) return "Low";
		return "Very Low";
	}

	horizon_to_days(value) {
		if (value === "6 months") return 183;
		if (value === "12 months") return 365;
		return Number.parseInt(value, 10) || 90;
	}

	money(value) {
		const sign = value < 0 ? "-" : "";
		const abs = Math.abs(value);
		if (abs >= 10000000) return `${sign}Rs ${(abs / 10000000).toFixed(1)}Cr`;
		if (abs >= 100000) return `${sign}Rs ${(abs / 100000).toFixed(1)}L`;
		if (abs >= 1000) return `${sign}Rs ${(abs / 1000).toFixed(0)}K`;
		return `${sign}Rs ${abs.toLocaleString()}`;
	}

	short_date(date) {
		return date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
	}

	format_date(date) {
		return date.toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" });
	}

	iso_date(date) {
		return date.toISOString().slice(0, 10);
	}

	add_days(date, days) {
		const next = new Date(date);
		next.setDate(next.getDate() + days);
		return this.start_of_day(next);
	}

	start_of_day(date) {
		const next = new Date(date);
		next.setHours(0, 0, 0, 0);
		return next;
	}

	days_from_today(date) {
		return this.days_between(new Date(), date);
	}

	days_between(start, end) {
		return Math.round((this.start_of_day(end) - this.start_of_day(start)) / 86400000);
	}

	same_day(left, right) {
		return this.start_of_day(left).getTime() === this.start_of_day(right).getTime();
	}

	by_date(left, right) {
		return left.expectedDate - right.expectedDate;
	}

	clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}
}

// Copyright (c) 2026, Unityalgo and contributors
// For license information, please see license.txt

frappe.ui.form.on("AI Settings", {
	reindex_documents(frm) {
		frappe.call({
			method: "unityalgo.llm_integration.ingest.trigger_reindex",
			freeze: true,
			freeze_message: __("Queuing reindex…"),
		}).then(() => {
			frappe.msgprint(__("Reindexing started in the background. Documents will be searchable shortly."));
		});
	},
});

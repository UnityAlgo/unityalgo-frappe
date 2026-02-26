frappe.pages['rbac-manager'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Permissions Manager',
		single_column: true
	});
}
import re
import frappe


def is_html(text: str) -> bool:
	pattern = re.compile(r"<[a-zA-Z][^>]*>|</[a-zA-Z]+>", re.IGNORECASE)
	return bool(pattern.search(text))


def get_navigations_data() -> list[dict]:
	nav_items = []
	workspaces = frappe.get_all("Workspace", filters={"public": 1}, fields=["name", "module", "title"])

	for ws in workspaces:
		links = frappe.get_all(
			"Workspace Link", filters={"parent": ws.name}, fields=["label", "link_type", "link_to"]
		)

		link_strings = []
		for link in links:
			if link.link_type == "DocType":
				link_strings.append(f" - Document: {link.label} ({link.link_to})")
			elif link.link_type == "Report":
				link_strings.append(f" - Report: {link.label} ({link.link_to})")
			elif link.link_type == "Page":
				link_strings.append(f" - Page: {link.label} ({link.link_to})")

		text = (
			f"Workspace: {ws.title or ws.name}\nModule: {ws.module}\nContains the following shortcuts:\n"
			+ "\n".join(link_strings)
		)
		nav_items.append({"id": f"workspace-{ws.name}", "type": "workspace", "text": text.strip()})

	doctypes_to_index = ["Customer", "Sales Invoice", "Purchase Invoice", "Item"]
	for doctype in doctypes_to_index:
		meta = frappe.get_meta(doctype)
		fields_with_help = []

		for df in meta.fields:
			if df.fieldtype in ["Section Break", "Column Break", "Tab Break"]:
				continue
			if df.description:
				fields_with_help.append(f" - Field '{df.label}' ({df.fieldtype}): {df.description}")

		if fields_with_help:
			text = f"Form: {doctype}\nField Help and Instructions:\n" + "\n".join(fields_with_help)
			nav_items.append({"id": f"help-{doctype}", "type": "form_help", "text": text.strip()})

	return nav_items


# def export_to_json():
# 	docs = generate_navigation_docs()
# 	with open("navigation_docs.json", "w") as f:
# 		json.dump(docs, f, indent=2)
# 	return docs

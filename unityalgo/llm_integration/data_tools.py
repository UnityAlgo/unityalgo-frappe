"""Text-to-query tools for the RAG assistant.

The LLM is given three tools to answer questions about *live* business data instead of
retrieving stale embedded snapshots:

- ``list_doctypes(keyword)``     -> discover which DocType a question is about
- ``get_doctype_fields(doctype)`` -> inspect fields so it can build a correct query
- ``query_frappe_data(...)``      -> run a permissioned, validated live query

Security model
--------------
Every query runs through ``frappe.get_list`` **as the current session user**, so Frappe's
role + user permissions are enforced automatically — we never use ``frappe.get_all`` or
``ignore_permissions``. On top of that, because the model supplies field/filter strings,
every one is validated against the DocType's real meta (regex allowlist for aggregates) to
prevent SQL injection, and a denylist blocks sensitive doctypes / password fields.
"""

import re

import frappe

MAX_ROWS = 100

DENYLIST = {
	"User",
	"OAuth Client",
	"OAuth Bearer Token",
	"OAuth Authorization Code",
	"OAuth Provider Settings",
	"Social Login Key",
	"Token Cache",
	"Access Token",
	"Personal Data Deletion Request",
	"Personal Data Download Request",
	"Error Log",
	"Error Snapshot",
	"Activity Log",
	"Scheduled Job Log",
	"Email Queue",
	"Notification Settings",
	"Webhook",
	"LDAP Settings",
	"System Settings",
}

# Fieldnames that are always safe to select even though they are "standard" fields.
STANDARD_FIELDS = {"name", "owner", "creation", "modified", "modified_by", "docstatus", "idx"}

# Fieldtypes that never carry queryable/selectable business data.
LAYOUT_FIELDTYPES = {"Section Break", "Column Break", "Tab Break", "HTML", "Heading", "Button"}

FILTER_OPERATORS = {
	"=", "!=", "<", ">", "<=", ">=", "like", "not like",
	"in", "not in", "between", "is", "descendants of", "ancestors of",
}

# sum(grand_total) as total  /  count(name)  /  avg(rate)
AGGREGATE_RE = re.compile(r"^(count|sum|avg|min|max)\(\s*([a-z0-9_]+)\s*\)(?:\s+as\s+[a-z0-9_]+)?$", re.I)
# count(*)  ->  normalized to count(name) as count (models frequently emit this)
COUNT_STAR_RE = re.compile(r"^count\(\s*\*\s*\)(?:\s+as\s+([a-z0-9_]+))?$", re.I)
ORDER_BY_RE = re.compile(r"^([a-z0-9_]+)(?:\s+(asc|desc))?$", re.I)


# --------------------------------------------------------------------------- tool defs

TOOL_DEFS = [
	{
		"name": "list_doctypes",
		"description": (
			"Find Frappe DocTypes (record types) whose name or module matches a keyword. "
			"Use this first to map the user's words (e.g. 'invoices', 'staff') to a real "
			"DocType name (e.g. 'Sales Invoice', 'Employee') before querying."
		),
		"input_schema": {
			"type": "object",
			"properties": {
				"keyword": {"type": "string", "description": "Word to search for, e.g. 'invoice'."}
			},
			"required": ["keyword"],
		},
	},
	{
		"name": "get_doctype_fields",
		"description": (
			"List the fields of a DocType (fieldname, label, type, linked doctype). Use this "
			"before query_frappe_data so you filter and select real field names."
		),
		"input_schema": {
			"type": "object",
			"properties": {
				"doctype": {"type": "string", "description": "Exact DocType name, e.g. 'Sales Invoice'."}
			},
			"required": ["doctype"],
		},
	},
	{
		"name": "query_frappe_data",
		"description": (
			"Query live records from a Frappe DocType the user is permitted to see. Use for "
			"counts, totals, lists, and specific records (invoices, GL entries, employees, "
			"projects, etc.). Results are already filtered to what the user may access. Do NOT "
			"use for UI navigation help."
		),
		"input_schema": {
			"type": "object",
			"properties": {
				"doctype": {"type": "string", "description": "Exact DocType name."},
				"filters": {
					"type": "object",
					"description": "Frappe filters, e.g. {\"status\": \"Overdue\"} or "
					"{\"posting_date\": [\">=\", \"2026-01-01\"]}.",
				},
				"fields": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Field names or aggregates like 'sum(grand_total) as total', "
					"'count(name) as cnt'. Defaults to ['name'].",
				},
				"group_by": {"type": "string", "description": "Field to group by (for aggregates)."},
				"order_by": {"type": "string", "description": "e.g. 'creation desc'."},
				"limit": {"type": "integer", "description": f"Max rows (<= {MAX_ROWS})."},
			},
			"required": ["doctype"],
		},
	},
]


# --------------------------------------------------------------------------- executors


def list_doctypes(keyword: str = "", **_):
	keyword = (keyword or "").strip()
	if not keyword:
		return {"error": "Provide a keyword to search for."}
	rows = frappe.get_all(
		"DocType",
		or_filters=[
			["name", "like", f"%{keyword}%"],
			["module", "like", f"%{keyword}%"],
		],
		filters={"istable": 0, "issingle": 0},
		fields=["name", "module", "description"],
		limit_page_length=20,
	)
	rows = [r for r in rows if r.get("name") not in DENYLIST]
	return {"doctypes": rows}


def get_doctype_fields(doctype: str = "", **_):
	doctype = (doctype or "").strip()
	if not doctype or not frappe.db.exists("DocType", doctype):
		return {"error": f"Unknown DocType: {doctype}"}
	if doctype in DENYLIST:
		return {"error": f"'{doctype}' is not available to the assistant."}

	meta = frappe.get_meta(doctype)
	fields = [{"fieldname": "name", "label": "ID", "fieldtype": "Data"}]
	for df in meta.fields:
		if df.fieldtype in LAYOUT_FIELDTYPES or df.fieldtype == "Password":
			continue
		fields.append(
			{
				"fieldname": df.fieldname,
				"label": df.label,
				"fieldtype": df.fieldtype,
				"options": df.options,
			}
		)
	return {"doctype": doctype, "fields": fields}


def _real_fieldnames(doctype):
	meta = frappe.get_meta(doctype)
	allowed = set(STANDARD_FIELDS)
	password_fields = set()
	for df in meta.fields:
		if df.fieldtype == "Password":
			password_fields.add(df.fieldname)
			continue
		if df.fieldtype in LAYOUT_FIELDTYPES:
			continue
		allowed.add(df.fieldname)
	return allowed, password_fields


def _validate_fields(fields, allowed, password_fields):
	clean = []
	for f in fields:
		f = str(f).strip()
		if not f:
			continue
		star = COUNT_STAR_RE.match(f)
		if star:
			alias = star.group(1) or "count"
			clean.append(f"count(name) as {alias}")
			continue
		agg = AGGREGATE_RE.match(f)
		if agg:
			inner = agg.group(2).lower()
			if inner in allowed and inner not in password_fields:
				clean.append(f)
			continue
		if f in allowed and f not in password_fields:
			clean.append(f)
	return clean


def _validate_filters(filters, allowed):
	if not isinstance(filters, dict):
		return {}
	clean = {}
	for key, value in filters.items():
		if key not in allowed:
			continue
		if isinstance(value, (list, tuple)) and len(value) == 2:
			op = str(value[0]).lower()
			if op not in FILTER_OPERATORS:
				continue
			clean[key] = [op, value[1]]
		elif isinstance(value, (str, int, float, bool)) or value is None:
			clean[key] = value
		# anything more exotic is dropped
	return clean


def _validate_order_group(expr, allowed):
	if not expr:
		return None
	m = ORDER_BY_RE.match(str(expr).strip())
	if not m or m.group(1) not in allowed:
		return None
	return m.group(0)


def query_frappe_data(
	doctype: str = "",
	filters=None,
	fields=None,
	group_by=None,
	order_by=None,
	limit=MAX_ROWS,
	**_,
):
	doctype = (doctype or "").strip()
	if not doctype or not frappe.db.exists("DocType", doctype):
		return {"error": f"Unknown DocType: {doctype}"}
	if doctype in DENYLIST:
		return {"error": f"'{doctype}' is not available to the assistant."}

	allowed, password_fields = _real_fieldnames(doctype)

	clean_fields = _validate_fields(fields or ["name"], allowed, password_fields) or ["name"]
	clean_filters = _validate_filters(filters, allowed)
	clean_group_by = _validate_order_group(group_by, allowed)
	clean_order_by = _validate_order_group(order_by, allowed)

	try:
		limit = min(int(limit or MAX_ROWS), MAX_ROWS)
	except (TypeError, ValueError):
		limit = MAX_ROWS

	try:
		# Permission boundary: frappe.get_list runs as frappe.session.user and applies
		# role + user permissions. Never swap this for frappe.get_all / ignore_permissions.
		rows = frappe.get_list(
			doctype,
			filters=clean_filters,
			fields=clean_fields,
			group_by=clean_group_by,
			order_by=clean_order_by,
			limit_page_length=limit,
		)
		return {"doctype": doctype, "count": len(rows), "rows": rows}
	except frappe.PermissionError:
		return {"error": f"You do not have permission to read {doctype} data."}
	except Exception as e:
		frappe.log_error("query_frappe_data failed", frappe.get_traceback())
		return {"error": f"Query failed: {e}"}


TOOL_REGISTRY = {
	"list_doctypes": list_doctypes,
	"get_doctype_fields": get_doctype_fields,
	"query_frappe_data": query_frappe_data,
}


def execute_tool(name: str, args: dict) -> dict:
	fn = TOOL_REGISTRY.get(name)
	if not fn:
		return {"error": f"Unknown tool: {name}"}
	if not isinstance(args, dict):
		args = {}
	try:
		return fn(**args)
	except TypeError as e:
		return {"error": f"Invalid arguments for {name}: {e}"}
	except Exception as e:
		frappe.log_error(f"Tool {name} crashed", frappe.get_traceback())
		return {"error": f"Tool {name} failed: {e}"}

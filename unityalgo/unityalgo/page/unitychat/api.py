import frappe
from frappe import _
import google.generativeai as genai
from datetime import datetime


# Configure Gemini once
def get_gemini_model():
	api_key = frappe.conf.get("gemini_api_key")
	if not api_key:
		frappe.throw("Please add 'gemini_api_key' to your site_config.json")

	genai.configure(api_key=api_key)

	# "gemini-1.5-flash" is fast and free. You can also use "gemini-1.5-pro"
	return genai.GenerativeModel("gemini-1.5-flash")


@frappe.whitelist()
def send_message(message, chat_id=None):
	"""Send message to Gemini and get response"""
	try:
		user = frappe.session.user

		# Create or get existing chat
		if not chat_id:
			chat_id = create_new_chat(message)

		# 1. Save User Message to DB
		save_message(chat_id, "user", message)

		# 2. Get DB History & Format for Gemini
		# We fetch the last 20 messages to give the AI context
		db_history = get_chat_history(chat_id, limit=20)
		gemini_history = format_history_for_gemini(db_history)

		# 3. Call Gemini
		ai_response = call_gemini(message, gemini_history)

		# 4. Save AI Response to DB
		save_message(chat_id, "assistant", ai_response)

		return {
			"success": True,
			"response": ai_response,
			"chat_id": chat_id,
			"timestamp": datetime.now().strftime("%I:%M %p"),
		}

	except Exception as e:
		frappe.log_error(f"UnityChat Error: {str(e)}")
		return {"success": False, "error": str(e)}


def call_gemini(current_message, history):
	"""Start a chat session with history and send the new message"""
	try:
		model = get_gemini_model()

		# Start chat with previous history
		chat = model.start_chat(history=history)

		# Send the new message
		response = chat.send_message(current_message)

		return response.text

	except Exception as e:
		frappe.log_error(f"Gemini API Error: {str(e)}")
		return "I'm having trouble reaching Google's servers right now. Please try again."


def format_history_for_gemini(db_history):
	"""Convert Frappe DB messages to Gemini API format"""
	gemini_history = []

	# db_history comes in reverse chronological order (newest first) from get_chat_history
	# We need to reverse it back to chronological order (oldest first) for the API
	# Note: verify if get_chat_history returns reversed or not.
	# Based on previous code `return list(reversed(messages))`, it returns chronological.

	for msg in db_history:
		# Frappe uses "user"/"assistant", Gemini uses "user"/"model"
		role = "user" if msg["role"] == "user" else "model"

		gemini_history.append({"role": role, "parts": [msg["content"]]})

	return gemini_history


# --- Existing Helper Functions (Unchanged) ---


@frappe.whitelist()
def get_chat_list(search_term=None):
	try:
		user = frappe.session.user
		filters = {"owner": user}
		if search_term:
			filters["title"] = ["like", f"%{search_term}%"]

		chats = frappe.get_all(
			"UnityChat Session",
			filters=filters,
			fields=["name", "title", "modified", "creation"],
			order_by="modified desc",
			limit=50,
		)

		grouped_chats = {"today": [], "yesterday": [], "previous_7_days": [], "older": []}
		today = datetime.now().date()

		for chat in chats:
			chat_date = chat["modified"].date()
			days_diff = (today - chat_date).days

			if days_diff == 0:
				grouped_chats["today"].append(chat)
			elif days_diff == 1:
				grouped_chats["yesterday"].append(chat)
			elif days_diff <= 7:
				grouped_chats["previous_7_days"].append(chat)
			else:
				grouped_chats["older"].append(chat)

		return {"success": True, "chats": grouped_chats}
	except Exception as e:
		return {"success": False, "error": str(e)}


@frappe.whitelist()
def get_chat_messages(chat_id):
	try:
		messages = frappe.get_all(
			"UnityChat Message",
			filters={"chat_session": chat_id},
			fields=["role", "content", "creation"],
			order_by="creation asc",
		)
		return {"success": True, "messages": messages}
	except Exception as e:
		return {"success": False, "error": str(e)}


@frappe.whitelist()
def rename_chat(chat_id, new_title):
	try:
		if not new_title:
			return {"success": False}
		frappe.db.set_value("UnityChat Session", chat_id, "title", new_title)
		return {"success": True}
	except Exception as e:
		return {"success": False, "error": str(e)}


@frappe.whitelist()
def delete_chat(chat_id):
	try:
		frappe.db.delete("UnityChat Message", {"chat_session": chat_id})
		frappe.db.delete("UnityChat Session", chat_id)
		return {"success": True}
	except Exception as e:
		return {"success": False, "error": str(e)}


def create_new_chat(first_message):
	try:
		title = first_message[:50] + ("..." if len(first_message) > 50 else "")
		chat = frappe.get_doc({"doctype": "UnityChat Session", "title": title, "owner": frappe.session.user})
		chat.flags.ignore_permissions = True
		chat.insert()
		return chat.name
	except Exception as e:
		frappe.log_error(f"Create Chat Error: {str(e)}")
		raise


def save_message(chat_id, role, content):
	try:
		message = frappe.get_doc(
			{"doctype": "UnityChat Message", "chat_session": chat_id, "role": role, "content": content}
		)
		message.insert()
	except Exception as e:
		frappe.log_error(f"Save Message Error: {str(e)}")
		raise


def get_chat_history(chat_id, limit=20):
	"""Get chronological history for context"""
	try:
		messages = frappe.get_all(
			"UnityChat Message",
			filters={"chat_session": chat_id},
			fields=["role", "content"],
			order_by="creation desc",  # Get newest first
			limit=limit,
		)
		# Reverse to return Oldest -> Newest (Chronological)
		return list(reversed(messages))
	except Exception as e:
		return []

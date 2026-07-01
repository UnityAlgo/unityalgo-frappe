import json

import frappe

from .llm import LLM, RateLimitError


def make_text_block(text):
	return {"type": "text", "data": {"markdown": text}}


def serialize_blocks(blocks):
	return json.dumps({"version": 1, "blocks": blocks})


def parse_blocks(content):
	if not content:
		return []
	try:
		parsed = json.loads(content)
		return parsed.get("blocks", [])
	except (TypeError, ValueError):
		return [make_text_block(content)]


def build_history(conversation):
	messages = frappe.get_all(
		"Chat Message",
		filters={"conversation": conversation},
		fields=["role", "content"],
		order_by="creation asc",
	)
	contents = []
	for message in messages:
		blocks = parse_blocks(message.content)
		text_parts = [b["data"]["markdown"] for b in blocks if b.get("type") == "text"]
		if not text_parts:
			continue
		contents.append(
			{
				"role": "user" if message.role == "user" else "model",
				"parts": [{"text": "\n\n".join(text_parts)}],
			}
		)
	return contents


@frappe.whitelist()
def get_conversations():
	return frappe.get_all(
		"Chat Conversation",
		fields=["name", "title", "modified"],
		filters={"owner": frappe.session.user},
		order_by="modified desc",
	)


@frappe.whitelist()
def get_messages(conversation):
	return frappe.get_all(
		"Chat Message",
		filters={"conversation": conversation},
		fields=["name", "role", "content", "creation"],
		order_by="creation asc",
	)


@frappe.whitelist()
def create_conversation(title=None):
	doc = frappe.new_doc("Chat Conversation")
	doc.title = title or "New Chat"
	doc.user = frappe.session.user
	doc.insert()
	return {"name": doc.name, "title": doc.title}


@frappe.whitelist()
def rename_conversation(conversation, title):
	doc = frappe.get_doc("Chat Conversation", conversation)
	doc.title = title
	doc.save()
	return {"name": doc.name, "title": doc.title}


@frappe.whitelist()
def delete_conversation(conversation):
	frappe.delete_doc("Chat Conversation", conversation)
	return {"deleted": conversation}


@frappe.whitelist()
def send_message(conversation, content, message_id=None):
	user_message = frappe.new_doc("Chat Message")
	user_message.conversation = conversation
	user_message.role = "user"
	user_message.content = serialize_blocks([make_text_block(content)])
	user_message.insert()

	assistant_message = frappe.new_doc("Chat Message")
	assistant_message.conversation = conversation
	assistant_message.role = "assistant"
	assistant_message.content = serialize_blocks([make_text_block("")])
	assistant_message.is_streaming = 1
	assistant_message.insert()

	frappe.db.commit()

	frappe.enqueue(
		generate_response,
		queue="short",
		now=frappe.conf.developer_mode,
		conversation=conversation,
		assistant_message_name=assistant_message.name,
		client_message_id=message_id,
		user=frappe.session.user,
		user_message_text=content
	)

	return {
		"user_message_id": user_message.name,
		"assistant_message_id": assistant_message.name,
	}

def generate_response(conversation, assistant_message_name, client_message_id, user, user_message_text=""):
    frappe.set_user(user)
    stream_id = client_message_id or assistant_message_name
    full_text = ""

    try:
        llm = LLM()
        contents = build_history(conversation)
        
        # 1. Use the text passed directly from send_message (100% reliable)
        latest_user_query = user_message_text.strip() if user_message_text else ""
        
        # 2. Fallback to history ONLY if somehow it's still empty (e.g., manual trigger)
        if not latest_user_query and contents and contents[-1].get("role") == "user":
            latest_user_query = "".join(part.get("text", "") for part in contents[-1].get("parts", []))

        # 3. Pass to RAG
        stream_generator = llm.stream_response_with_rag(contents, user_query=latest_user_query)
        
        for piece in stream_generator:
            full_text += piece
            frappe.publish_realtime(
                "algo_chat:stream_chunk",
                {"message_id": stream_id, "chunk": piece},
                user=user,
            )

        save_final_content(assistant_message_name, full_text)
        frappe.publish_realtime(
            "algo_chat:stream_done",
            {"message_id": stream_id, "content": full_text},
            user=user,
        )

    except RateLimitError:
        frappe.log_error(title="LLM rate limit", message=frappe.get_traceback())
        error_text = "The AI service is rate limited right now. Please try again in a minute."
        save_final_content(assistant_message_name, full_text or error_text)
        frappe.publish_realtime(
            "algo_chat:stream_error",
            {"message_id": stream_id, "error": "rate_limited", "message": error_text},
            user=user,
        )

    except Exception:
        frappe.log_error(title="LLM stream failed", message=frappe.get_traceback())
        error_text = "Something went wrong generating a response."
        save_final_content(assistant_message_name, full_text or error_text)
        frappe.publish_realtime(
            "algo_chat:stream_error",
            {"message_id": stream_id, "error": "generation_failed", "message": error_text},
            user=user,
        )

def save_final_content(assistant_message_name, full_text):
	doc = frappe.get_doc("Chat Message", assistant_message_name)
	doc.content = serialize_blocks([make_text_block(full_text)])
	doc.is_streaming = 0
	doc.save(ignore_permissions=True)
	frappe.db.commit()

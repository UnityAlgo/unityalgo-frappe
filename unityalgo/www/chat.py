import json
import re
import time

import frappe
from frappe.rate_limiter import rate_limit

from .llm import LLM, RateLimitError

# Matches ```algo:table {json}``` / ```algo:chart {json}``` fenced directive blocks.
RICH_FENCE_RE = re.compile(r"```algo:(table|chart)\s*\n(.*?)```", re.DOTALL)


def make_text_block(text):
	return {"type": "text", "data": {"markdown": text}}


def make_rich_block(kind, data):
	return {"type": kind, "data": data}


def make_sources_block(sources):
	return {"type": "sources", "data": {"items": sources}}


def parse_rich_blocks(full_text):
	"""Split a completed response into an ordered list of text/table/chart blocks.

	Any ``algo:table`` / ``algo:chart`` fence with valid JSON becomes a typed block;
	the prose around it becomes text blocks. A malformed fence is left as text so the
	user still sees the raw content instead of losing it.
	"""
	blocks = []
	cursor = 0

	for match in RICH_FENCE_RE.finditer(full_text):
		preceding = full_text[cursor : match.start()].strip()
		if preceding:
			blocks.append(make_text_block(preceding))

		kind, payload = match.group(1), match.group(2).strip()
		try:
			data = json.loads(payload)
			blocks.append(make_rich_block(kind, data))
		except (TypeError, ValueError):
			# Keep the raw fence as text rather than dropping the content.
			blocks.append(make_text_block(match.group(0)))

		cursor = match.end()

	trailing = full_text[cursor:].strip()
	if trailing or not blocks:
		blocks.append(make_text_block(trailing))

	return blocks


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
@rate_limit(key="conversation", limit=20, seconds=60)
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
    started = time.monotonic()
    llm = None

    try:
        llm = LLM()
        contents = build_history(conversation)
        latest_user_query = user_message_text.strip() if user_message_text else ""
        if not latest_user_query and contents and contents[-1].get("role") == "user":
            latest_user_query = "".join(part.get("text", "") for part in contents[-1].get("parts", []))

        stream_generator = llm.stream_response_with_rag(contents, user_query=latest_user_query)

        for piece in stream_generator:
            full_text += piece
            frappe.publish_realtime(
                "algo_chat:stream_chunk",
                {"message_id": stream_id, "chunk": piece},
                user=user,
            )

        blocks = parse_rich_blocks(full_text)
        sources = getattr(llm, "last_sources", []) or []
        if sources:
            blocks.append(make_sources_block(sources))
        save_final_content(assistant_message_name, blocks)
        frappe.publish_realtime(
            "algo_chat:stream_done",
            {"message_id": stream_id, "content": full_text, "blocks": blocks},
            user=user,
        )
        log_ai_query(conversation, latest_user_query, llm, full_text, sources,
                     "success", None, started)

    except RateLimitError:
        frappe.log_error(title="LLM rate limit", message=frappe.get_traceback())
        error_text = "The AI service is rate limited right now. Please try again in a minute."
        save_final_content(assistant_message_name, full_text or error_text)
        frappe.publish_realtime(
            "algo_chat:stream_error",
            {"message_id": stream_id, "error": "rate_limited", "message": error_text},
            user=user,
        )
        log_ai_query(conversation, user_message_text, llm, full_text, [],
                     "rate_limited", "rate limited", started)

    except Exception:
        tb = frappe.get_traceback()
        frappe.log_error(title="LLM stream failed", message=tb)
        error_text = "Something went wrong generating a response."
        save_final_content(assistant_message_name, full_text or error_text)
        frappe.publish_realtime(
            "algo_chat:stream_error",
            {"message_id": stream_id, "error": "generation_failed", "message": error_text},
            user=user,
        )
        log_ai_query(conversation, user_message_text, llm, full_text, [],
                     "error", tb, started)


def log_ai_query(conversation, question, llm, response, sources, status, error, started):
    """Governance/observability: write one AI Query Log row per turn (best-effort)."""
    try:
        doc = frappe.new_doc("AI Query Log")
        doc.user = frappe.session.user
        doc.conversation = conversation
        doc.question = (question or "")[:2000]
        doc.provider = getattr(llm, "provider", None) if llm else None
        doc.model = llm.get_model() if llm else None
        doc.retrieved_sources = json.dumps(sources or [])
        doc.response_preview = (response or "")[:2000]
        doc.latency_ms = int((time.monotonic() - started) * 1000)
        doc.status = status
        doc.error = (error or "")[:2000] if error else None
        doc.insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        frappe.log_error("AI Query Log write failed", frappe.get_traceback())

def save_final_content(assistant_message_name, blocks_or_text):
	# Accept either a pre-parsed blocks list or a plain string (error fallbacks).
	blocks = blocks_or_text if isinstance(blocks_or_text, list) else [make_text_block(blocks_or_text)]
	doc = frappe.get_doc("Chat Message", assistant_message_name)
	doc.content = serialize_blocks(blocks)
	doc.is_streaming = 0
	doc.save(ignore_permissions=True)
	frappe.db.commit()

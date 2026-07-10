"""Offline evaluation harness for the RAG pipeline.

Runs a small set of QA probes through retrieval (and optionally the full pipeline) and
reports **retrieval hit-rate** plus optional **LLM-graded** answer correctness. Run with:

    bench --site <site> execute unityalgo.llm_integration.evaluation.run_eval

Pass a custom dataset file (JSON list of {question, expect:[...], ideal}) via ``dataset_path``.
"""

import json

import frappe

from unityalgo.www.llm import LLM

DEFAULT_DATASET = [
	{"question": "How do I create a Sales Invoice?", "expect": ["Sales Invoice", "Invoice"]},
	{"question": "Where do I find the Accounts Receivable report?", "expect": ["Account", "Receivable", "Report"]},
	{"question": "Which workspace has the Stock shortcuts?", "expect": ["Stock", "Workspace", "Warehouse"]},
]

GRADE_SYSTEM = (
	"You are grading an AI assistant answer. Reply with a single word: PASS if the answer is "
	"relevant and correct for the question, or FAIL otherwise."
)


def _contents(question):
	return [{"role": "user", "parts": [{"text": question}]}]


def _grade(llm, question, answer):
	prompt = f"Question: {question}\n\nAnswer: {answer}\n\nReply PASS or FAIL."
	try:
		verdict = llm.simple_complete(prompt, system=GRADE_SYSTEM, max_tokens=5)
		return "PASS" in (verdict or "").upper()
	except Exception:
		return None


def run_eval(dataset_path=None, grade=False):
	dataset = DEFAULT_DATASET
	if dataset_path:
		with open(dataset_path) as f:
			dataset = json.load(f)

	llm = LLM()
	hits = 0
	graded_pass = 0
	graded_total = 0
	results = []

	for item in dataset:
		q = item["question"]
		try:
			context, sources = llm._retrieve_context(q)
		except Exception as e:
			context, sources = "", []
			frappe.log_error(f"eval retrieval failed for {q}", str(e))

		expect = item.get("expect", [])
		hit = bool(context) and any(kw.lower() in context.lower() for kw in expect)
		hits += 1 if hit else 0

		row = {"question": q, "retrieval_hit": hit, "num_sources": len(sources)}

		if grade:
			answer = "".join(llm.stream_response_with_rag(_contents(q), q))
			verdict = _grade(llm, q, answer)
			row["answer_pass"] = verdict
			if verdict is not None:
				graded_total += 1
				graded_pass += 1 if verdict else 0

		results.append(row)

	summary = {
		"total": len(dataset),
		"retrieval_hit_rate": round(hits / len(dataset), 3) if dataset else 0,
	}
	if grade and graded_total:
		summary["answer_pass_rate"] = round(graded_pass / graded_total, 3)

	print("=== RAG Evaluation ===")
	print(json.dumps(summary, indent=2))
	for r in results:
		print(r)
	return {"summary": summary, "results": results}

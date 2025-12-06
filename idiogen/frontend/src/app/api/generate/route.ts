// frontend/app/api/generate/route.ts

const WORKFLOW_URL = "https://workflow.arjunkrishnan410.workers.dev";

// frontend/app/api/generate/route.ts
export async function POST(req: Request) {
	const { prompt } = await req.json();

	const createRes = await fetch(WORKFLOW_URL, {
		method: "POST",
		body: JSON.stringify({ prompt }),
		headers: { "Content-Type": "application/json" },
	});

	const { id } = await createRes.json();

	return Response.json({ workflowId: id });
}

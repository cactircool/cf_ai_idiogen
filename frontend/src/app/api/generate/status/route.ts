const WORKFLOW_URL = "https://workflow.arjunkrishnan410.workers.dev";

// frontend/app/api/generate/status/route.ts
export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const workflowId = searchParams.get("workflowId");

	const statusRes = await fetch(`${WORKFLOW_URL}?instanceId=${workflowId}`);
	return Response.json(await statusRes.json());
}

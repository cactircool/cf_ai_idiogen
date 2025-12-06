// <docs-tag name="full-workflow-example">
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

// User-defined params passed to your workflow
type Params = object;

export class IdioGenWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const generateInterpreter = async (): Promise<Record<string, string>> => {
			if (!('prompt' in event.payload)) throw new NonRetryableError('prompt must be in the workflow payload.');
			const prompt = event.payload.prompt;
			const answer = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
				prompt: `
					Generate Bison and Flex code as well as an interpreter using the parser from bison and flex written in c for a language defined as: ${prompt}
					You should output files ONLY in the following format (no extra text whatsoever):
					===FILE parser.y===
					<content>
					===END===
					===FILE flex.l===
					<content>
					===END===
					===FILE interpreter.c===
					<content>
					===END===
					===FILE README.md===
					<documentation>
					===END===
					===FILE example.txt===
					<example_code>
					===END===
					`,
			});
			function parseFiles(text: string) {
				const files: Record<string, string> = {};
				const regex = /===FILE ([^=]+)===([\s\S]*?)===END===/g;
				let match;
				while ((match = regex.exec(text)) !== null) {
					const name = match[1].trim();
					const content = match[2].trimStart();
					files[name] = content;
				}
				return files;
			}
			if (typeof answer === 'string') return parseFiles(answer);
			if ('response' in answer) return parseFiles(answer.response);
			throw new NonRetryableError('Invalid output.');
		};

		return await step.do(
			'generate interpreter',
			{
				retries: {
					limit: 10,
					delay: 10000,
				},
			},
			async () => {
				const files = await generateInterpreter();
				const form = new FormData();
				for (const [filename, content] of Object.entries(files)) {
					form.append(filename.split('.')[0], new Blob([content]), filename);
				}
				const response = await fetch('https://your-go-server/compile', {
					method: 'POST',
					body: form,
				});
				if (response.status / 100 !== 2) throw new Error('Invalid configuration.');

				// Convert the zip to base64 so it's serializable
				const zipArrayBuffer = await response.arrayBuffer();
				const base64Zip = btoa(String.fromCharCode(...new Uint8Array(zipArrayBuffer)));

				// Return serializable data
				return base64Zip;
			},
		);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		let url = new URL(req.url);
		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get the status of an existing instance
		let id = url.searchParams.get('instanceId');
		if (id) {
			let instance = await env.IDIOGEN_WORKFLOW.get(id);
			let status = await instance.status();
			return Response.json(status);
		}

		// Create a new workflow instance
		if (req.method === 'POST') {
			const body = await req.json();
			let instance = await env.IDIOGEN_WORKFLOW.create({
				params: body as any,
			});
			return Response.json({
				id: instance.id,
			});
		}

		return Response.json({ error: 'Invalid request' }, { status: 400 });
	},
};

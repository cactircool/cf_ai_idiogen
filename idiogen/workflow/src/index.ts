import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params = any;

interface GeneratedFiles {
	'parser.y': string;
	'flex.l': string;
	'interpreter.c': string;
	'README.md': string;
	'example.txt': string;
}

export class IdioGenWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		if (!('prompt' in event.payload)) {
			throw new NonRetryableError('prompt must be in the workflow payload.');
		}

		// Step 1: Generate parser, lexer, and interpreter code
		const files = await step.do(
			'generate-code',
			{
				retries: {
					limit: 7,
					delay: 5000,
				},
			},
			async () => {
				return await this.generateCode(event.payload.prompt);
			},
		);

		// Step 2: Validate generated files
		await step.do(
			'validate-files',
			{
				retries: {
					limit: 1,
					delay: 1000,
				},
			},
			async () => {
				this.validateFiles(files);
				return { validated: true };
			},
		);

		// Step 3: Compile and build (with regeneration on failure)
		const compiledZip = await step.do(
			'compile-interpreter',
			{
				retries: {
					limit: 5, // Try compiling up to 5 times
					delay: 10000,
				},
			},
			async () => {
				return await this.compileWithRetry(event.payload.prompt, files);
			},
		);

		// Step 4: Return final result
		return await step.do(
			'finalize-result',
			{
				retries: {
					limit: 1,
					delay: 1000,
				},
			},
			async () => compiledZip,
		);
	}

	private async generateCode(prompt: string): Promise<GeneratedFiles> {
		const answer = await this.env.AI.run('@cf/qwen/qwen2.5-coder-32b-instruct', {
			messages: [
				{
					role: 'system',
					content:
						'You are a code generator that outputs ONLY code in the exact format specified. Never include explanations, markdown formatting, or any text outside the specified format.',
				},
				{
					role: 'user',
					content: `CRITICAL INSTRUCTIONS - YOU MUST FOLLOW EXACTLY:

1. OUTPUT ONLY CODE IN THE SPECIFIED FORMAT
2. NO TEXT BEFORE THE FIRST ===FILE
3. NO TEXT AFTER THE LAST ===END===
4. REMEMBER TO ALSO INCLUDE THE README.md AS THE SECOND TO LAST FILE
5. REMEMBER example.txt AS THE LAST FILE

Generate Bison parser (parser.y), Flex lexer (flex.l), and C interpreter for: ${prompt}

YOUR RESPONSE MUST START IMMEDIATELY WITH:
===FILE parser.y===

FORMAT (MANDATORY):
===FILE parser.y===
%{
#include <stdio.h>
extern int yylex();
void yyerror(const char *s);
%}
%%
start: /* grammar rules here */
;
%%
void yyerror(const char *s) { fprintf(stderr, "%s\\n", s); }
===END===
===FILE flex.l===
%{
#include "y.tab.h"
%}
%%
[0-9]+ { return NUMBER; }
[ \\t\\n] { /* skip */ }
. { return yytext[0]; }
/* Insert other grammar rules and replace the template ones I provided */
%%
int yywrap() { return 1; }
===END===
===FILE interpreter.c===
#include <stdio.h>
#include "y.tab.h"
extern int yyparse();
int main() {
    yyparse();
    /* Code that interprets the generated parse tree */
    return 0;
}
===END===
===FILE README.md===
# ${prompt}
Language documentation here.
===END===
===FILE example.txt===
Example program here.
===END===

RESPOND WITH NOTHING BUT THE 5 FILES IN THIS EXACT FORMAT. START NOW WITH ===FILE parser.y===`,
				},
			],
		});

		const responseText = typeof answer === 'string' ? answer : 'response' in answer ? answer.response : '';
		if (!responseText) {
			throw new Error('AI returned empty response');
		}

		const files = this.parseFiles(responseText);

		// Debug: Log what files were actually parsed
		const parsedKeys = Object.keys(files);
		console.log('Parsed files:', parsedKeys);
		console.log(
			'File contents preview:',
			Object.entries(files).map(([k, v]) => `${k}: ${v.substring(0, 50)}...`),
		);

		// Ensure all required files exist
		const required = ['parser.y', 'flex.l', 'interpreter.c', 'README.md', 'example.txt'];
		const missing = required.filter((f) => !files[f]);

		if (missing.length > 0) {
			// More detailed error with what we actually got
			throw new Error(
				`Missing required files: ${missing.join(', ')}. Found files: ${parsedKeys.join(', ')}. Raw response: ${responseText}. `,
			);
		}

		return files as unknown as GeneratedFiles;
	}

	private parseFiles(text: string): Record<string, string> {
		const files: Record<string, string> = {};
		const lines = text.split('\n');

		let currentFile: string | null = null;
		let currentContent: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Check for file start
			const fileMatch = line.match(/===FILE\s+(.+?)===/);
			if (fileMatch) {
				// Save previous file if exists
				if (currentFile && currentContent.length > 0) {
					files[currentFile] = currentContent.join('\n').trim();
					console.log(`Saved ${currentFile}: ${files[currentFile].length} chars`);
				}
				// Start new file
				currentFile = fileMatch[1].trim();
				currentContent = [];
				continue;
			}

			// Check for file end
			if (line.includes('===END===')) {
				if (currentFile && currentContent.length > 0) {
					files[currentFile] = currentContent.join('\n').trim();
					console.log(`Saved ${currentFile}: ${files[currentFile].length} chars`);
				}
				currentFile = null;
				currentContent = [];
				continue;
			}

			// Add line to current file content
			if (currentFile !== null) {
				currentContent.push(line);
			}
		}

		// Save last file if no ===END=== was found (in case response was cut off)
		if (currentFile && currentContent.length > 0) {
			files[currentFile] = currentContent.join('\n').trim();
			console.log(`Saved final ${currentFile}: ${files[currentFile].length} chars`);
		}

		console.log('Total files parsed:', Object.keys(files).join(', '));
		return files;
	}

	private validateFiles(files: GeneratedFiles): void {
		// Validate parser.y
		if (!files['parser.y'].includes('%{') || !files['parser.y'].includes('%%')) {
			throw new Error('parser.y appears malformed (missing %{ or %%)');
		}

		// Validate flex.l
		if (!files['flex.l'].includes('%{') || !files['flex.l'].includes('%%')) {
			throw new Error('flex.l appears malformed (missing %{ or %%)');
		}

		// Validate interpreter.c has main function
		if (!files['interpreter.c'].includes('int main')) {
			throw new Error('interpreter.c missing main() function');
		}

		// Check minimum content lengths
		if (files['parser.y'].length < 100) throw new Error('parser.y too short');
		if (files['flex.l'].length < 100) throw new Error('flex.l too short');
		if (files['interpreter.c'].length < 100) throw new Error('interpreter.c too short');
	}

	private async compileWithRetry(prompt: string, initialFiles: GeneratedFiles): Promise<string> {
		let files = initialFiles;
		let lastError = '';

		// Try to compile, and if it fails, regenerate with error feedback
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const form = new FormData();
				form.append('parser', new Blob([files['parser.y']]), 'parser.y');
				form.append('lexer', new Blob([files['flex.l']]), 'flex.l');
				form.append('interpreter', new Blob([files['interpreter.c']]), 'interpreter.c');
				form.append('README', new Blob([files['README.md']]), 'README.md');
				form.append('example', new Blob([files['example.txt']]), 'example.txt');

				const response = await fetch('https://idiogen.cactircool.com/compile', {
					method: 'POST',
					body: form,
				});

				if (response.ok) {
					// Success! Convert to base64 and return
					const zipArrayBuffer = await response.arrayBuffer();
					return btoa(String.fromCharCode(...new Uint8Array(zipArrayBuffer)));
				}

				// Compilation failed, get error message
				const errorText = await response.text();
				lastError = errorText;

				// If this is not the last attempt, regenerate with error feedback
				if (attempt < 2) {
					console.log(`Compilation failed (attempt ${attempt + 1}), regenerating with error feedback...`);
					files = await this.regenerateWithFeedback(prompt, files, errorText);
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (attempt === 2) {
					throw new Error(`Compilation failed after 3 attempts. Last error: ${lastError}`);
				}
			}
		}

		throw new Error(`Compilation failed: ${lastError}`);
	}

	private async regenerateWithFeedback(
		originalPrompt: string,
		failedFiles: GeneratedFiles,
		errorMessage: string,
	): Promise<GeneratedFiles> {
		const answer = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
			prompt: `
The previous attempt to generate code for this language failed with this error:
${errorMessage}

Original language description: ${originalPrompt}

Previous parser.y:
${failedFiles['parser.y']}

Previous flex.l:
${failedFiles['flex.l']}

Previous interpreter.c:
${failedFiles['interpreter.c']}

Please fix the errors and regenerate ALL files. Output in the EXACT format:

===FILE parser.y===
<corrected content>
===END===
===FILE flex.l===
<corrected content>
===END===
===FILE interpreter.c===
<corrected content>
===END===
===FILE README.md===
<updated documentation>
===END===
===FILE example.txt===
<example code>
===END===
			`,
		});

		const responseText = typeof answer === 'string' ? answer : 'response' in answer ? answer.response : '';
		if (!responseText) {
			throw new Error('AI returned empty response during regeneration');
		}

		const files = this.parseFiles(responseText);

		const required = ['parser.y', 'flex.l', 'interpreter.c', 'README.md', 'example.txt'];
		const missing = required.filter((f) => !files[f]);
		if (missing.length > 0) {
			throw new Error(`Missing required files after regeneration: ${missing.join(', ')}`);
		}

		return files as unknown as GeneratedFiles;
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get workflow status
		const id = url.searchParams.get('instanceId');
		if (id) {
			const instance = await env.IDIOGEN_WORKFLOW.get(id);
			const status = await instance.status();
			return Response.json(status);
		}

		// Create new workflow
		if (req.method === 'POST') {
			const body = (await req.json()) as any;

			if (!body.prompt || typeof body.prompt !== 'string') {
				return Response.json({ error: 'Missing or invalid prompt' }, { status: 400 });
			}

			const instance = await env.IDIOGEN_WORKFLOW.create({
				params: body,
			});

			return Response.json({
				id: instance.id,
				message: 'Workflow started',
			});
		}

		return Response.json({ error: 'Invalid request' }, { status: 400 });
	},
};

"use client";

import React, { useState, useRef } from "react";
import {
	Download,
	Play,
	ArrowLeft,
	Sparkles,
	Code2,
	FileCode,
} from "lucide-react";

interface Language {
	description: string;
	example: string;
	readme: string;
}

interface Interpreter {
	source: string;
	loader: string;
	wasm: ArrayBuffer;
}

interface Instances {
	[key: number]: string;
}

export default function LanguageGenerator() {
	const [step, setStep] = useState(1);
	const [languageDescription, setLanguageDescription] = useState("");
	const [generatedLanguage, setGeneratedLanguage] = useState<
		Language | undefined
	>();
	const [userCode, setUserCode] = useState("");
	const [output, setOutput] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	const [interpreter, setInterpreter] = useState<Interpreter | undefined>();
	const wasmModuleRef = useRef<unknown>(null);

	const generateLanguage = async () => {
		setIsRunning(true);

		const res = await fetch("/api/generate", {
			method: "POST",
			body: JSON.stringify({ prompt: languageDescription }),
		});
		const { workflowId } = (await res.json()) as any;

		let attempts = 0;
		const maxAttempts = 1000;

		while (attempts < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 3000));

			const statusRes = await fetch(
				`/api/generate/status?workflowId=${workflowId}`,
			);
			const statusData = (await statusRes.json()) as any;
			console.log("Status data:", statusData);

			if (statusData.status === "complete") {
				const zipData = statusData.output;

				// Decode the base64 zip file
				const binaryString = atob(zipData);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}

				// Use JSZip from your imports
				const JSZip = (await import("jszip")).default;
				const zip = await JSZip.loadAsync(bytes);

				for (const filename in zip.files)
					console.log("zip file contains file:", filename);

				const readme =
					(await zip.file("README.md")?.async("string")) || "";
				const example =
					(await zip.file("example.txt")?.async("string")) || "";
				const interpreterJs =
					(await zip.file("interpreter.js")?.async("string")) || "";
				const interpreterWasm = await zip
					.file("interpreter.wasm")
					?.async("arraybuffer");
				const combinedC =
					(await zip.file("combined.c")?.async("string")) || "";

				if (!interpreterWasm) {
					throw new Error("interpreter.wasm not found in zip");
				}

				setInterpreter({
					source: combinedC,
					loader: interpreterJs,
					wasm: interpreterWasm,
				});

				setGeneratedLanguage({
					description: languageDescription,
					readme,
					example,
				});

				setUserCode(example);

				// Initialize WASM module
				await initializeWasmModule(interpreterJs, interpreterWasm);

				setIsRunning(false);
				setStep(2);
				return;
			}

			if (statusData.status === "errored") {
				throw new Error(
					`Error: ${JSON.stringify(statusData.error, null, 2)}\nRetrying...`,
				);
			}
			if (statusData.status === "terminated") {
				throw new Error("Error: terminated");
			}
			attempts++;
		}
	};

	// Initialize WASM module with the JS loader (Emscripten)
	const initializeWasmModule = async (
		loaderJs: string,
		wasmBytes: ArrayBuffer,
	) => {
		try {
			// Convert ArrayBuffer to base64 for inline WASM
			const base64Wasm = btoa(
				String.fromCharCode(...new Uint8Array(wasmBytes)),
			);

			// Emscripten expects createInterpreterModule to be defined
			// We'll evaluate the loader and call it
			const moduleCode = `
				${loaderJs}
				return createInterpreterModule;
			`;

			const createModule = new Function(moduleCode)();

			// Initialize the module with WASM binary
			const Module = await createModule({
				wasmBinary: wasmBytes,
				print: (text: string) => {
					console.log(text);
				},
				printErr: (text: string) => {
					console.error(text);
				},
			});

			wasmModuleRef.current = Module;
		} catch (err) {
			console.error("Failed to initialize WASM:", err);
			throw new Error(`Failed to initialize interpreter: ${err}`);
		}
	};

	// Run code using WASM interpreter (Emscripten with file input)
	const runCode = async () => {
		if (!interpreter || !wasmModuleRef.current) {
			setOutput("Error: Interpreter not loaded");
			return;
		}

		setIsRunning(true);
		setOutput("Running...");

		try {
			const Module: any = wasmModuleRef.current;

			// Capture stdout
			let capturedOutput = "";
			const originalLog = console.log;
			const originalError = console.error;

			console.log = (...args: unknown[]) => {
				capturedOutput += args.join(" ") + "\n";
			};
			console.error = (...args: unknown[]) => {
				capturedOutput += "Error: " + args.join(" ") + "\n";
			};

			try {
				// Write user code to virtual filesystem
				const filename = "input.txt"; // or whatever extension your language uses
				Module.FS.writeFile(filename, userCode);

				// Call main with the filename as argument
				// Emscripten's main expects argc, argv
				// We'll use ccall to call main with arguments
				const result = Module.ccall(
					"main", // C function name
					"number", // return type
					["number", "array"], // argument types
					[2, ["/program", filename]], // argc=2, argv=[program_name, filename]
				);

				// Read output if it's written to a file
				try {
					if (Module.FS.analyzePath("output.txt").exists) {
						const outputContent = Module.FS.readFile("output.txt", {
							encoding: "utf8",
						});
						capturedOutput += outputContent;
					}
				} catch (e) {
					// No output file, that's okay
				}

				if (!capturedOutput.trim()) {
					capturedOutput = `Program executed with exit code: ${result}`;
				}

				setOutput(capturedOutput);
			} finally {
				console.log = originalLog;
				console.error = originalError;

				// Clean up the input file
				try {
					Module.FS.unlink("input.txt");
				} catch (e) {
					// File might not exist
				}
			}
		} catch (err) {
			setOutput(
				`Error: ${err instanceof Error ? err.message : "Execution failed"}\n\n${(err as Error).stack || ""}`,
			);
		}

		setIsRunning(false);
	};

	// Download the C source code
	const downloadInterpreter = () => {
		if (!interpreter) {
			alert("Please generate a language before attempting to download");
			return;
		}

		const blob = new Blob([interpreter.source], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "interpreter-source.c";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	// Download all files as zip
	const downloadAllFiles = async () => {
		if (!interpreter || !generatedLanguage) {
			alert("Please generate a language first");
			return;
		}

		const JSZip = (await import("jszip")).default;
		const zip = new JSZip();
		zip.file("combined.c", interpreter.source);
		zip.file("interpreter.js", interpreter.loader);
		zip.file("interpreter.wasm", interpreter.wasm);
		zip.file("README.md", generatedLanguage.readme);
		zip.file("example.txt", generatedLanguage.example);

		const zipBlob = await zip.generateAsync({ type: "blob" });
		const url = URL.createObjectURL(zipBlob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "language-package.zip";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const resetGenerator = () => {
		setStep(1);
		setLanguageDescription("");
		setGeneratedLanguage(undefined);
		setUserCode("");
		setOutput("");
		setInterpreter(undefined);
		wasmModuleRef.current = null;
	};

	return (
		<div className="min-h-screen bg-gradient-to-br from-indigo-50 via-purple-50 to-pink-50">
			{/* Header */}
			<div className="bg-white border-b border-gray-200 shadow-sm">
				<div className="max-w-6xl mx-auto px-6 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<Code2 className="w-8 h-8 text-indigo-600" />
							<h1 className="text-2xl font-bold text-gray-900">
								Language Generator
							</h1>
						</div>
						{step === 2 && (
							<button
								onClick={resetGenerator}
								className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
							>
								<ArrowLeft className="w-4 h-4" />
								New Language
							</button>
						)}
					</div>
				</div>
			</div>

			{/* Main Content */}
			<div className="max-w-6xl mx-auto px-6 py-12">
				{step === 1 ? (
					/* Step 1: Language Description */
					<div className="max-w-3xl mx-auto">
						<div className="text-center mb-8">
							<div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 rounded-full mb-4">
								<Sparkles className="w-8 h-8 text-indigo-600" />
							</div>
							<h2 className="text-3xl font-bold text-gray-900 mb-2">
								Create Your Programming Language
							</h2>
							<p className="text-lg text-gray-600">
								Describe the language you want to create and
								we&apos;ll generate it for you
							</p>
						</div>

						<div className="bg-white rounded-2xl shadow-lg p-8">
							<label className="block text-sm font-semibold text-gray-700 mb-3">
								Language Description
							</label>
							<textarea
								value={languageDescription}
								onChange={(e) =>
									setLanguageDescription(e.target.value)
								}
								placeholder="Describe your programming language... (e.g., 'A simple scripting language with Python-like syntax but with strong typing and built-in async support')"
								className="w-full h-48 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:outline-none text-gray-900 placeholder-gray-400 resize-none"
							/>

							<div className="mt-6 flex justify-end">
								<button
									onClick={() => {
										while (true) {
											try {
												return generateLanguage();
											} catch (e) {
												console.log(
													e instanceof Error
														? e.message
														: "An error occured",
												);
											}
										}
									}}
									disabled={
										!languageDescription.trim() || isRunning
									}
									className="flex items-center gap-2 px-8 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all transform hover:scale-105 active:scale-95"
								>
									{isRunning ? (
										<>
											<div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
											Generating...
										</>
									) : (
										<>
											<Sparkles className="w-5 h-5" />
											Generate Language
										</>
									)}
								</button>
							</div>
						</div>

						<div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
							<div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
								<div className="text-indigo-600 font-semibold mb-2">
									Step 1
								</div>
								<div className="text-sm text-gray-600">
									Describe your language features and syntax
								</div>
							</div>
							<div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
								<div className="text-indigo-600 font-semibold mb-2">
									Step 2
								</div>
								<div className="text-sm text-gray-600">
									We generate your custom interpreter
								</div>
							</div>
							<div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
								<div className="text-indigo-600 font-semibold mb-2">
									Step 3
								</div>
								<div className="text-sm text-gray-600">
									Test and download your language
								</div>
							</div>
						</div>
					</div>
				) : (
					/* Step 2: Code Editor & Execution */
					<div>
						<div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
							<div className="flex items-center justify-between mb-4">
								<div>
									<h2 className="text-2xl font-bold text-gray-900">
										Your Generated Language
									</h2>
									<p className="text-sm text-gray-600 mt-1">
										{generatedLanguage?.description}
									</p>
								</div>
								<div className="flex gap-2">
									<button
										onClick={downloadInterpreter}
										className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white font-medium rounded-lg hover:bg-green-700 transition-colors"
									>
										<Download className="w-4 h-4" />
										Download Source
									</button>
									<button
										onClick={downloadAllFiles}
										className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
									>
										<Download className="w-4 h-4" />
										Download All
									</button>
								</div>
							</div>
						</div>

						<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
							{/* Code Editor */}
							<div className="bg-white rounded-2xl shadow-lg p-6">
								<div className="flex items-center justify-between mb-4">
									<div className="flex items-center gap-2">
										<FileCode className="w-5 h-5 text-indigo-600" />
										<h3 className="text-lg font-semibold text-gray-900">
											Code Editor
										</h3>
									</div>
									<button
										onClick={runCode}
										disabled={isRunning}
										className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-gray-400 transition-colors"
									>
										<Play className="w-4 h-4" />
										{isRunning ? "Running..." : "Run Code"}
									</button>
								</div>

								<textarea
									value={userCode}
									onChange={(e) =>
										setUserCode(e.target.value)
									}
									className="w-full h-96 px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:outline-none font-mono text-sm text-gray-900 resize-none"
									placeholder="Write your code here..."
								/>
							</div>

							{/* Output Panel */}
							<div className="bg-white rounded-2xl shadow-lg p-6">
								<h3 className="text-lg font-semibold text-gray-900 mb-4">
									Output
								</h3>
								<div className="w-full h-96 px-4 py-3 bg-gray-900 rounded-xl overflow-auto">
									<pre className="font-mono text-sm text-green-400 whitespace-pre-wrap">
										{output ||
											"// Output will appear here after running your code"}
									</pre>
								</div>
							</div>
						</div>

						{/* README */}
						{generatedLanguage?.readme && (
							<div className="mt-6 bg-white rounded-2xl shadow-lg p-6">
								<h3 className="text-lg font-semibold text-gray-900 mb-3">
									Language Documentation
								</h3>
								<div className="prose max-w-none">
									<pre className="bg-gray-50 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap">
										{generatedLanguage.readme}
									</pre>
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

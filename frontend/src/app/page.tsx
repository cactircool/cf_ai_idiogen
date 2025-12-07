"use client";

import React, { useState, useRef } from "react";
import {
    Download,
    Play,
    ArrowLeft,
    Sparkles,
    Code2,
    FileCode,
    Terminal,
    Zap,
    CheckCircle2,
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

export default function LanguageGenerator() {
    const [step, setStep] = useState(1);
    const [languageDescription, setLanguageDescription] = useState("");
    const [generatedLanguage, setGeneratedLanguage] = useState<
        Language | undefined
    >();
    const [userCode, setUserCode] = useState("");
    const [output, setOutput] = useState("");
    const [isRunning, setIsRunning] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [interpreter, setInterpreter] = useState<Interpreter | undefined>();
    const wasmModuleRef = useRef<any>(null);

    const generateLanguage = async () => {
        setIsGenerating(true);

        try {
            const res = await fetch("/api/generate", {
                method: "POST",
                body: JSON.stringify({ prompt: languageDescription }),
            });
            const { workflowId }: { workflowId: number } = await res.json();

            let attempts = 0;
            const maxAttempts = 1000;

            while (attempts < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 3000));

                const statusRes = await fetch(
                    `/api/generate/status?workflowId=${workflowId}`,
                );
                const statusData: any = await statusRes.json();

                if (statusData.status === "complete") {
                    const zipData = statusData.output;

                    const binaryString = atob(zipData);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    const JSZip = (await import("jszip")).default;
                    const zip = await JSZip.loadAsync(bytes);

                    const readme =
                        (await zip.file("README.md")?.async("string")) || "";
                    const example =
                        (await zip.file("example.txt")?.async("string")) || "";
                    const interpreterJs =
                        (await zip.file("interpreter.js")?.async("string")) ||
                        "";
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

                    await initializeWasmModule(interpreterJs, interpreterWasm);

                    setIsGenerating(false);
                    setStep(2);
                    return;
                }

                if (statusData.status === "errored") {
                    throw new Error(
                        `Error: ${JSON.stringify(statusData.error, null, 2)}`,
                    );
                }
                if (statusData.status === "terminated") {
                    throw new Error("Error: terminated");
                }
                attempts++;
            }
        } catch (err) {
            console.error("Generation error:", err);
            setIsGenerating(false);
            alert(
                `Failed to generate language: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
        }
    };

    const initializeWasmModule = async (
        loaderJs: string,
        wasmBytes: ArrayBuffer,
    ) => {
        try {
            const moduleCode = `
				${loaderJs}
				return createInterpreterModule;
			`;

            const createModule = new Function(moduleCode)();

            // We'll store output in a ref that can be accessed during execution
            const outputBuffer: string[] = [];
            const errorBuffer: string[] = [];

            const Module = await createModule({
                wasmBinary: wasmBytes,
                noInitialRun: true,
                stdin: () => null,
                print: (text: string) => {
                    console.log("[WASM OUTPUT]", text);
                    outputBuffer.push(text);
                },
                printErr: (text: string) => {
                    console.error("[WASM ERROR]", text);
                    errorBuffer.push(text);
                },
            });

            // Attach buffers to module for access during runCode
            Module._outputBuffer = outputBuffer;
            Module._errorBuffer = errorBuffer;

            wasmModuleRef.current = Module;
        } catch (err) {
            console.error("Failed to initialize WASM:", err);
            throw new Error(`Failed to initialize interpreter: ${err}`);
        }
    };

    const runCode = async () => {
        if (!interpreter || !wasmModuleRef.current) {
            setOutput("Error: Interpreter not loaded");
            return;
        }

        setIsRunning(true);
        setOutput("▶ Running...\n");

        try {
            const Module = wasmModuleRef.current;

            // Clear the output buffers
            if (Module._outputBuffer) {
                Module._outputBuffer.length = 0;
            }
            if (Module._errorBuffer) {
                Module._errorBuffer.length = 0;
            }

            // Set up stdin to read from userCode line by line
            const lines = userCode.split("\n");
            let lineIndex = 0;
            let charIndex = 0;

            Module.stdin = () => {
                // If we've gone through all lines, return EOF
                if (lineIndex >= lines.length) {
                    return null;
                }

                const currentLine = lines[lineIndex];

                // If we're at the end of the current line, return newline and move to next line
                if (charIndex >= currentLine.length) {
                    lineIndex++;
                    charIndex = 0;
                    return 10; // newline character
                }

                // Return the current character
                const byte = currentLine.charCodeAt(charIndex);
                charIndex++;
                return byte;
            };

            try {
                // Call main with NO arguments - just run the interpreter interactively
                let exitCode = 0;
                console.log("[EXEC] Starting interactive interpreter");

                try {
                    if (Module.callMain) {
                        // Call with empty args - the interpreter reads from stdin
                        Module.callMain([]);
                    } else {
                        // Call main with argc=1 (just program name, no file argument)
                        exitCode = Module.ccall(
                            "main",
                            "number",
                            ["number", "array"],
                            [1, ["program"]],
                        );
                    }
                } catch (e: any) {
                    if (e.name === "ExitStatus") {
                        exitCode = e.status;
                        console.log(
                            "[EXEC] Program exited with code:",
                            exitCode,
                        );
                    } else {
                        throw e;
                    }
                }

                // Wait for any pending output
                await new Promise((resolve) => setTimeout(resolve, 100));

                // Collect output from buffers
                let finalOutput = "";

                if (Module._outputBuffer && Module._outputBuffer.length > 0) {
                    finalOutput = Module._outputBuffer.join("\n");
                    console.log("[OUTPUT] Captured:", Module._outputBuffer);
                }

                if (Module._errorBuffer && Module._errorBuffer.length > 0) {
                    if (finalOutput) finalOutput += "\n";
                    finalOutput +=
                        "--- STDERR ---\n" + Module._errorBuffer.join("\n");
                    console.log("[ERROR] Captured:", Module._errorBuffer);
                }

                // If no output was captured, show debug info
                if (!finalOutput.trim()) {
                    finalOutput = `✓ Program completed (exit code: ${exitCode})\n\n`;
                    finalOutput += `⚠️ No output captured.\n\n`;
                    finalOutput += `Debug info:\n`;
                    finalOutput += `- Check browser console (F12) for [WASM OUTPUT] logs\n`;
                    finalOutput += `- Input lines: ${lines.length}\n`;
                    finalOutput += `- The interpreter may be buffering output\n`;
                }

                setOutput(finalOutput);
            } finally {
                // No cleanup needed since we didn't create files
            }
        } catch (err: any) {
            let errorMsg = `❌ Execution Error:\n`;

            if (err.name === "ExitStatus") {
                errorMsg += `Program exited with code: ${err.status}\n`;
            } else if (err.errno) {
                errorMsg += `Errno ${err.errno}: ${err.message || "File system error"}\n`;
            } else {
                errorMsg += `${err instanceof Error ? err.message : JSON.stringify(err, null, 2)}\n`;
            }

            if (err.stack) {
                errorMsg += `\nStack trace:\n${err.stack}`;
            }

            setOutput(errorMsg);
        }

        setIsRunning(false);
    };

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
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
            {/* Animated background elements */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"></div>
                <div
                    className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
                    style={{ animationDelay: "1s" }}
                ></div>
            </div>

            {/* Header */}
            <div className="relative bg-black/20 backdrop-blur-xl border-b border-white/10 shadow-2xl">
                <div className="max-w-7xl mx-auto px-6 py-6">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="relative">
                                <div className="absolute inset-0 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl blur-lg opacity-50"></div>
                                <div className="relative bg-gradient-to-r from-purple-600 to-blue-600 p-2 rounded-xl">
                                    <Zap className="w-8 h-8 text-white" />
                                </div>
                            </div>
                            <div>
                                <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
                                    Idioma Generator
                                </h1>
                                <p className="text-sm text-purple-300/70">
                                    AI-Powered Language Generator
                                </p>
                            </div>
                        </div>
                        {step === 2 && (
                            <button
                                onClick={resetGenerator}
                                className="group flex items-center gap-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl transition-all duration-300 hover:scale-105"
                            >
                                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                                New Language
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="relative max-w-7xl mx-auto px-6 py-12">
                {step === 1 ? (
                    /* Step 1: Language Description */
                    <div className="max-w-4xl mx-auto">
                        <div className="text-center mb-12">
                            <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl mb-6 animate-pulse shadow-2xl shadow-purple-500/50">
                                <Sparkles className="w-10 h-10 text-white" />
                            </div>
                            <h2 className="text-5xl font-bold text-white mb-4 tracking-tight">
                                Create Your Language
                            </h2>
                            <p className="text-xl text-purple-300/80 max-w-2xl mx-auto">
                                Describe your dream programming language and
                                watch as AI brings it to life
                            </p>
                        </div>

                        <div className="bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/10 hover:border-purple-500/30 transition-all duration-300">
                            <label className="block text-sm font-semibold text-purple-300 mb-4 uppercase tracking-wide">
                                Language Description
                            </label>
                            <textarea
                                value={languageDescription}
                                onChange={(e) =>
                                    setLanguageDescription(e.target.value)
                                }
                                placeholder="e.g., 'A functional language with pattern matching, immutable data structures, and built-in concurrency primitives inspired by Erlang but with modern syntax...'"
                                className="w-full h-56 px-6 py-4 bg-black/30 border-2 border-white/10 rounded-2xl focus:border-purple-500 focus:outline-none text-white placeholder-purple-300/30 resize-none transition-all duration-300"
                            />

                            <div className="mt-8 flex justify-end">
                                <button
                                    onClick={generateLanguage}
                                    disabled={
                                        !languageDescription.trim() ||
                                        isGenerating
                                    }
                                    className="group relative flex items-center gap-3 px-10 py-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-bold rounded-2xl hover:from-purple-500 hover:to-blue-500 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-2xl shadow-purple-500/50 disabled:shadow-none overflow-hidden"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000"></div>
                                    {isGenerating ? (
                                        <>
                                            <div className="w-6 h-6 border-3 border-white border-t-transparent rounded-full animate-spin" />
                                            <span>Forging Language...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="w-6 h-6 group-hover:rotate-12 transition-transform" />
                                            <span>Generate Language</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>

                        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
                            {[
                                {
                                    step: "1",
                                    title: "Describe",
                                    desc: "Define your language's features and syntax",
                                },
                                {
                                    step: "2",
                                    title: "Generate",
                                    desc: "AI creates a custom interpreter",
                                },
                                {
                                    step: "3",
                                    title: "Deploy",
                                    desc: "Test and download your language",
                                },
                            ].map((item, i) => (
                                <div
                                    key={i}
                                    className="group bg-white/5 backdrop-blur-xl rounded-2xl p-6 border border-white/10 hover:border-purple-500/50 transition-all duration-300 hover:scale-105"
                                >
                                    <div className="flex items-center gap-3 mb-3">
                                        <div className="w-8 h-8 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
                                            {item.step}
                                        </div>
                                        <div className="text-lg font-bold text-white">
                                            {item.title}
                                        </div>
                                    </div>
                                    <div className="text-sm text-purple-300/70">
                                        {item.desc}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    /* Step 2: Code Editor & Execution */
                    <div className="space-y-6">
                        {/* Language Info Card */}
                        <div className="bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/10">
                            <div className="flex items-center justify-between flex-wrap gap-4">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl flex items-center justify-center">
                                        <CheckCircle2 className="w-7 h-7 text-white" />
                                    </div>
                                    <div>
                                        <h2 className="text-2xl font-bold text-white">
                                            Language Ready!
                                        </h2>
                                        <p className="text-purple-300/70 mt-1">
                                            {generatedLanguage?.description}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <button
                                        onClick={downloadInterpreter}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-semibold rounded-xl transition-all duration-300 hover:scale-105 shadow-lg shadow-green-500/30"
                                    >
                                        <Download className="w-4 h-4" />
                                        Source
                                    </button>
                                    <button
                                        onClick={downloadAllFiles}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-semibold rounded-xl transition-all duration-300 hover:scale-105 shadow-lg shadow-blue-500/30"
                                    >
                                        <Download className="w-4 h-4" />
                                        All Files
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* Code Editor */}
                            <div className="bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl p-6 border border-white/10 hover:border-purple-500/30 transition-all duration-300">
                                <div className="flex items-center justify-between mb-6">
                                    <div className="flex items-center gap-3">
                                        <FileCode className="w-6 h-6 text-purple-400" />
                                        <h3 className="text-xl font-bold text-white">
                                            Code Editor
                                        </h3>
                                    </div>
                                    <button
                                        onClick={runCode}
                                        disabled={isRunning}
                                        className="group flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-semibold rounded-xl disabled:from-gray-600 disabled:to-gray-700 transition-all duration-300 hover:scale-105 disabled:scale-100 shadow-lg shadow-purple-500/30"
                                    >
                                        {isRunning ? (
                                            <>
                                                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                                Running...
                                            </>
                                        ) : (
                                            <>
                                                <Play className="w-4 h-4 group-hover:scale-110 transition-transform" />
                                                Run Code
                                            </>
                                        )}
                                    </button>
                                </div>

                                <textarea
                                    value={userCode}
                                    onChange={(e) =>
                                        setUserCode(e.target.value)
                                    }
                                    className="w-full h-[500px] px-4 py-4 bg-black/50 border-2 border-white/10 rounded-2xl focus:border-purple-500 focus:outline-none font-mono text-sm text-green-400 resize-none placeholder-purple-300/30 transition-all duration-300"
                                    placeholder="// Write your code here..."
                                />
                            </div>

                            {/* Output Panel */}
                            <div className="bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl p-6 border border-white/10 hover:border-blue-500/30 transition-all duration-300">
                                <div className="flex items-center gap-3 mb-6">
                                    <Terminal className="w-6 h-6 text-blue-400" />
                                    <h3 className="text-xl font-bold text-white">
                                        Output Console
                                    </h3>
                                </div>
                                <div className="w-full h-[500px] px-4 py-4 bg-black/50 rounded-2xl overflow-auto border-2 border-white/10">
                                    <pre className="font-mono text-sm text-green-400 whitespace-pre-wrap">
                                        {output ||
                                            "// Output will appear here after running your code\n// Press 'Run Code' to execute"}
                                    </pre>
                                </div>
                            </div>
                        </div>

                        {/* README */}
                        {generatedLanguage?.readme && (
                            <div className="bg-white/5 backdrop-blur-xl rounded-3xl shadow-2xl p-8 border border-white/10">
                                <div className="flex items-center gap-3 mb-6">
                                    <Code2 className="w-6 h-6 text-purple-400" />
                                    <h3 className="text-xl font-bold text-white">
                                        Language Documentation
                                    </h3>
                                </div>
                                <div className="bg-black/30 rounded-2xl p-6 border border-white/10 overflow-x-auto">
                                    <pre className="font-mono text-sm text-purple-300 whitespace-pre-wrap">
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

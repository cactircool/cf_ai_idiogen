# IdioGen

IdioGen is an experimental system that allows you to **design a programming language from a natural-language prompt**, test an auto-generated interpreter directly in the browser, and download a fully compilable C project containing the interpreter (generated from Flex, Bison, and C).

**Fair warning:** This is pretty largely dependent on how good the AI model that this process uses is, and I'm flat broke. If you want better results, change the `this.env.AI.run` part of the code in `workflow/src/index.ts` to use another (more expensive) AI model.

If you want to test the existing live deployment without the AI having a meltdown, try a basic language that prints hello world if any of the input characters is a 1, and does nothing otherwise. That has stellar results from my testing.

Visit the live deployment: **idiogen.cactircool.com**

If building, get an **ubuntu environment** first, and then run the top level setup.sh script in this repository

```
sudo ./setup.sh
```

---

## 🚀 What IdioGen Does

IdioGen takes a high‑level description of a programming language and yields:

- **A working interpreter** you can run and test in the browser.
- **Downloadable source code** (Flex lexer, Bison parser, interpreter.c, Makefile, documentation, and examples) bundled as a compilable `.zip` file.
- A complete language toolchain generated automatically through a pipeline of AI → builder → frontend.

You describe a language, and IdioGen returns everything needed to compile and run it locally. IdioGen also compiles down to Web Assembly to be run in the browser for testing or for extremely cross platform support (theoretically). The web assembly is also downloadable along with a loader javascript file.

---

## 🧩 System Overview

IdioGen consists of three coordinated components:

### 1. 🌐 Frontend (Next.js)

The frontend provides:

- A clean UI to enter a language prompt.
- A live in-browser interpreter environment.
- A download button for the generated C project.
- Status and error reporting for the generation pipeline.

It communicates with the Cloudflare Workflow (see below), which orchestrates the generation steps.

---

### 2. 🛠️ Builder Server (Go + Flex/Bison + Emscripten)

The builder server is responsible for **turning AI-generated source files into a real C interpreter.**

It performs the following:

- Accepts a POST request containing:
    - `lexer.l` (Flex)
    - `parser.y` (Bison)
    - `interpreter.c`
    - Additional metadata

- Runs Flex + Bison to generate `lex.yy.c`, `y.tab.c`, and `y.tab.h`.
- Compiles the project or prepares it for compilation.
- Produces:
    - A Javascript loader for the Web Assembly
    - Documentation describing how the language works
    - Example programs
    - A ready-to-compile folder full of c files that just all need to be compiled together
    - WebAssembly output (via Emscripten) used by the frontend interpreter

- Returns all files packaged as a `.zip` archive.

This server is deployed using systemd and exposes a simple HTTP interface.

---

### 3. ☁️ Cloudflare Workflow

The workflow acts as a **pipeline orchestrator**, performing the following steps:

1. Receives the user's language prompt from the frontend.
2. Generates Flex + Bison + C interpreter code using AI.
3. Sends these files to the builder server for compilation.
4. Waits for the resulting bundle + wasm interpreter.
5. Returns the full response (zip file) back to the frontend.

This workflow abstracts the multi-step language generation process into a single endpoint the frontend can call.

---

## 📦 Generated Output

When the system finishes generating a language, users can download a `.zip` file containing:

```
YourLanguage/
├── combined (zipped)
├───── interpreter.c
├───── lex.yy.c
├───── y.tab.h
├───── y.tab.c
├── example.txt
├── README.md
├── interpreter.wasm
└── interpreter.js
```

To compile an interpreter from the combined folder (using any C compiler like clang, gcc, cc, etc.):

```
clang interpreter.c y.tab.c lex.yy.c -o interpreter
```

---

## 🏗️ Architecture Summary

```
User → Frontend → Cloudflare Workflow → AI Model
                                    ↓
                               Builder Server
                                    ↓
                             Output zip + WASM
                                    ↓
                                Frontend UI
```

IdioGen stitches together AI, compiler tooling, and WebAssembly to let anyone prototype a programming language in minutes.

---

## 🧰 Tech Stack

### Frontend

- Next.js (App Router)
- React
- WASM interpreter runtime
- Tailwind UI

### Builder Server

- Go
- Flex
- Bison
- Emscripten
- systemd deployment

### Cloudflare

- Cloudflare Workflows (for orchestration)
- workers.dev routing
- KV storage (optional for debugging or caching)

---

## 📝 Development Notes

- The builder server must have Flex, Bison, gcc/clang, and Emscripten installed.
- All temporary files are generated in isolated directories.
- The Cloudflare Workflow handles retries and validation.
- The frontend loads the WASM module dynamically for each generated language.

---

## ❗ Known Limitations

- No sandboxing: generated interpreters must be trusted.
- The generated interpreter reads input from stdin, so you'll need to stream files into the program to get file by file interpretation
- Large or ambiguous prompts may produce invalid grammars.
- Build times can vary depending on server load.

---

## 🗺️ Roadmap

- Better error recovery from the workflow.
- Dynamically compiling the interpreter to download a binary instead of a compilable zip file.
- Save language prompts + shareable links.
- Extend beyond interpreters to bytecode VMs.
- Part by part development to allow certain parts to be custom coded beyond AI's capabilities.

---

## 📄 License

MIT License — free to use, modify, and explore.

IdioGen is a project that attempts to bring language design to everyone. Have fun creating languages!

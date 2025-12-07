package main

import (
	"archive/zip"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func compileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	// Parse multipart form (limit 32MB, can adjust)
	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		http.Error(w, "Error parsing multipart form: "+err.Error(), 400)
		return
	}

	// --- Create temporary working directory ---
	tmpDir, err := os.MkdirTemp("", "idiogen-*")
	if err != nil {
		http.Error(w, "Failed to create temp dir: "+err.Error(), 500)
		return
	}
	defer os.RemoveAll(tmpDir)

	// Retrieve uploaded files
	parserFile, parserHeader, err := r.FormFile("parser")
	if err != nil {
		http.Error(w, "Missing parser file: "+err.Error(), 400)
		return
	}
	defer parserFile.Close()

	lexerFile, lexerHeader, err := r.FormFile("lexer")
	if err != nil {
		http.Error(w, "Missing lexer file: "+err.Error(), 400)
		return
	}
	defer lexerFile.Close()

	interpFile, interpHeader, err := r.FormFile("interpreter")
	if err != nil {
		http.Error(w, "Missing interpreter file: "+err.Error(), 400)
		return
	}
	defer interpFile.Close()

	readmeFile, readmeHeader, err := r.FormFile("README")
	if err != nil {
		http.Error(w, "Missing readme file: "+err.Error(), 400)
		return
	}
	defer readmeFile.Close()

	exampleFile, exampleHeader, err := r.FormFile("example")
	if err != nil {
		http.Error(w, "Missing example file: "+err.Error(), 400)
		return
	}
	defer exampleFile.Close()

	// --- Save uploaded files to disk efficiently ---
	parserPath := filepath.Join(tmpDir, parserHeader.Filename)
	lexerPath := filepath.Join(tmpDir, lexerHeader.Filename)
	interpPath := filepath.Join(tmpDir, interpHeader.Filename)
	readmePath := filepath.Join(tmpDir, readmeHeader.Filename)
	examplePath := filepath.Join(tmpDir, exampleHeader.Filename)

	save := func(dst string, src io.Reader) error {
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, src)
		return err
	}

	if err := save(parserPath, parserFile); err != nil {
		http.Error(w, "Saving parser failed: "+err.Error(), 500)
		return
	}
	if err := save(lexerPath, lexerFile); err != nil {
		http.Error(w, "Saving lexer failed: "+err.Error(), 500)
		return
	}
	if err := save(interpPath, interpFile); err != nil {
		http.Error(w, "Saving interpreter failed: "+err.Error(), 500)
		return
	}
	if err := save(readmePath, readmeFile); err != nil {
		http.Error(w, "Saving readme failed: "+err.Error(), 500)
		return
	}
	if err := save(examplePath, exampleFile); err != nil {
		http.Error(w, "Saving example failed: "+err.Error(), 500)
		return
	}

	// Output paths
	parserC := filepath.Join(tmpDir, "y.tab.c")
	lexerC := filepath.Join(tmpDir, "lex.yy.c")
	jsOut := strings.TrimSuffix(interpPath, filepath.Ext(interpPath)) + ".js"
	wasmOut := strings.TrimSuffix(jsOut, ".js") + ".wasm"

	// --- Run bison ---
	if out, err := exec.Command("bison", "-d", "-o", parserC, parserPath).CombinedOutput(); err != nil {
		http.Error(w, "bison error:\n"+err.Error()+"\n"+string(out), 500)
		return
	}

	// --- Run flex ---
	if out, err := exec.Command("flex", "-o", lexerC, lexerPath).CombinedOutput(); err != nil {
		http.Error(w, "flex error:\n"+err.Error()+"\n"+string(out), 500)
		return
	}

	// --- Run Emscripten ---
	emcc := exec.Command(
		"emcc",
		lexerC, parserC, interpPath, "/usr/lib/x86_64-linux-gnu/libfl.a",
		"-O3",
		"-s", "WASM=1",
		"-s", "MODULARIZE=1",
		"-s", "EXPORT_NAME=createInterpreterModule",
		"-s", "EXPORTED_FUNCTIONS=['_main']",
		"-s", "EXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap']",
		"-o", jsOut,
	)

	if out, err := emcc.CombinedOutput(); err != nil {
		http.Error(w, "emcc error:\n"+err.Error()+"\n"+string(out), 500)
		return
	}

	addToZip := func(w *zip.Writer, path string) error {
	    f, err := os.Open(path)
	    if err != nil {
	        return err
	    }
	    defer f.Close()

	    wr, err := w.Create(filepath.Base(path))
	    if err != nil {
	        return err
	    }

	    _, err = io.Copy(wr, f)
	    return err
	}

	// --- Create combined.c (lexer + parser + interpreter concatenated) ---
	combinedZip := filepath.Join(tmpDir, "combined.zip")
	combinedOut, err := os.Create(combinedZip)
	if err != nil {
		http.Error(w, "failed to create combined.zip: "+err.Error(), 500)
		return
	}

	cZipWriter := zip.NewWriter(combinedOut)
	for _, f := range []string{lexerC, parserC, interpPath} {
	    if err := addToZip(cZipWriter, f); err != nil {
	        http.Error(w, "failed writing combined.zip: "+err.Error(), 500)
	        return
	    }
	}

	if err := cZipWriter.Close(); err != nil {
	    http.Error(w, "failed closing combined.zip writer: "+err.Error(), 500)
	    return
	}

	if err := combinedOut.Close(); err != nil {
	    http.Error(w, "failed closing combined.zip: "+err.Error(), 500)
	    return
	}

	// --- ZIP Output ---
	zipPath := filepath.Join(tmpDir, "output.zip")
	zf, err := os.Create(zipPath)
	if err != nil {
		http.Error(w, "failed creating zip: "+err.Error(), 500)
		return
	}
	defer zf.Close()

	zipWriter := zip.NewWriter(zf)
	for _, f := range []string{ combinedZip, jsOut, wasmOut, readmePath, examplePath } {
		if err := addToZip(zipWriter, f); err != nil {
		    http.Error(w, "failed writing output.zip: "+err.Error(), 500)
		    return
		}
	}

	if err := zipWriter.Close(); err != nil {
	    http.Error(w, "failed closing output.zip writer: "+err.Error(), 500)
	    return
	}

	// Send zip back
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=build-output.zip")

	http.ServeFile(w, r, zipPath)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/compile", compileHandler)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("Hello world!\n")) })
	mux.HandleFunc("/test-emcc", func(w http.ResponseWriter, r *http.Request) {
		file, err := os.CreateTemp("", "main*.c")
		if err != nil {
			http.Error(w, "C file creation error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer file.Close()

		js, err := os.CreateTemp("", "main*.js")
		if err != nil {
			http.Error(w, "JS file creation error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer js.Close()

		file.WriteString(`
		#include <stdio.h>
		int main(int argc, char **argv) {
			printf("Hello world!\n");
			return 0;
		}
		`)

		emcc := exec.Command(
			"/opt/emsdk/upstream/emscripten/emcc",
			file.Name(),
			"-O3",
			"-s", "WASM=1",
			"-s", "MODULARIZE=1",
			"-s", "EXPORT_NAME=createInterpreterModule",
			"-s", "EXPORTED_FUNCTIONS=['_main']",
			"-s", "EXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap']",
			"-o", js.Name(),
		)

		out, err := emcc.CombinedOutput()
		if err != nil {
			http.Error(w, "emcc running error: "+err.Error()+"\n"+string(out), http.StatusInternalServerError)
			return
		}
		w.Write(out)
	})

	server := &http.Server{
		Addr:         ":9657",
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	log.Println("HTTP server listening on https://localhost:9657")
	// log.Fatal(server.ListenAndServeTLS("cert.pem", "key.pem"))
	server.ListenAndServe()
}

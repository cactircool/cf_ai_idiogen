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
		if err != nil { return err }
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
	parserC := strings.TrimSuffix(parserPath, filepath.Ext(parserPath)) + ".c"
	lexerC  := strings.TrimSuffix(lexerPath,  filepath.Ext(lexerPath))  + ".c"
	jsOut   := strings.TrimSuffix(interpPath, filepath.Ext(interpPath)) + ".js"
	wasmOut := strings.TrimSuffix(jsOut, ".js") + ".wasm"

	// --- Run bison ---
	if out, err := exec.Command("bison", "-d", "-o", parserC, parserPath).CombinedOutput(); err != nil {
		http.Error(w, "bison error:\n"+string(out), 500)
		return
	}

	// --- Run flex ---
	if out, err := exec.Command("flex", "-o", lexerC, lexerPath).CombinedOutput(); err != nil {
		http.Error(w, "flex error:\n"+string(out), 500)
		return
	}

	// --- Run Emscripten ---
	emcc := exec.Command(
		"emcc",
		lexerC, parserC, interpPath,
		"-O3",
		"-s", "WASM=1",
		"-s", "MODULARIZE=1",
		"-s", "EXPORT_NAME=createInterpreterModule",
		"-s", "EXPORTED_FUNCTIONS=['_main']",
		"-s", "EXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap']",
		"-o", jsOut,
	)

	if out, err := emcc.CombinedOutput(); err != nil {
		http.Error(w, "emcc error:\n"+string(out), 500)
		return
	}

	// --- Create combined.c (lexer + parser + interpreter concatenated) ---
	combinedC := filepath.Join(tmpDir, "combined.c")
	combinedOut, err := os.Create(combinedC)
	if err != nil {
		http.Error(w, "failed to create combined.c: "+err.Error(), 500)
		return
	}
	defer combinedOut.Close()

	for _, f := range []string{lexerC, parserC, interpPath} {
		in, err := os.Open(f)
		if err != nil {
			http.Error(w, "failed opening "+f+": "+err.Error(), 500)
			return
		}
		io.Copy(combinedOut, in)
		in.Close()
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

	addToZip := func(path string) {
		f, err := os.Open(path)
		if err != nil { return }
		defer f.Close()

		wr, err := zipWriter.Create(filepath.Base(path))
		if err != nil { return }
		io.Copy(wr, f)
	}

	addToZip(combinedC)
	addToZip(jsOut)
	addToZip(wasmOut)
	addToZip(readmePath)
	addToZip(examplePath)

	zipWriter.Close()

	// Send zip back
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=build-output.zip")

	http.ServeFile(w, r, zipPath)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/compile", compileHandler)

	server := &http.Server{
		Addr:         ":8443",
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	log.Println("HTTPS server listening on https://localhost:8443")
	log.Fatal(server.ListenAndServeTLS("cert.pem", "key.pem"))
}

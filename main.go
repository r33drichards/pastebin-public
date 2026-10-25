package main

import (
	"bytes"
	"context"
	"embed"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"net/http"

	"github.com/PuerkitoBio/goquery"
	"github.com/didip/tollbooth"
	_ "github.com/joho/godotenv/autoload"
	openai "github.com/sashabaranov/go-openai"

	"go.uber.org/zap"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
	"github.com/microcosm-cc/bluemonday"

	"gopkg.in/yaml.v2"

	"github.com/pkg/errors"

	_ "github.com/joho/godotenv/autoload"
)

var (
	//go:embed templates/paste.html
	PASTE_TEMPLATE_TEXT string
	//go:embed templates/diff.html
	DIFF_TEMPLATE_TEXT string
	//go:embed templates/diff-share.html
	DIFF_SHARED_TEMPLATE_TEXT string
	//go:embed templates/snapshot.html
	SNAPSHOT_TEMPLATE_TEXT string
	//go:embed templates/snapshots.html
	SNAPSHOTS_TEMPLATE_TEXT string
	// embed readme
	//go:embed README.md
	README_TEXT string
	//go:embed static
	staticFiles     embed.FS
	PBIN_TABLE_NAME = os.Getenv("PBIN_TABLE_NAME")
	PBIN_URL        = os.Getenv("PBIN_URL")
	dataStore       DataStore
	collabHubs      *collabHub
)

type PasteTemplateContent struct {
	Text, Language, ID, Title string
}

type DiffTemplateContent struct {
	OldText, NewText string
}

func generateTitle(text, openapikey string) (string, error) {
	if openapikey == "" {
		return "", fmt.Errorf("OPENAPIKEY not set")
	}
	c := openai.NewClient(openapikey)
	ctx := context.Background()

	req := openai.ChatCompletionRequest{
		Model: openai.GPT3Dot5Turbo,
		Messages: []openai.ChatCompletionMessage{
			{
				Role: "system",
				Content: `You are a helpful assistant that generates concise, descriptive titles for code snippets or text.
Generate a short, descriptive title (max 10 words) that captures the main purpose or content of the text.
Only output the title, nothing else.`,
			},
			{
				Role:    "user",
				Content: text,
			},
		},
	}
	resp, err := c.CreateChatCompletion(ctx, req)
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("no completion generated")
	}
	return resp.Choices[0].Message.Content, nil
}

func handlePaste(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case "POST":
		if err := request.ParseForm(); err != nil {
			fmt.Fprintf(writer, "ParseForm() err: %v", err)
			return
		}
		text := request.FormValue("text")
		lang := request.FormValue("lang")

		title := ""
		var err error
		// try to generate title using OpenAI
		// but leave it blank if it fails
		openapikey := os.Getenv("OPENAPIKEY")
		title, err = generateTitle(text, openapikey)
		if err != nil {
			log.Printf("Failed to generate title: %v", err)
		}

		id, err := dataStore.AddPaste(text, lang, title)

		if err != nil {
			log.Printf("Failed to add paste: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		q := request.URL.Query()
		q.Del("text")
		q.Del("lang")
		q.Set("id", id)
		request.URL.RawQuery = q.Encode()
		http.Redirect(writer, request, request.URL.String(), http.StatusMovedPermanently)
	case "PUT":
		if err := request.ParseForm(); err != nil {
			fmt.Fprintf(writer, "ParseForm() err: %v", err)
			return
		}
		id := request.FormValue("id")
		text := request.FormValue("text")
		lang := request.FormValue("lang")
		title := request.FormValue("title")

		if id == "" {
			writer.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(writer, "Missing paste ID")
			return
		}

		// Push the change to anyone editing this paste live.
		collabHubs.replace(id, text, lang, title)

		err := dataStore.UpdatePaste(id, text, lang, title)
		if err != nil {
			log.Printf("Failed to update paste: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			fmt.Fprintf(writer, "Failed to update paste: %v", err)
			return
		}

		writer.WriteHeader(http.StatusOK)
		fmt.Fprintf(writer, "OK")
	case "GET":
		id := request.URL.Query().Get("id")
		if id == "" {
			http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
			return
		}

		// Check if .txt extension is requested
		isPlainText := strings.HasSuffix(id, ".txt")
		actualID := id
		if isPlainText {
			// Strip .txt extension to get actual paste ID
			actualID = strings.TrimSuffix(id, ".txt")
		}

		paste, err := dataStore.GetPaste(actualID)
		if err != nil {
			log.Printf("Failed to get paste: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}

		// If plain text is requested, return raw text
		if isPlainText {
			writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, err = writer.Write([]byte(paste.Text))
			if err != nil {
				log.Printf("Failed to write response: %v", err)
				writer.WriteHeader(http.StatusInternalServerError)
			}
			return
		}

		// Otherwise return HTML template
		ptc := PasteTemplateContent{
			Text:     paste.Text,
			Language: paste.Language,
			ID:       actualID,
			Title:    paste.Title,
		}
		t := template.Must(template.New("paste").Parse(PASTE_TEMPLATE_TEXT))
		err = t.ExecuteTemplate(writer, "paste", ptc)
		if err != nil {
			log.Printf("Failed to execute template: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}

	default:
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
	}
}

type fm struct {
	// title omitempty
	Title *string `yaml:"title,omitempty"`
}

// parseYamlFrontMatter
// check for
// ---
// title: "title"
// ---
// in markdown
//
// returns map[string]string, []byte, error
// map[string]string is the yaml front matter
// []byte is the markdown without the yaml front matter
// error is any error that occured
func parseYamlFrontMatter(md []byte) (*fm, []byte, error) {
	buf := bytes.NewBuffer(md)
	frontMatter := &fm{}
	var err error
	line, err := buf.ReadString('\n')
	if err != nil {
		switch err {
		case io.EOF:
			return nil, md, nil
		default:
			return nil, nil, errors.Wrap(
				err,
				fmt.Sprintf("error reading line: %s", line),
			)
		}
	}
	if !strings.HasPrefix(line, "---") {
		return nil, md, nil
	}

	lines := []string{}
	for {
		line, err := buf.ReadString('\n')
		if err != nil {
			return nil, nil,
				errors.Wrap(
					err,
					fmt.Sprintf("error reading line: %s", line),
				)
		}
		if strings.HasPrefix(line, "---") {
			break
		}
		lines = append(lines, line)
	}
	y := strings.Join(lines, "")
	err = yaml.Unmarshal([]byte(y), &frontMatter)
	if err != nil {
		return nil, nil, errors.Wrap(
			err,
			fmt.Sprintf("error unmarshalling yaml front matter: %s", y),
		)
	}

	mdWithoutFrontMatter := buf.Bytes()
	return frontMatter, mdWithoutFrontMatter, nil
}

func mdToHTML(md []byte) ([]byte, error) {
	// check for
	// ---
	// title: "title"
	// ---
	// in markdown
	fm, md, err := parseYamlFrontMatter(md)
	if err != nil {
		return nil, errors.WithStack(err)
	}

	// create markdown parser with GitHub Flavored Markdown extensions
	// CommonExtensions includes: Tables, FencedCode, Autolink, Strikethrough, and more
	extensions := parser.CommonExtensions |
		parser.AutoHeadingIDs |
		parser.NoEmptyLineBeforeBlock |
		parser.DefinitionLists | // GFM: definition lists
		parser.MathJax // GFM: math expressions
	p := parser.NewWithExtensions(extensions)
	doc := p.Parse(md)

	// create HTML renderer with GitHub Flavored Markdown flags
	htmlFlags := html.CommonFlags |
		html.HrefTargetBlank |
		html.CompletePage // Generate complete HTML page
	opts := html.RendererOptions{
		Flags: htmlFlags,
		CSS:   "", // We'll add CSS separately
	}
	renderer := html.NewRenderer(opts)

	maybeUnsafeHTML := markdown.Render(doc, renderer)

	// Create a custom sanitization policy that allows GFM elements
	policy := bluemonday.UGCPolicy()
	// Allow input elements for task lists
	policy.AllowAttrs("type", "disabled", "checked").OnElements("input")
	// Allow del element for strikethrough
	policy.AllowElements("del")
	// Allow more table attributes for better formatting
	policy.AllowAttrs("align").OnElements("th", "td")

	html := policy.SanitizeBytes(maybeUnsafeHTML)

	
	d, err := goquery.NewDocumentFromReader(bytes.NewReader(html))
	if err != nil {
		return nil, errors.WithStack(err)
	}

	// Modern Aero styles, matching the app (palette 1050335): deep night
	// with aurora washes, daylight in light mode. Self-contained, no CDNs.
	d.Find("head").AppendHtml(`
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<style>
			:root {
				--bg: #EAF2FA; --fg: #0F2238; --muted: #4E647C;
				--edge: rgba(0, 50, 219, 0.18); --sky: #0053C9; --leaf: #4E7F12;
				color-scheme: light dark;
			}
			@media (prefers-color-scheme: dark) {
				:root {
					--bg: #090D18; --fg: #E4EEF8; --muted: #7C90A8;
					--edge: rgba(6, 137, 228, 0.3); --sky: #4DA6EE; --leaf: #9BCE5A;
				}
			}
			* { box-sizing: border-box; }
			::selection { background: #0689e4; color: #fff; }
			body {
				margin: 0 auto; padding: 48px 16px; max-width: 72ch;
				color: var(--fg);
				background:
					radial-gradient(60% 40% at 85% 0%, rgba(0, 50, 219, 0.12), transparent 70%),
					radial-gradient(50% 35% at 0% 100%, rgba(113, 171, 35, 0.09), transparent 70%),
					var(--bg);
				background-attachment: fixed;
				font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
				font-size: 1rem; line-height: 1.65;
				overflow-wrap: break-word;
			}
			h1, h2, h3, h4, h5, h6 { margin: 1.3em 0 0.5em; line-height: 1.25; font-weight: 600; }
			h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.1em; }
			h1, h2 { border-bottom: 1px solid var(--edge); padding-bottom: 0.3em; }
			a { color: var(--sky); }
			hr { border: 0; border-top: 1px solid var(--edge); margin: 28px 0; }
			blockquote { margin: 0 0 1em; padding: 0 1em; border-left: 2px solid var(--sky); color: var(--muted); }
			img { max-width: 100%; border-radius: 6px; }
			code {
				font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
				font-size: 0.875em;
				background: rgba(6, 137, 228, 0.10); border-radius: 4px; padding: 0.15em 0.4em;
			}
			pre {
				background: rgba(0, 0, 0, 0.06); border: 1px solid var(--edge);
				border-radius: 6px; padding: 16px; overflow: auto;
				line-height: 1.6; tab-size: 4;
			}
			@media (prefers-color-scheme: dark) { pre { background: rgba(0, 0, 0, 0.3); } }
			pre code { background: transparent; padding: 0; font-size: 0.8125rem; }
			table { border-collapse: collapse; width: 100%; margin: 1em 0; display: block; overflow-x: auto; }
			th, td { border: 1px solid var(--edge); padding: 5px 12px; text-align: left; }
			th { color: var(--sky); font-size: 0.8em; letter-spacing: 0.05em; }
			input[type="checkbox"] { accent-color: #0689e4; }
			input[type="checkbox"][disabled] { cursor: not-allowed; }
			del { text-decoration: line-through; }
		</style>
	`)

	// Keep the markdown-body class for anything that targets rendered markdown
	d.Find("body").AddClass("markdown-body")

	h, err := d.Html()
	if err != nil {
		return nil, err
	}

	// add title if it exists
	if fm != nil && fm.Title != nil {
		d.Find("head").AppendHtml(fmt.Sprintf(`<title>%s</title>`, *fm.Title))
		h, err = d.Html()
		if err != nil {
			return nil, errors.WithStack(err)
		}
	}

	return []byte(h), nil

}

func getPaste(id string) (*Paste, error) {
	paste, err := dataStore.GetPaste(id)
	if err != nil {
		return nil, err
	}
	return paste, nil
}

func handleHtml(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case "GET":
		id := request.URL.Query().Get("id")
		if id == "" {
			// redirect to index
			http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
			return
		}
		paste, err := getPaste(id)
		if err != nil {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}

		text := paste.Text
		textBuffer := []byte(text)
		html, err := mdToHTML(textBuffer)
		if err != nil {
			log.Printf("error converting markdown to html, stacktrace: %+v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, err = writer.Write(html)
		if err != nil {
			log.Println(err)
		}
	default:
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
	}
}

// handleIndex opens a fresh room: it creates an empty paste and redirects to
// it, where editing is live and saved automatically.
func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.Error(w, "404 not found.", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodGet {
		// HEAD requests, link previews etc. must not create rooms.
		return
	}
	lang := r.URL.Query().Get("lang")
	if len(lang) > collabMaxLanguageLen {
		lang = ""
	}
	id, err := dataStore.AddPaste("", lang, "")
	if err != nil {
		log.Printf("Failed to create room: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/paste?id="+id, http.StatusSeeOther)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	_, err := w.Write([]byte("OK"))
	if err != nil {
		log.Println(err)
	}
}

func handleDiff(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case "POST":
		if err := request.ParseForm(); err != nil {
			fmt.Fprintf(writer, "ParseForm() err: %v", err)
			return
		}
		original := request.FormValue("original")
		modified := request.FormValue("modified")
		id, err := dataStore.AddDiff(original, modified)

		if err != nil {
			log.Printf("Failed to add diff: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		q := request.URL.Query()
		q.Del("original")
		q.Del("modified")
		q.Set("id", id)
		request.URL.RawQuery = q.Encode()
		http.Redirect(writer, request, request.URL.String(), http.StatusMovedPermanently)
	case "GET":
		id := request.URL.Query().Get("id")
		if id == "" {
			_, err := writer.Write([]byte(DIFF_TEMPLATE_TEXT))
			if err != nil {
				log.Println(err)
			}
			return
		}
		diff, err := dataStore.GetDiff(id)

		if err != nil {
			log.Printf("Failed to get diff: %v", err)
			writer.WriteHeader(http.StatusNotFound)
			return
		}

		dtc := DiffTemplateContent{
			OldText: diff.OldText,
			NewText: diff.NewText,
		}

		t := template.Must(template.New("diff-share").Parse(DIFF_SHARED_TEMPLATE_TEXT))
		err = t.ExecuteTemplate(writer, "diff-share", dtc)
		if err != nil {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}

	default:
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
	}
}

// rateLimit is the allowed requests per second, per client and per route.
// PBIN_RATE_LIMIT overrides the default (the end-to-end tests raise it, since
// they open many rooms from one address).
func rateLimit() float64 {
	if v, err := strconv.ParseFloat(os.Getenv("PBIN_RATE_LIMIT"), 64); err == nil && v > 0 {
		return v
	}
	return 2
}

func handleWithDefaultRateLimiter(p string, h http.HandlerFunc) {
	http.Handle(p, tollbooth.LimitFuncHandler(tollbooth.NewLimiter(rateLimit(), nil), h))
}

// corsMiddleware adds Cross-Origin Isolation headers required by Runno/WebAssembly
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set headers for cross-origin isolation (required for SharedArrayBuffer and WebAssembly)
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		next.ServeHTTP(w, r)
	})
}

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync() // flushes buffer, if any
	sugar := logger.Sugar()
	var err error
	dataStore, err = NewDataStore()
	if err != nil {
		log.Fatalf("Failed to initialize data store: %v", err)
	}
	collabHubs = newCollabHub(dataStore)
	// AI tab completion; its own limiter since typing pauses can fire
	// requests faster than the default 2/s allows.
	http.Handle("/complete", tollbooth.LimitFuncHandler(tollbooth.NewLimiter(5, nil), handleComplete(sugar)))
	handleWithDefaultRateLimiter("/diff", handleDiff)
	handleWithDefaultRateLimiter("/health", handleHealth)
	handleWithDefaultRateLimiter("/paste", handlePaste)
	// immutable, timestamped snapshots of a paste
	handleWithDefaultRateLimiter("/snapshot", handleSnapshot)
	handleWithDefaultRateLimiter("/snapshots", handleSnapshots)
	// real-time collaborative editing (WebSocket)
	http.Handle("/collab", tollbooth.LimitHandler(tollbooth.NewLimiter(rateLimit(), nil), collabHubs.handler()))
	// html
	handleWithDefaultRateLimiter("/html", handleHtml)
	// Serve static files from embedded filesystem
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		sugar.Fatalw("failed to create static filesystem", "error", err)
	}
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	handleWithDefaultRateLimiter("/", handleIndex)
	// get port from env PORT
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	sugar.Infow("starting_server", "port", port)
	// Wrap default mux with CORS middleware for Runno support
	srv := &http.Server{Addr: ":" + port, Handler: corsMiddleware(http.DefaultServeMux)}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			sugar.Fatal(err)
		}
	}()

	// On SIGTERM (e.g. a redeploy) save every live document before exiting so
	// no edits are lost; editors reconnect to the new process automatically.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	<-stop
	sugar.Infow("shutting_down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	collabHubs.shutdown()
	if err := dataStore.Close(); err != nil {
		sugar.Errorw("failed to close data store", "error", err)
	}
}

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"go.uber.org/zap"
)

func TestBuildFIMPrompt(t *testing.T) {
	prompt := buildFIMPrompt("def add(a, b):\n    ", "\n\nprint(add(1, 2))")
	want := "<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\n\nprint(add(1, 2))<|fim_middle|>"
	if prompt != want {
		t.Errorf("buildFIMPrompt = %q, want %q", prompt, want)
	}
}

func TestBuildFIMPromptTrimsLongContext(t *testing.T) {
	// The prefix keeps its tail (closest to the cursor), the suffix its head.
	prefix := strings.Repeat("a", fimMaxPrefixBytes) + "TAIL"
	suffix := "HEAD" + strings.Repeat("b", fimMaxSuffixBytes)
	prompt := buildFIMPrompt(prefix, suffix)
	if !strings.Contains(prompt, "TAIL<|fim_suffix|>") {
		t.Error("prefix should keep its tail next to the suffix marker")
	}
	if !strings.Contains(prompt, "<|fim_suffix|>HEAD") {
		t.Error("suffix should keep its head after the suffix marker")
	}
	if len(prompt) > fimMaxPrefixBytes+fimMaxSuffixBytes+len(fimPrefix)+len(fimSuffix)+len(fimMiddle) {
		t.Errorf("prompt too long: %d bytes", len(prompt))
	}
}

func TestTrimRuneBoundaries(t *testing.T) {
	// "é" is 2 bytes in UTF-8; trimming must not split it.
	s := strings.Repeat("é", 10)
	for max := 0; max <= len(s); max++ {
		for _, got := range []string{trimToLastBytes(s, max), trimToFirstBytes(s, max)} {
			if len(got) > max {
				t.Fatalf("trimmed to %d bytes, want <= %d", len(got), max)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("trim split a rune: %q", got)
			}
		}
	}
}

func TestStripSpecialTokens(t *testing.T) {
	got := stripSpecialTokens("return a + b<|fim_pad|>junk<|endoftext|>more")
	if got != "return a + b" {
		t.Errorf("stripSpecialTokens = %q, want %q", got, "return a + b")
	}
}

func completionServer(t *testing.T, status int, text string, sawRequest *openAICompletionRequest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sawRequest != nil {
			if err := json.NewDecoder(r.Body).Decode(sawRequest); err != nil {
				t.Errorf("provider got invalid JSON: %v", err)
			}
		}
		w.WriteHeader(status)
		if status == http.StatusOK {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]string{{"text": text}},
			})
		}
	}))
}

func postComplete(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	handler := handleComplete(zap.NewNop().Sugar())
	req := httptest.NewRequest(http.MethodPost, "/complete", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func TestCompleteDisabledWithoutProviders(t *testing.T) {
	t.Setenv("HF_TOKEN", "")
	t.Setenv("COMPLETION_FALLBACK_URL", "")

	handler := handleComplete(zap.NewNop().Sugar())
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, "/complete", nil))
	if !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Errorf("GET /complete = %q, want enabled:false", rec.Body.String())
	}

	rec = postComplete(t, `{"prefix":"x","suffix":""}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("POST /complete status = %d, want 503", rec.Code)
	}
}

func TestCompleteUsesHuggingFace(t *testing.T) {
	var saw openAICompletionRequest
	hf := completionServer(t, http.StatusOK, "return a + b<|endoftext|>", &saw)
	defer hf.Close()
	t.Setenv("HF_TOKEN", "hf_test")
	t.Setenv("COMPLETION_HF_URL", hf.URL)
	t.Setenv("COMPLETION_FALLBACK_URL", "")

	rec := postComplete(t, `{"prefix":"def add(a, b):\n    ","suffix":"\n"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result completionResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Completion != "return a + b" {
		t.Errorf("completion = %q, want %q", result.Completion, "return a + b")
	}
	if !strings.HasPrefix(saw.Prompt, fimPrefix) || !strings.HasSuffix(saw.Prompt, fimMiddle) {
		t.Errorf("provider prompt is not FIM formatted: %q", saw.Prompt)
	}
	if saw.Model != "Qwen/Qwen2.5-Coder-0.5B" {
		t.Errorf("model = %q", saw.Model)
	}
}

func TestCompleteFallsBackToSecondProvider(t *testing.T) {
	hf := completionServer(t, http.StatusTooManyRequests, "", nil)
	defer hf.Close()
	var saw openAICompletionRequest
	fallback := completionServer(t, http.StatusOK, "  console.log('hi')", &saw)
	defer fallback.Close()
	t.Setenv("HF_TOKEN", "hf_test")
	t.Setenv("COMPLETION_HF_URL", hf.URL)
	t.Setenv("COMPLETION_FALLBACK_URL", fallback.URL)

	rec := postComplete(t, `{"prefix":"function greet() {\n","suffix":"}"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result completionResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Completion != "  console.log('hi')" {
		t.Errorf("completion = %q", result.Completion)
	}
	// The fallback URL env var is a base URL; /v1/completions is appended.
	if saw.Model != "Qwen/Qwen2.5-Coder-0.5B" {
		t.Errorf("fallback model = %q", saw.Model)
	}
}

func TestCompleteAllProvidersFail(t *testing.T) {
	hf := completionServer(t, http.StatusInternalServerError, "", nil)
	defer hf.Close()
	t.Setenv("HF_TOKEN", "hf_test")
	t.Setenv("COMPLETION_HF_URL", hf.URL)
	t.Setenv("COMPLETION_FALLBACK_URL", "")

	rec := postComplete(t, `{"prefix":"x","suffix":""}`)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}

func TestCompleteRejectsEmptyBody(t *testing.T) {
	t.Setenv("HF_TOKEN", "hf_test")
	rec := postComplete(t, `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

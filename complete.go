package main

// AI tab completion: fill-in-the-middle (FIM) code completion for the room
// editor, served by Qwen2.5-Coder-0.5B.
//
// The handler builds a Qwen2.5-Coder FIM prompt from the text before and
// after the cursor and asks, in order:
//
//  1. The Hugging Face Inference Providers router (needs HF_TOKEN), an
//     OpenAI-compatible /v1/completions API.
//  2. A fallback OpenAI-compatible server (COMPLETION_FALLBACK_URL), e.g.
//     vLLM on Modal — see examples/modal_fim_server.py.
//
// With neither configured, GET /complete reports {"enabled":false} and the
// editor never asks for completions.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"
)

const (
	// Qwen2.5-Coder FIM special tokens (https://github.com/QwenLM/Qwen2.5-Coder).
	fimPrefix = "<|fim_prefix|>"
	fimSuffix = "<|fim_suffix|>"
	fimMiddle = "<|fim_middle|>"

	// Keep prompts small: completions must be fast and the local context
	// matters most. Measured in bytes of UTF-8, cut on rune boundaries.
	fimMaxPrefixBytes = 4096
	fimMaxSuffixBytes = 1536

	fimMaxTokens = 64
	// Generous: the hosted model can be slow when cold, and a late ghost
	// text is harmless — the editor aborts stale requests on each
	// keystroke. COMPLETION_TIMEOUT_SECONDS overrides it.
	fimDefaultTimeout = 25 * time.Second
)

func fimRequestTimeout() time.Duration {
	if v, err := strconv.Atoi(os.Getenv("COMPLETION_TIMEOUT_SECONDS")); err == nil && v > 0 {
		return time.Duration(v) * time.Second
	}
	return fimDefaultTimeout
}

// completionStop are the sequences that end a FIM generation. The OpenAI
// completions API accepts at most 4 stop sequences; the remaining special
// tokens are stripped from the response instead.
var completionStop = []string{"<|endoftext|>", fimPrefix, fimSuffix, fimMiddle}

// completionSpecialTokens is every Qwen2.5-Coder special token that may leak
// into generated text; anything from the first occurrence onward is dropped.
var completionSpecialTokens = []string{
	"<|endoftext|>", fimPrefix, fimSuffix, fimMiddle,
	"<|fim_pad|>", "<|repo_name|>", "<|file_sep|>",
	"<|im_start|>", "<|im_end|>",
}

type completionProvider struct {
	name  string
	url   string // full URL of an OpenAI-compatible /v1/completions endpoint
	token string
	model string
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// completionProviders returns the configured providers in the order they are
// tried: Hugging Face first, then the fallback (e.g. Modal).
func completionProviders() []completionProvider {
	var providers []completionProvider
	if token := os.Getenv("HF_TOKEN"); token != "" {
		providers = append(providers, completionProvider{
			name: "huggingface",
			// Raw text completions need the provider-scoped route; the
			// unified /v1/completions only exists for chat. featherless-ai
			// is the provider serving the 0.5B base model.
			url:   envOr("COMPLETION_HF_URL", "https://router.huggingface.co/featherless-ai/v1/completions"),
			token: token,
			model: envOr("COMPLETION_MODEL", "Qwen/Qwen2.5-Coder-0.5B"),
		})
	}
	if base := os.Getenv("COMPLETION_FALLBACK_URL"); base != "" {
		providers = append(providers, completionProvider{
			name:  "fallback",
			url:   strings.TrimSuffix(base, "/") + "/v1/completions",
			token: os.Getenv("COMPLETION_FALLBACK_TOKEN"),
			model: envOr("COMPLETION_FALLBACK_MODEL", "Qwen/Qwen2.5-Coder-0.5B"),
		})
	}
	return providers
}

// trimToLastBytes keeps at most max trailing bytes of s, cutting at a rune
// boundary so the prompt never starts mid-character.
func trimToLastBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	for cut < len(s) && s[cut]&0xC0 == 0x80 {
		cut++
	}
	return s[cut:]
}

// trimToFirstBytes keeps at most max leading bytes of s, cutting at a rune
// boundary.
func trimToFirstBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && s[cut]&0xC0 == 0x80 {
		cut--
	}
	return s[:cut]
}

func buildFIMPrompt(prefix, suffix string) string {
	prefix = trimToLastBytes(prefix, fimMaxPrefixBytes)
	suffix = trimToFirstBytes(suffix, fimMaxSuffixBytes)
	return fimPrefix + prefix + fimSuffix + suffix + fimMiddle
}

// stripSpecialTokens cuts the completion at the first special token the stop
// list could not catch.
func stripSpecialTokens(s string) string {
	for _, tok := range completionSpecialTokens {
		if i := strings.Index(s, tok); i >= 0 {
			s = s[:i]
		}
	}
	return s
}

type openAICompletionRequest struct {
	Model       string   `json:"model"`
	Prompt      string   `json:"prompt"`
	MaxTokens   int      `json:"max_tokens"`
	Temperature float64  `json:"temperature"`
	Stop        []string `json:"stop,omitempty"`
}

type openAICompletionResponse struct {
	Choices []struct {
		Text string `json:"text"`
	} `json:"choices"`
}

func callCompletionProvider(ctx context.Context, client *http.Client, p completionProvider, prompt string) (string, error) {
	body, err := json.Marshal(openAICompletionRequest{
		Model:       p.model,
		Prompt:      prompt,
		MaxTokens:   fimMaxTokens,
		Temperature: 0,
		Stop:        completionStop,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s returned %d: %.200s", p.name, resp.StatusCode, respBody)
	}
	var parsed openAICompletionResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("%s returned invalid JSON: %w", p.name, err)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("%s returned no choices", p.name)
	}
	return stripSpecialTokens(parsed.Choices[0].Text), nil
}

type completionRequest struct {
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

type completionResult struct {
	Completion string `json:"completion"`
}

func handleComplete(sugar *zap.SugaredLogger) http.HandlerFunc {
	client := &http.Client{Timeout: fimRequestTimeout()}
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// The editor probes this to decide whether to register the
			// inline completions provider at all.
			w.Header().Set("Content-Type", "application/json")
			enabled := len(completionProviders()) > 0
			json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled})
		case http.MethodPost:
			providers := completionProviders()
			if len(providers) == 0 {
				http.Error(w, "completion is not configured", http.StatusServiceUnavailable)
				return
			}
			var cr completionRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&cr); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
			if cr.Prefix == "" && cr.Suffix == "" {
				http.Error(w, "prefix or suffix required", http.StatusBadRequest)
				return
			}
			prompt := buildFIMPrompt(cr.Prefix, cr.Suffix)
			var lastErr error
			for _, p := range providers {
				ctx, cancel := context.WithTimeout(r.Context(), fimRequestTimeout())
				completion, err := callCompletionProvider(ctx, client, p, prompt)
				cancel()
				if err != nil {
					lastErr = err
					sugar.Warnw("completion_provider_failed", "provider", p.name, "error", err)
					// The client gave up (navigated away, typed again):
					// don't burn the fallback on a dead request.
					if r.Context().Err() != nil {
						return
					}
					continue
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(completionResult{Completion: completion})
				return
			}
			sugar.Errorw("completion_failed", "error", lastErr)
			http.Error(w, "all completion providers failed", http.StatusBadGateway)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strings"
	"time"
)

type SnapshotTemplateContent struct {
	Text, Language, ID, Name, Title, PasteID, CreatedAt string
}

type SnapshotListEntry struct {
	ID, Name, Title, Language, CreatedAt string
}

type SnapshotsTemplateContent struct {
	PasteID, Title string
	Snapshots      []SnapshotListEntry
}

// snapshotNameMaxLen caps user-supplied snapshot names.
const snapshotNameMaxLen = 120

// snapshotCreatedAt renders the snapshot's timestamp for display, falling
// back to the raw stored value if it does not parse.
func snapshotCreatedAt(s *Snapshot) string {
	t, err := s.CreatedAt()
	if err != nil {
		return s.SK
	}
	return t.UTC().Format(time.RFC3339)
}

// handleSnapshot creates (POST) and serves (GET) immutable snapshots of a
// paste. A snapshot is a frozen, timestamped copy: there is no way to update
// or delete one through the API.
func handleSnapshot(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case "POST":
		if err := request.ParseForm(); err != nil {
			fmt.Fprintf(writer, "ParseForm() err: %v", err)
			return
		}
		pasteID := request.FormValue("id")
		if pasteID == "" {
			writer.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(writer, "Missing paste ID")
			return
		}

		// The paste must exist; a snapshot always points back to it.
		paste, err := dataStore.GetPaste(pasteID)
		if err != nil {
			log.Printf("Failed to get paste for snapshot: %v", err)
			writer.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(writer, "Paste not found")
			return
		}

		// Collab saves are debounced, so the client may send the live editor
		// content to freeze exactly what is on screen; fields it leaves out
		// are snapshotted from the stored paste.
		text, lang, title := paste.Text, paste.Language, paste.Title
		if request.PostForm.Has("text") {
			text = request.PostFormValue("text")
		}
		if request.PostForm.Has("lang") {
			lang = request.PostFormValue("lang")
		}
		if request.PostForm.Has("title") {
			title = request.PostFormValue("title")
		}

		// Optional snapshot name; when left empty the store picks a petname.
		name := strings.TrimSpace(request.PostFormValue("name"))
		if runes := []rune(name); len(runes) > snapshotNameMaxLen {
			name = string(runes[:snapshotNameMaxLen])
		}

		snapshot, err := dataStore.AddSnapshot(pasteID, name, text, lang, title)
		if err != nil {
			log.Printf("Failed to add snapshot: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}

		url := "/snapshot?id=" + snapshot.PK
		if strings.Contains(request.Header.Get("Accept"), "application/json") {
			writer.Header().Set("Content-Type", "application/json")
			json.NewEncoder(writer).Encode(map[string]string{
				"id":      snapshot.PK,
				"pasteId": pasteID,
				"name":    snapshot.Name,
				"created": snapshotCreatedAt(snapshot),
				"url":     url,
			})
			return
		}
		http.Redirect(writer, request, url, http.StatusSeeOther)
	case "GET":
		id := request.URL.Query().Get("id")
		if id == "" {
			http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
			return
		}

		// A .txt suffix serves the raw text, like /paste does.
		isPlainText := strings.HasSuffix(id, ".txt")
		actualID := strings.TrimSuffix(id, ".txt")

		snapshot, err := dataStore.GetSnapshot(actualID)
		if err != nil {
			log.Printf("Failed to get snapshot: %v", err)
			writer.WriteHeader(http.StatusNotFound)
			return
		}

		if isPlainText {
			writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
			if _, err := writer.Write([]byte(snapshot.Text)); err != nil {
				log.Printf("Failed to write response: %v", err)
			}
			return
		}

		stc := SnapshotTemplateContent{
			Text:      snapshot.Text,
			Language:  snapshot.Language,
			ID:        snapshot.PK,
			Name:      snapshot.Name,
			Title:     snapshot.Title,
			PasteID:   snapshot.PasteID,
			CreatedAt: snapshotCreatedAt(snapshot),
		}
		t := template.Must(template.New("snapshot").Parse(SNAPSHOT_TEMPLATE_TEXT))
		if err := t.ExecuteTemplate(writer, "snapshot", stc); err != nil {
			log.Printf("Failed to execute template: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
	default:
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
	}
}

// handleSnapshots lists a paste's snapshots, newest first, as a browsable
// HTML page.
func handleSnapshots(writer http.ResponseWriter, request *http.Request) {
	if request.Method != "GET" {
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
		return
	}
	pasteID := request.URL.Query().Get("id")
	if pasteID == "" {
		http.Redirect(writer, request, PBIN_URL, http.StatusMovedPermanently)
		return
	}

	paste, err := dataStore.GetPaste(pasteID)
	if err != nil {
		log.Printf("Failed to get paste for snapshot list: %v", err)
		writer.WriteHeader(http.StatusNotFound)
		return
	}

	snapshots, err := dataStore.ListSnapshots(pasteID)
	if err != nil {
		log.Printf("Failed to list snapshots: %v", err)
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}

	content := SnapshotsTemplateContent{PasteID: pasteID, Title: paste.Title}
	for _, s := range snapshots {
		content.Snapshots = append(content.Snapshots, SnapshotListEntry{
			ID:        s.PK,
			Name:      s.Name,
			Title:     s.Title,
			Language:  s.Language,
			CreatedAt: snapshotCreatedAt(s),
		})
	}

	t := template.Must(template.New("snapshots").Parse(SNAPSHOTS_TEMPLATE_TEXT))
	if err := t.ExecuteTemplate(writer, "snapshots", content); err != nil {
		log.Printf("Failed to execute template: %v", err)
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
}

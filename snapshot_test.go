package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func newTestBoltStore(t *testing.T) *BoltStore {
	t.Helper()
	if raceEnabled {
		t.Skip("boltdb/bolt v1.3.1 is incompatible with checkptr under -race")
	}
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "test.db"))
	store, err := NewBoltStore()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// Snapshots must be immutable: editing the paste afterwards cannot change
// what a snapshot holds.
func TestBoltSnapshotIsImmutable(t *testing.T) {
	store := newTestBoltStore(t)

	id, err := store.AddPaste("v1", "go", "T1")
	if err != nil {
		t.Fatal(err)
	}
	snap, err := store.AddSnapshot(id, "my snap", "v1", "go", "T1")
	if err != nil {
		t.Fatal(err)
	}
	if snap.PK == "" || snap.SK == "" || snap.PasteID != id {
		t.Fatalf("snapshot = %+v", snap)
	}
	if _, err := snap.CreatedAt(); err != nil {
		t.Fatalf("CreatedAt: %v", err)
	}

	if err := store.UpdatePaste(id, "v2", "python", "T2"); err != nil {
		t.Fatal(err)
	}

	got, err := store.GetSnapshot(snap.PK)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "v1" || got.Language != "go" || got.Title != "T1" || got.PasteID != id || got.Name != "my snap" {
		t.Fatalf("snapshot changed: %+v", got)
	}
}

// A snapshot created without a name gets an auto-generated petname.
func TestSnapshotDefaultsToPetname(t *testing.T) {
	a := newSnapshot("p1", "", "x", "", "")
	if a.Name == "" {
		t.Fatal("empty name should get a generated petname")
	}
	b := newSnapshot("p1", "  \t ", "x", "", "")
	if b.Name == "" || strings.TrimSpace(b.Name) != b.Name {
		t.Fatalf("blank name should get a generated petname, got %q", b.Name)
	}
	c := newSnapshot("p1", "  chosen name ", "x", "", "")
	if c.Name != "chosen name" {
		t.Fatalf("explicit name should be kept (trimmed), got %q", c.Name)
	}
}

func TestBoltListSnapshotsNewestFirst(t *testing.T) {
	store := newTestBoltStore(t)

	id, err := store.AddPaste("x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.AddPaste("y", "", "")
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for _, text := range []string{"first", "second", "third"} {
		s, err := store.AddSnapshot(id, "", text, "go", "")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, s.PK)
	}
	if _, err := store.AddSnapshot(other, "", "elsewhere", "", ""); err != nil {
		t.Fatal(err)
	}

	snaps, err := store.ListSnapshots(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(snaps) != 3 {
		t.Fatalf("got %d snapshots, want 3", len(snaps))
	}
	for i, want := range []string{"third", "second", "first"} {
		if snaps[i].Text != want {
			t.Fatalf("snaps[%d].Text = %q, want %q", i, snaps[i].Text, want)
		}
		if snaps[i].PK != ids[2-i] {
			t.Fatalf("snaps[%d].PK = %q, want %q", i, snaps[i].PK, ids[2-i])
		}
	}

	none, err := store.ListSnapshots("missing")
	if err != nil || len(none) != 0 {
		t.Fatalf("missing paste: snaps %v, err %v", none, err)
	}
}

func TestHandleSnapshotPostAndGet(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "stored", Language: "go", Title: "T"}}}
	prev := dataStore
	dataStore = store
	defer func() { dataStore = prev }()

	// The client sends the live editor content; title falls back to the
	// stored paste's, and the omitted name gets a generated petname.
	form := url.Values{"id": {"p1"}, "text": {"live text"}, "lang": {"python"}}
	req := httptest.NewRequest("POST", "/snapshot", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	rec := httptest.NewRecorder()
	handleSnapshot(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body %q", rec.Code, rec.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["id"] == "" || resp["url"] != "/snapshot?id="+resp["id"] || resp["created"] == "" || resp["name"] == "" {
		t.Fatalf("response = %v", resp)
	}

	snap, err := store.GetSnapshot(resp["id"])
	if err != nil {
		t.Fatal(err)
	}
	if snap.Text != "live text" || snap.Language != "python" || snap.Title != "T" || snap.Name != resp["name"] {
		t.Fatalf("snapshot = %+v", snap)
	}

	// An explicit name is kept.
	form = url.Values{"id": {"p1"}, "name": {"before refactor"}}
	req = httptest.NewRequest("POST", "/snapshot", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	rec = httptest.NewRecorder()
	handleSnapshot(rec, req)
	var named map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &named); err != nil {
		t.Fatal(err)
	}
	if named["name"] != "before refactor" {
		t.Fatalf("name = %q, want %q", named["name"], "before refactor")
	}

	// GET renders the snapshot page.
	rec = httptest.NewRecorder()
	handleSnapshot(rec, httptest.NewRequest("GET", "/snapshot?id="+resp["id"], nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "live text") {
		t.Fatalf("GET status = %d", rec.Code)
	}

	// GET with .txt serves the raw text.
	rec = httptest.NewRecorder()
	handleSnapshot(rec, httptest.NewRequest("GET", "/snapshot?id="+resp["id"]+".txt", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "live text" {
		t.Fatalf("raw GET: status %d, body %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("raw GET Content-Type = %q", ct)
	}

	// A browser form post (no JSON accept) redirects to the snapshot page.
	form = url.Values{"id": {"p1"}}
	req = httptest.NewRequest("POST", "/snapshot", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	handleSnapshot(rec, req)
	if rec.Code != http.StatusSeeOther || !strings.HasPrefix(rec.Header().Get("Location"), "/snapshot?id=") {
		t.Fatalf("form POST: status %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}

	// Snapshotting a missing paste fails.
	form = url.Values{"id": {"nope"}}
	req = httptest.NewRequest("POST", "/snapshot", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	handleSnapshot(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing paste: status %d", rec.Code)
	}
}

func TestHandleSnapshotsListsNewestFirst(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "x", Title: "My paste"}}}
	prev := dataStore
	dataStore = store
	defer func() { dataStore = prev }()

	s1, _ := store.AddSnapshot("p1", "snap-one", "one", "go", "first snap")
	s2, _ := store.AddSnapshot("p1", "snap-two", "two", "go", "second snap")

	rec := httptest.NewRecorder()
	handleSnapshots(rec, httptest.NewRequest("GET", "/snapshots?id=p1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	i1 := strings.Index(body, s1.PK)
	i2 := strings.Index(body, s2.PK)
	if i1 < 0 || i2 < 0 || i2 > i1 {
		t.Fatalf("snapshot order wrong: i1=%d i2=%d", i1, i2)
	}
	if !strings.Contains(body, "My paste") {
		t.Fatal("page should show the paste title")
	}

	// Unknown paste is a 404.
	rec = httptest.NewRecorder()
	handleSnapshots(rec, httptest.NewRequest("GET", "/snapshots?id=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing paste: status %d", rec.Code)
	}
}

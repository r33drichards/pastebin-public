package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/net/websocket"
)

func randomOp(rng *rand.Rand, doc []uint16) *TextOp {
	op := &TextOp{}
	i := 0
	for i < len(doc) {
		n := rng.Intn(len(doc)-i) + 1
		switch rng.Intn(3) {
		case 0:
			op.Retain(n)
			i += n
		case 1:
			op.Delete(n)
			i += n
		case 2:
			op.InsertString(randomText(rng))
		}
	}
	if rng.Intn(2) == 0 {
		op.InsertString(randomText(rng))
	}
	return op
}

func randomText(rng *rand.Rand) string {
	chars := []string{"a", "b", "\n", " ", "é", "😀"}
	var b strings.Builder
	for n := rng.Intn(5) + 1; n > 0; n-- {
		b.WriteString(chars[rng.Intn(len(chars))])
	}
	return b.String()
}

func TestTransformConverges(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 2000; iter++ {
		doc := utf16.Encode([]rune(randomText(rng) + randomText(rng)))
		a, b := randomOp(rng, doc), randomOp(rng, doc)
		ap, bp, err := TransformOps(a, b)
		if err != nil {
			t.Fatal(err)
		}
		da, _ := a.Apply(doc)
		db, _ := b.Apply(doc)
		left, err := bp.Apply(da)
		if err != nil {
			t.Fatal(err)
		}
		right, err := ap.Apply(db)
		if err != nil {
			t.Fatal(err)
		}
		if string(utf16.Decode(left)) != string(utf16.Decode(right)) {
			t.Fatalf("diverged: %q vs %q", string(utf16.Decode(left)), string(utf16.Decode(right)))
		}
	}
}

func TestOpJSONRoundTrip(t *testing.T) {
	var op TextOp
	if err := json.Unmarshal([]byte(`[3,"hi 😀",-2,1]`), &op); err != nil {
		t.Fatal(err)
	}
	if op.baseLen != 6 || op.targetLen != 3+5+1 {
		t.Fatalf("lengths: base %d target %d", op.baseLen, op.targetLen)
	}
	out, _ := json.Marshal(&op)
	if string(out) != `[3,"hi 😀",-2,1]` {
		t.Fatalf("got %s", out)
	}
	for _, bad := range []string{`[0]`, `[1.5]`, `[""]`, `[true]`, `{}`} {
		if err := json.Unmarshal([]byte(bad), &op); err == nil {
			t.Errorf("expected error for %s", bad)
		}
	}
}

// memStore is an in-memory DataStore for tests.
type memStore struct {
	mu        sync.Mutex
	pastes    map[string]Paste
	snapshots []Snapshot
}

func (m *memStore) GetPaste(id string) (*Paste, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pastes[id]
	if !ok {
		return nil, fmt.Errorf("paste not found")
	}
	return &p, nil
}
func (m *memStore) AddPaste(text, lang, title string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := fmt.Sprintf("new%d", len(m.pastes)+1)
	m.pastes[id] = Paste{PK: id, Text: text, Language: lang, Title: title}
	return id, nil
}
func (m *memStore) UpdatePaste(id, text, lang, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.pastes[id]
	p.Text, p.Language, p.Title = text, lang, title
	m.pastes[id] = p
	return nil
}
func (m *memStore) GetDiff(id string) (*Diff, error)                { return nil, nil }
func (m *memStore) AddDiff(oldText, newText string) (string, error) { return "", nil }
func (m *memStore) AddSnapshot(pasteID, name, text, lang, title string) (*Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := newSnapshot(pasteID, name, text, lang, title)
	m.snapshots = append(m.snapshots, *s)
	return s, nil
}
func (m *memStore) GetSnapshot(id string) (*Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.snapshots {
		if s.PK == id {
			s := s
			return &s, nil
		}
	}
	return nil, fmt.Errorf("snapshot not found")
}
func (m *memStore) ListSnapshots(pasteID string) ([]*Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*Snapshot
	for i := len(m.snapshots) - 1; i >= 0; i-- {
		if m.snapshots[i].PasteID == pasteID {
			s := m.snapshots[i]
			out = append(out, &s)
		}
	}
	return out, nil
}
func (m *memStore) Close() error { return nil }

// testClient is a minimal Go port of the browser's OT client state machine.
type testClient struct {
	t           *testing.T
	ws          *websocket.Conn
	mu          sync.Mutex
	doc         []uint16
	rev         int
	outstanding *TextOp
	buffer      *TextOp
	acked       chan struct{}
}

func dialTest(t *testing.T, url, id string) *testClient {
	ws, err := websocket.Dial(url+"?id="+id, "", "http"+strings.TrimPrefix(url, "ws"))
	if err != nil {
		t.Fatal(err)
	}
	c := &testClient{t: t, ws: ws, acked: make(chan struct{}, 1000)}
	var init collabMessage
	if err := websocket.JSON.Receive(ws, &init); err != nil || init.Type != "init" {
		t.Fatalf("init: %v %+v", err, init)
	}
	c.doc = utf16.Encode([]rune(*init.Text))
	c.rev = *init.Rev
	go c.readLoop()
	return c
}

func (c *testClient) readLoop() {
	for {
		var msg collabMessage
		if err := websocket.JSON.Receive(c.ws, &msg); err != nil {
			return
		}
		c.mu.Lock()
		switch msg.Type {
		case "ack":
			c.rev++
			c.outstanding = nil
			if c.buffer != nil {
				c.sendLocked(c.buffer)
				c.buffer = nil
			}
			c.acked <- struct{}{}
		case "op":
			c.rev++
			op := msg.Op
			if c.outstanding != nil {
				c.outstanding, op, _ = TransformOps(c.outstanding, op)
			}
			if c.buffer != nil {
				c.buffer, op, _ = TransformOps(c.buffer, op)
			}
			doc, err := op.Apply(c.doc)
			if err != nil {
				c.t.Errorf("apply remote: %v", err)
			}
			c.doc = doc
		case "error":
			c.t.Errorf("server error: %s", msg.Error)
		}
		c.mu.Unlock()
	}
}

func (c *testClient) sendLocked(op *TextOp) {
	rev := c.rev
	c.outstanding = op
	websocket.JSON.Send(c.ws, collabMessage{Type: "op", Rev: &rev, Op: op})
}

func (c *testClient) edit(rng *rand.Rand) {
	c.mu.Lock()
	defer c.mu.Unlock()
	op := &TextOp{}
	// Like a real editor, never edit in the middle of a surrogate pair: a lone
	// surrogate cannot be sent as JSON text without being replaced.
	midPair := func(i int) bool {
		return i > 0 && i < len(c.doc) && utf16.IsSurrogate(rune(c.doc[i])) && utf16.IsSurrogate(rune(c.doc[i-1])) &&
			c.doc[i-1] < 0xDC00 && c.doc[i] >= 0xDC00
	}
	pos := rng.Intn(len(c.doc) + 1)
	if midPair(pos) {
		pos--
	}
	op.Retain(pos)
	if rng.Intn(3) == 0 && pos < len(c.doc) {
		n := rng.Intn(len(c.doc)-pos) + 1
		if n > 3 {
			n = 3
		}
		if midPair(pos + n) {
			n++
		}
		op.Delete(n)
		op.Retain(len(c.doc) - pos - n)
	} else {
		op.InsertString(randomText(rng))
		op.Retain(len(c.doc) - pos)
	}
	doc, err := op.Apply(c.doc)
	if err != nil {
		c.t.Fatal(err)
	}
	c.doc = doc
	switch {
	case c.outstanding == nil:
		c.sendLocked(op)
	case c.buffer == nil:
		c.buffer = op
	default:
		// compose buffer then op by applying both: simplest is to rebuild via diff
		c.buffer = composeForTest(c.buffer, op)
	}
}

// composeForTest composes two ops by brute force on character identity.
func composeForTest(a, b *TextOp) *TextOp {
	// Represent a's output as markers: >=0 original index, -1 inserted char.
	type ch struct {
		orig int
		val  uint16
	}
	var mid []ch
	i := 0
	for _, c := range a.comps {
		switch c.kind {
		case compRetain:
			for k := 0; k < c.n; k++ {
				mid = append(mid, ch{orig: i})
				i++
			}
		case compInsert:
			for _, v := range c.s {
				mid = append(mid, ch{orig: -1, val: v})
			}
		case compDelete:
			i += c.n
		}
	}
	var out []ch
	j := 0
	for _, c := range b.comps {
		switch c.kind {
		case compRetain:
			out = append(out, mid[j:j+c.n]...)
			j += c.n
		case compInsert:
			for _, v := range c.s {
				out = append(out, ch{orig: -1, val: v})
			}
		case compDelete:
			j += c.n
		}
	}
	res := &TextOp{}
	prev := 0
	for _, c := range out {
		if c.orig >= 0 {
			res.Delete(c.orig - prev)
			res.Retain(1)
			prev = c.orig + 1
		} else {
			res.Insert([]uint16{c.val})
		}
	}
	res.Delete(a.baseLen - prev)
	return res
}

func (c *testClient) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(utf16.Decode(c.doc))
}

func (c *testClient) idle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.outstanding == nil && c.buffer == nil
}

func TestCollabConcurrentEditorsConverge(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "hello\r\nworld", Language: "go", Title: "T"}}}
	hub := newCollabHub(store)
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")

	clients := []*testClient{dialTest(t, url, "p1"), dialTest(t, url, "p1"), dialTest(t, url, "p1")}
	if got := clients[0].text(); got != "hello\nworld" {
		t.Fatalf("initial text %q", got)
	}

	var wg sync.WaitGroup
	for n, c := range clients {
		wg.Add(1)
		go func(n int, c *testClient) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(n)))
			for k := 0; k < 200; k++ {
				c.edit(rng)
				if rng.Intn(4) == 0 {
					time.Sleep(time.Millisecond)
				}
			}
		}(n, c)
	}
	wg.Wait()

	deadline := time.Now().Add(10 * time.Second)
	for {
		settled := true
		for _, c := range clients {
			if !c.idle() || c.text() != clients[0].text() {
				settled = false
			}
		}
		if settled {
			break
		}
		if time.Now().After(deadline) {
			for i, c := range clients {
				t.Logf("client %d idle=%v text=%q", i, c.idle(), c.text())
			}
			t.Fatal("clients did not converge")
		}
		time.Sleep(20 * time.Millisecond)
	}

	final := clients[0].text()
	for _, c := range clients {
		c.ws.Close()
	}
	// Last client leaving flushes the document to the store.
	deadline = time.Now().Add(5 * time.Second)
	for {
		p, _ := store.GetPaste("p1")
		if p.Text == final && p.Title == "T" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("store has %q, want %q", p.Text, final)
		}
		time.Sleep(20 * time.Millisecond)
	}
	hub.mu.Lock()
	rooms := len(hub.rooms)
	hub.mu.Unlock()
	if rooms != 0 {
		t.Fatalf("room not cleaned up")
	}
}

func TestCollabReplacePushesToEditors(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "old", Language: "go"}}}
	hub := newCollabHub(store)
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	c := dialTest(t, "ws"+strings.TrimPrefix(srv.URL, "http"), "p1")
	defer c.ws.Close()

	if !hub.replace("p1", "new text", "python", "") {
		t.Fatal("expected live room")
	}
	deadline := time.Now().Add(5 * time.Second)
	for c.text() != "new text" {
		if time.Now().After(deadline) {
			t.Fatalf("got %q", c.text())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if hub.replace("missing", "x", "", "") {
		t.Fatal("no room expected")
	}
}

func TestCollabRejectsUnknownPasteAndCrossOrigin(t *testing.T) {
	hub := newCollabHub(&memStore{pastes: map[string]Paste{}})
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")

	ws, err := websocket.Dial(url+"?id=nope", "", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	var msg collabMessage
	if err := websocket.JSON.Receive(ws, &msg); err != nil || msg.Type != "error" {
		t.Fatalf("expected error, got %+v %v", msg, err)
	}
	ws.Close()

	if _, err := websocket.Dial(url+"?id=nope", "", "http://evil.example"); err == nil {
		t.Fatal("expected cross-origin dial to fail")
	}
}

func TestCollabShutdownSavesAndRejectsEdits(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "abc"}}}
	hub := newCollabHub(store)
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	c := dialTest(t, "ws"+strings.TrimPrefix(srv.URL, "http"), "p1")
	defer c.ws.Close()

	c.edit(rand.New(rand.NewSource(7)))
	deadline := time.Now().Add(5 * time.Second)
	for !c.idle() {
		if time.Now().After(deadline) {
			t.Fatal("edit never acknowledged")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The debounced save hasn't fired yet; shutdown must flush it.
	hub.shutdown()
	if p, _ := store.GetPaste("p1"); p.Text != c.text() {
		t.Fatalf("store has %q, want %q", p.Text, c.text())
	}
	if _, err := hub.join("p1", &collabClient{send: make(chan []byte, 8)}); err == nil {
		t.Fatal("join should fail while shutting down")
	}
}

func TestCollabSeqDedupAndInitState(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{"p1": {PK: "p1", Text: "abc"}}}
	hub := newCollabHub(store)
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "?id=p1&key=tab1"
	origin := srv.URL

	ws, err := websocket.Dial(url, "", origin)
	if err != nil {
		t.Fatal(err)
	}
	var init collabMessage
	websocket.JSON.Receive(ws, &init)
	if !init.Fresh || init.Session == "" || init.LastSeq == nil || *init.LastSeq != 0 {
		t.Fatalf("unexpected init %+v", init)
	}
	// A second viewer keeps the room alive across the first client's reconnect.
	other, err := websocket.Dial(strings.Replace(url, "tab1", "tab2", 1), "", origin)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()

	rev := 0
	op := (&TextOp{}).Retain(3).InsertString("d")
	websocket.JSON.Send(ws, collabMessage{Type: "op", Rev: &rev, Seq: 1, Op: op})
	for {
		var m collabMessage
		if err := websocket.JSON.Receive(ws, &m); err != nil {
			t.Fatal(err)
		}
		if m.Type == "ack" {
			break
		}
	}
	ws.Close()

	ws2, err := websocket.Dial(url, "", origin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws2.Close()
	var init2 collabMessage
	websocket.JSON.Receive(ws2, &init2)
	if init2.Session != init.Session || init2.Fresh || *init2.LastSeq != 1 || *init2.Text != "abcd" {
		t.Fatalf("unexpected reconnect init %+v", init2)
	}
	// Replaying seq 1 is rejected rather than applied twice.
	rev = 0
	websocket.JSON.Send(ws2, collabMessage{Type: "op", Rev: &rev, Seq: 1, Op: op})
	for {
		var m collabMessage
		if err := websocket.JSON.Receive(ws2, &m); err != nil {
			t.Fatal("expected an error message before close")
		}
		if m.Type == "error" {
			break
		}
	}
	hub.mu.Lock()
	room := hub.rooms["p1"]
	hub.mu.Unlock()
	if p := room; p != nil {
		p.mu.Lock()
		text := string(utf16.Decode(p.doc))
		p.mu.Unlock()
		if text != "abcd" {
			t.Fatalf("doc %q", text)
		}
	}
}

func TestIndexCreatesRoomAndRedirects(t *testing.T) {
	store := &memStore{pastes: map[string]Paste{}}
	prev := dataStore
	dataStore = store
	defer func() { dataStore = prev }()

	rec := httptest.NewRecorder()
	handleIndex(rec, httptest.NewRequest("GET", "/?lang=python", nil))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want 303", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "/paste?id=") {
		t.Fatalf("Location = %q", loc)
	}
	p, err := store.GetPaste(strings.TrimPrefix(loc, "/paste?id="))
	if err != nil || p == nil || p.PK == "" || p.Language != "python" || p.Text != "" {
		t.Fatalf("room paste = %+v, err %v", p, err)
	}

	// HEAD must not create a room.
	rec = httptest.NewRecorder()
	handleIndex(rec, httptest.NewRequest("HEAD", "/", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Location") != "" {
		t.Fatalf("HEAD: status %d, Location %q", rec.Code, rec.Header().Get("Location"))
	}
}

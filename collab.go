package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// Real-time collaborative editing.
//
// Every paste has a "room". Clients connect to /collab?id=<paste id> over a
// WebSocket and exchange OT operations (see collab_ot.go). The server is the
// single source of truth: it transforms each incoming operation against the
// operations the client had not yet seen, applies it, acknowledges it to the
// sender and broadcasts it to everyone else. Changes are persisted to the
// DataStore shortly after editing pauses and when the last client leaves.

const (
	collabSaveDelay      = 2 * time.Second
	collabMaxDocLen      = 2 << 20 // UTF-16 code units
	collabMaxMessage     = 8 << 20
	collabHistoryMax     = 2000
	collabSendBuffer     = 256
	collabMaxNameLen     = 32
	collabMaxLanguageLen = 64
)

var collabColors = []string{
	"#e5484d", "#0091ff", "#30a46c", "#f76b15", "#8e4ec6",
	"#12a594", "#d6409f", "#ffb224", "#3e63dd", "#ad7f58",
}

var collabAnimals = []string{
	"Otter", "Fox", "Panda", "Koala", "Lynx", "Heron", "Badger", "Falcon",
	"Moose", "Gecko", "Walrus", "Raven", "Bison", "Ocelot", "Puffin", "Tapir",
}

type collabSelection struct {
	Anchor int `json:"anchor"`
	Head   int `json:"head"`
}

type collabPeer struct {
	ID    string           `json:"id"`
	Name  string           `json:"name"`
	Color string           `json:"color"`
	Sel   *collabSelection `json:"sel,omitempty"`
}

// collabMessage is the envelope for every message in both directions.
type collabMessage struct {
	Type     string           `json:"type"`
	Rev      *int             `json:"rev,omitempty"`
	Op       *TextOp          `json:"op,omitempty"`
	Sel      *collabSelection `json:"sel,omitempty"`
	Text     *string          `json:"text,omitempty"`
	Lang     *string          `json:"lang,omitempty"`
	Name     string           `json:"name,omitempty"`
	ClientID string           `json:"clientId,omitempty"`
	Peer     *collabPeer      `json:"peer,omitempty"`
	Peers    []*collabPeer    `json:"peers,omitempty"`
	Error    string           `json:"error,omitempty"`
	// Seq numbers a client's operations so that after a reconnect it can tell
	// whether its last unacknowledged operation was applied.
	Seq int `json:"seq,omitempty"`
	// Init only: Session identifies this in-memory copy of the room (it changes
	// when the server restarts), LastSeq is the last applied Seq for the
	// connecting client key, and Fresh means nobody has edited since the room
	// was loaded from storage.
	Session string `json:"session,omitempty"`
	LastSeq *int   `json:"lastSeq,omitempty"`
	Fresh   bool   `json:"fresh,omitempty"`
}

type collabClient struct {
	key  string // stable per browser tab across reconnects
	peer collabPeer
	send chan []byte
	conn *websocket.Conn
}

type collabRoom struct {
	id      string
	hub     *collabHub
	session string

	mu       sync.Mutex
	doc      []uint16
	lang     string
	title    string
	rev      int
	history  []*TextOp // history[i] took the document from revision histBase+i to histBase+i+1
	histBase int
	clients  map[string]*collabClient
	lastSeq  map[string]int // client key -> last applied Seq
	closed   bool           // set during shutdown; no further edits
	dirty    bool
	timer    *time.Timer
	colorIdx int

	saveMu sync.Mutex
}

type collabHub struct {
	store   DataStore
	mu      sync.Mutex
	rooms   map[string]*collabRoom
	closing bool
}

func newCollabHub(store DataStore) *collabHub {
	return &collabHub{store: store, rooms: map[string]*collabRoom{}}
}

func normalizeNewlines(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
}

// join adds a client to the room for id, loading the paste if needed.
func (h *collabHub) join(id string, c *collabClient) (*collabRoom, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return nil, fmt.Errorf("server shutting down")
	}
	r := h.rooms[id]
	if r == nil {
		paste, err := h.store.GetPaste(id)
		if err != nil {
			return nil, err
		}
		if paste == nil || paste.PK == "" {
			return nil, fmt.Errorf("paste not found")
		}
		r = &collabRoom{
			id:      id,
			hub:     h,
			session: uuid.New().String(),
			lastSeq: map[string]int{},
			doc:     utf16.Encode([]rune(normalizeNewlines(paste.Text))),
			lang:    paste.Language,
			title:   paste.Title,
			clients: map[string]*collabClient{},
		}
		h.rooms[id] = r
	}
	r.addClient(c)
	return r, nil
}

// leave removes a client. When the room empties it is saved and dropped.
func (h *collabHub) leave(r *collabRoom, c *collabClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.removeClient(c) == 0 {
		// Flush while holding the hub lock so a client joining right now
		// reloads the saved text instead of a stale copy.
		r.save()
		delete(h.rooms, r.id)
	}
}

// replace pushes an out-of-band update (e.g. a PUT /paste) into a live room
// so connected editors see it. It returns false when nobody is editing.
func (h *collabHub) replace(id, text, lang, title string) bool {
	h.mu.Lock()
	r := h.rooms[id]
	h.mu.Unlock()
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false
	}
	op := (&TextOp{}).Delete(len(r.doc)).InsertString(normalizeNewlines(text))
	if err := r.applyLocked(op, ""); err != nil {
		log.Printf("collab: replace %s: %v", id, err)
	}
	r.title = title
	if lang != r.lang {
		r.lang = lang
		r.broadcastLocked(collabMessage{Type: "lang", Lang: &lang}, "")
	}
	r.scheduleSaveLocked()
	return true
}

// shutdown stops accepting edits, disconnects every client and saves every
// room. Clients reconnect to the next server process and resend any edits
// that did not make it.
func (h *collabHub) shutdown() {
	h.mu.Lock()
	h.closing = true
	rooms := make([]*collabRoom, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()
	for _, r := range rooms {
		r.mu.Lock()
		r.closed = true
		for _, c := range r.clients {
			if c.conn != nil {
				c.conn.Close()
			}
		}
		r.mu.Unlock()
		r.save()
	}
}

func (r *collabRoom) addClient(c *collabClient) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.peer.Color = collabColors[r.colorIdx%len(collabColors)]
	r.colorIdx++
	peers := make([]*collabPeer, 0, len(r.clients))
	for _, other := range r.clients {
		p := other.peer
		peers = append(peers, &p)
	}
	fresh := r.rev == 0 && len(r.clients) == 0
	r.clients[c.peer.ID] = c
	text := string(utf16.Decode(r.doc))
	rev, lang, self, lastSeq := r.rev, r.lang, c.peer, r.lastSeq[c.key]
	r.sendLocked(c, collabMessage{
		Type: "init", Rev: &rev, Text: &text, Lang: &lang, Peer: &self, Peers: peers,
		Session: r.session, LastSeq: &lastSeq, Fresh: fresh,
	})
	r.broadcastLocked(collabMessage{Type: "join", Peer: &self}, c.peer.ID)
}

func (r *collabRoom) removeClient(c *collabClient) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.clients[c.peer.ID]; ok {
		delete(r.clients, c.peer.ID)
		close(c.send)
		r.broadcastLocked(collabMessage{Type: "leave", ClientID: c.peer.ID}, "")
	}
	return len(r.clients)
}

// sendLocked queues a message for one client. A client that can't keep up
// is disconnected; it will resync when it reconnects.
func (r *collabRoom) sendLocked(c *collabClient, msg collabMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("collab: marshal: %v", err)
		return
	}
	select {
	case c.send <- data:
	default:
		if c.conn != nil {
			c.conn.Close()
		}
	}
}

func (r *collabRoom) broadcastLocked(msg collabMessage, except string) {
	for id, c := range r.clients {
		if id != except {
			r.sendLocked(c, msg)
		}
	}
}

// applyLocked applies an operation that is based on the current revision.
func (r *collabRoom) applyLocked(op *TextOp, from string) error {
	if op.targetLen > collabMaxDocLen {
		return fmt.Errorf("document too large")
	}
	doc, err := op.Apply(r.doc)
	if err != nil {
		return err
	}
	r.doc = doc
	r.history = append(r.history, op)
	r.rev++
	if len(r.history) > collabHistoryMax {
		drop := len(r.history) - collabHistoryMax/2
		r.history = append([]*TextOp(nil), r.history[drop:]...)
		r.histBase += drop
	}
	for _, c := range r.clients {
		if c.peer.Sel != nil {
			c.peer.Sel.Anchor = op.TransformIndex(c.peer.Sel.Anchor)
			c.peer.Sel.Head = op.TransformIndex(c.peer.Sel.Head)
		}
	}
	rev := r.rev
	for id, c := range r.clients {
		if id == from {
			r.sendLocked(c, collabMessage{Type: "ack", Rev: &rev})
		} else {
			r.sendLocked(c, collabMessage{Type: "op", Rev: &rev, Op: op, ClientID: from})
		}
	}
	return nil
}

// receiveOp handles an operation a client made against revision rev.
func (r *collabRoom) receiveOp(c *collabClient, rev, seq int, op *TextOp) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return fmt.Errorf("server shutting down")
	}
	if c.key != "" && seq > 0 && seq <= r.lastSeq[c.key] {
		return fmt.Errorf("duplicate operation")
	}
	if rev < r.histBase || rev > r.rev {
		return fmt.Errorf("resync")
	}
	for _, concurrent := range r.history[rev-r.histBase:] {
		var err error
		if op, _, err = TransformOps(op, concurrent); err != nil {
			return err
		}
	}
	if err := r.applyLocked(op, c.peer.ID); err != nil {
		return err
	}
	if c.key != "" && seq > 0 {
		r.lastSeq[c.key] = seq
	}
	r.scheduleSaveLocked()
	return nil
}

func (r *collabRoom) setSelection(c *collabClient, sel *collabSelection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sel == nil {
		c.peer.Sel = nil
	} else {
		s := *sel
		clamp := func(i int) int {
			if i < 0 {
				return 0
			}
			if i > len(r.doc) {
				return len(r.doc)
			}
			return i
		}
		s.Anchor, s.Head = clamp(s.Anchor), clamp(s.Head)
		c.peer.Sel = &s
	}
	r.broadcastLocked(collabMessage{Type: "cursor", ClientID: c.peer.ID, Sel: c.peer.Sel}, c.peer.ID)
}

func (r *collabRoom) setLanguage(c *collabClient, lang string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || lang == r.lang {
		return
	}
	r.lang = lang
	r.broadcastLocked(collabMessage{Type: "lang", Lang: &lang, ClientID: c.peer.ID}, c.peer.ID)
	r.scheduleSaveLocked()
}

func (r *collabRoom) setName(c *collabClient, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c.peer.Name = name
	p := c.peer
	r.broadcastLocked(collabMessage{Type: "join", Peer: &p}, c.peer.ID)
}

func (r *collabRoom) scheduleSaveLocked() {
	r.dirty = true
	if r.timer == nil {
		r.timer = time.AfterFunc(collabSaveDelay, r.save)
	} else {
		r.timer.Reset(collabSaveDelay)
	}
}

// save persists the current document if it has unsaved changes.
func (r *collabRoom) save() {
	r.saveMu.Lock()
	defer r.saveMu.Unlock()
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return
	}
	r.dirty = false
	text, lang, title, rev := string(utf16.Decode(r.doc)), r.lang, r.title, r.rev
	r.mu.Unlock()

	if err := r.hub.store.UpdatePaste(r.id, text, lang, title); err != nil {
		log.Printf("collab: save %s: %v", r.id, err)
		r.mu.Lock()
		r.scheduleSaveLocked()
		r.mu.Unlock()
		return
	}
	r.mu.Lock()
	r.broadcastLocked(collabMessage{Type: "saved", Rev: &rev}, "")
	r.mu.Unlock()
}

func cleanName(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > collabMaxNameLen {
		s = string(r[:collabMaxNameLen])
	}
	return s
}

// sameOrigin rejects cross-site WebSocket connections.
func sameOrigin(cfg *websocket.Config, req *http.Request) error {
	origin := req.Header.Get("Origin")
	if origin == "" {
		return nil // non-browser client
	}
	u, err := url.Parse(origin)
	if err != nil || !strings.EqualFold(u.Host, req.Host) {
		return fmt.Errorf("cross-origin websocket rejected")
	}
	return nil
}

func (h *collabHub) handler() http.Handler {
	return websocket.Server{Handshake: sameOrigin, Handler: h.serve}
}

func (h *collabHub) serve(conn *websocket.Conn) {
	conn.MaxPayloadBytes = collabMaxMessage
	req := conn.Request()
	id := strings.TrimSpace(req.URL.Query().Get("id"))
	if id == "" {
		websocket.JSON.Send(conn, collabMessage{Type: "error", Error: "missing id"})
		return
	}
	name := cleanName(req.URL.Query().Get("name"))
	if name == "" {
		name = "Anonymous " + collabAnimals[rand.Intn(len(collabAnimals))]
	}
	key := req.URL.Query().Get("key")
	if len(key) > 64 {
		key = ""
	}
	c := &collabClient{
		key:  key,
		peer: collabPeer{ID: uuid.New().String()[:8], Name: name},
		send: make(chan []byte, collabSendBuffer),
		conn: conn,
	}
	room, err := h.join(id, c)
	if err != nil {
		websocket.JSON.Send(conn, collabMessage{Type: "error", Error: "paste not found"})
		return
	}
	writerDone := make(chan struct{})
	defer func() {
		h.leave(room, c)
		<-writerDone // flush queued messages before the connection closes
	}()

	go func() {
		defer close(writerDone)
		for data := range c.send {
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := websocket.Message.Send(conn, string(data)); err != nil {
				conn.Close()
				// Drain so the room never blocks on this client.
				for range c.send {
				}
				return
			}
		}
	}()

	for {
		var data []byte
		if err := websocket.Message.Receive(conn, &data); err != nil {
			return
		}
		var msg collabMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "op":
			if msg.Rev == nil || msg.Op == nil {
				return
			}
			if err := room.receiveOp(c, *msg.Rev, msg.Seq, msg.Op); err != nil {
				room.mu.Lock()
				room.sendLocked(c, collabMessage{Type: "error", Error: err.Error()})
				room.mu.Unlock()
				return
			}
		case "cursor":
			room.setSelection(c, msg.Sel)
		case "lang":
			if msg.Lang != nil && len(*msg.Lang) <= collabMaxLanguageLen {
				room.setLanguage(c, *msg.Lang)
			}
		case "name":
			if n := cleanName(msg.Name); n != "" {
				room.setName(c, n)
			}
		case "ping":
		}
	}
}

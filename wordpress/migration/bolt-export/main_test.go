package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

const pasteID = "11111111-1111-4111-8111-111111111111"
const pasteTwo = "22222222-2222-4222-8222-222222222222"
const diffID = "33333333-3333-4333-8333-333333333333"
const snapshotID = "44444444-4444-4444-8444-444444444444"
const snapshotTwo = "55555555-5555-4555-8555-555555555555"
const snapshotTime = "2038-01-19T03:14:08.123456789Z"

func fixture(t *testing.T, modify func(*bolt.Tx) error) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "synthetic.db")
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"pastes", "diffs", "snapshots", "snapshot_index"} {
			if _, err := tx.CreateBucket([]byte(name)); err != nil {
				return err
			}
		}
		rows := map[string][]map[string]string{
			"pastes": {
				{"PK": pasteTwo, "SK": "0000-02-29T00:00:00Z", "Language": "", "Text": "", "Title": ""},
				{"PK": pasteID, "SK": "2026-10-24T23:30:00-02:00", "Language": "clojure", "Text": "Synthetic only: café e\u0301 日本語 😀\r\n<script>&\"\\/\t\x00\u2028\u2029", "Title": "  Synthetic title 🚀  "},
			},
			"diffs": {{"PK": diffID, "SK": "2026-10-24T23:30:01Z", "OldText": "old\r\n", "NewText": "new\n😀"}},
			"snapshots": {
				{"PK": snapshotTwo, "SK": snapshotTime, "PasteID": pasteID, "Name": "same-time tie", "Language": "text", "Text": "immutable second", "Title": ""},
				{"PK": snapshotID, "SK": snapshotTime, "PasteID": pasteID, "Name": " named snapshot ", "Language": "clojure", "Text": "immutable first\x00😀", "Title": "Snapshot title"},
			},
		}
		for _, kind := range kinds {
			for _, row := range rows[kind] {
				raw, _ := json.Marshal(row)
				if err := tx.Bucket([]byte(kind)).Put([]byte(row["PK"]), raw); err != nil {
					return err
				}
				if kind == "snapshots" {
					if err := tx.Bucket([]byte("snapshot_index")).Put([]byte(row["PasteID"]+"\x00"+row["SK"]+"\x00"+row["PK"]), []byte(row["PK"])); err != nil {
						return err
					}
				}
			}
		}
		if modify != nil {
			return modify(tx)
		}
		return nil
	})
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSyntheticRoundTrip(t *testing.T) {
	path := fixture(t, nil)
	before, _ := os.ReadFile(path)
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	first, result, err := exportBackup(path)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := exportBackup(path)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatalf("not deterministic: %v", err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("backup changed")
	}
	if result.Counts != (Counts{2, 1, 2}) || result.SourceSHA256 != digest(before) {
		t.Fatal("wrong counts or source hash")
	}
	if result.Records[0].Fields[0] != pasteID || result.Records[3].Fields[0] != snapshotID || result.Records[4].Fields[0] != snapshotTwo {
		t.Fatal("unstable order")
	}
	if result.Records[0].Fields[1] != "2026-10-24T23:30:00-02:00" || result.Records[3].Fields[1] != snapshotTime || result.Records[3].Fields[2] != pasteID {
		t.Fatal("timestamps/relationship changed")
	}
	if !strings.Contains(result.Records[0].Fields[3], "😀\r\n<script>&\"\\/\t\x00\u2028\u2029") {
		t.Fatal("text bytes changed")
	}
	if dest := os.Getenv("PBIN_SYNTHETIC_EXPORT"); dest != "" {
		if err := writeNew(dest, first); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLegacyBoltCompatibility(t *testing.T) {
	path := os.Getenv("PBIN_LEGACY_BOLT")
	if path == "" {
		t.Fatal("generate the archived-Bolt synthetic fixture via wordpress/ci/check-legacy-import-unit.sh")
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, exported, err := exportBackup(path)
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("legacy backup bytes changed")
	}
	raw, err := os.ReadFile("../tests/synthetic.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected Export
	if err = json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	gotRows, _ := json.Marshal(exported.Records)
	wantRows, _ := json.Marshal(expected.Records)
	if exported.Counts != expected.Counts || exported.ContentSHA256 != expected.ContentSHA256 || !bytes.Equal(gotRows, wantRows) {
		t.Fatal("maintained reader disagrees with actual archived Bolt fixture")
	}
}

func replace(tx *bolt.Tx, kind, id string, changes map[string]string, omit string) error {
	bucket := tx.Bucket([]byte(kind))
	var row map[string]string
	if err := json.Unmarshal(bucket.Get([]byte(id)), &row); err != nil {
		return err
	}
	for key, value := range changes {
		row[key] = value
	}
	delete(row, omit)
	raw, _ := json.Marshal(row)
	return bucket.Put([]byte(id), raw)
}

func TestRefusesLossAndUnsupportedSources(t *testing.T) {
	cases := map[string]func(*bolt.Tx) error{
		"missing title":  func(tx *bolt.Tx) error { return replace(tx, "pastes", pasteID, nil, "Title") },
		"extra field":    func(tx *bolt.Tx) error { return replace(tx, "pastes", pasteID, map[string]string{"Unknown": "x"}, "") },
		"mismatched key": func(tx *bolt.Tx) error { return replace(tx, "pastes", pasteID, map[string]string{"PK": pasteTwo}, "") },
		"non UUID ID":    func(tx *bolt.Tx) error { return replace(tx, "pastes", pasteID, map[string]string{"PK": "bad"}, "") },
		"wide timestamp": func(tx *bolt.Tx) error {
			return replace(tx, "pastes", pasteID, map[string]string{"SK": "2026-01-01T00:00:00.123456789+01:00"}, "")
		},
		"invalid date": func(tx *bolt.Tx) error {
			return replace(tx, "pastes", pasteID, map[string]string{"SK": "2026-02-30T00:00:00Z"}, "")
		},
		"invalid offset": func(tx *bolt.Tx) error {
			return replace(tx, "pastes", pasteID, map[string]string{"SK": "2026-02-28T00:00:00+24:00"}, "")
		},
		"orphan snapshot": func(tx *bolt.Tx) error {
			return replace(tx, "snapshots", snapshotID, map[string]string{"PasteID": diffID}, "")
		},
		"missing index": func(tx *bolt.Tx) error { return tx.DeleteBucket([]byte("snapshot_index")) },
		"stale index": func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("snapshot_index")).Put([]byte("bad-index"), []byte(snapshotID))
		},
		"extra bucket": func(tx *bolt.Tx) error { _, err := tx.CreateBucket([]byte("unsupported")); return err },
		"nested bucket": func(tx *bolt.Tx) error {
			_, err := tx.Bucket([]byte("pastes")).CreateBucket([]byte("nested"))
			return err
		},
		"missing required bucket": func(tx *bolt.Tx) error { return tx.DeleteBucket([]byte("diffs")) },
		"duplicate JSON key": func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("pastes")).Put([]byte(pasteID), []byte(`{"PK":"`+pasteID+`","PK":"`+pasteID+`","SK":"2026-01-01T00:00:00Z","Text":"x","Language":"text","Title":""}`))
		},
		"null text": func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("pastes")).Put([]byte(pasteID), []byte(`{"PK":"`+pasteID+`","SK":"2026-01-01T00:00:00Z","Text":null,"Language":"text","Title":""}`))
		},
		"invalid UTF8": func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("pastes")).Put([]byte(pasteID), []byte("{\"Text\":\"\xff\"}"))
		},
		"unpaired surrogate": func(tx *bolt.Tx) error {
			return tx.Bucket([]byte("pastes")).Put([]byte(pasteID), []byte(`{"PK":"`+pasteID+`","SK":"2026-01-01T00:00:00Z","Text":"\ud800","Language":"text","Title":""}`))
		},
		"oversized row": func(tx *bolt.Tx) error {
			return replace(tx, "pastes", pasteID, map[string]string{"Text": strings.Repeat("x", maxRecordBytes)}, "")
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			path := fixture(t, change)
			before, _ := os.ReadFile(path)
			out, _, err := exportBackup(path)
			if err == nil || out != nil {
				t.Fatal("expected refusal")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("source changed on refusal")
			}
		})
	}
}

func TestOldDatabaseAndEmptyExport(t *testing.T) {
	path := fixture(t, func(tx *bolt.Tx) error {
		for _, kind := range []string{"snapshots", "snapshot_index", "pastes", "diffs"} {
			if err := tx.DeleteBucket([]byte(kind)); err != nil {
				return err
			}
		}
		for _, kind := range []string{"pastes", "diffs"} {
			if _, err := tx.CreateBucket([]byte(kind)); err != nil {
				return err
			}
		}
		return nil
	})
	out, result, err := exportBackup(path)
	if err != nil || result.Counts != (Counts{}) || !bytes.Contains(out, []byte(`"records":[]`)) {
		t.Fatalf("old empty source: %v", err)
	}
}

func TestNoDefaultCreationOrOverwrite(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.db")
	if _, _, err := exportBackup(missing); err == nil {
		t.Fatal("missing file accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("created missing database")
	}
	path := fixture(t, nil)
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := exportBackup(link); err == nil {
		t.Fatal("symlink accepted")
	}
	dest := filepath.Join(dir, "result.json")
	if err := writeNew(dest, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writeNew(dest, []byte("second")); err == nil {
		t.Fatal("overwrote export")
	}
	data, _ := os.ReadFile(dest)
	if string(data) != "first" {
		t.Fatal("destination changed")
	}
	info, _ := os.Stat(dest)
	if info.Mode().Perm() != 0600 {
		t.Fatal("export not private")
	}
}

func TestUnicodeEscapeValidation(t *testing.T) {
	for _, raw := range []string{`{"Text":"\ud83d\ude00"}`, `{"Text":"\\ud800"}`, `{"Text":"\ufffd"}`} {
		if _, err := strictRecord([]byte(raw), []string{"Text"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, raw := range []string{`{"Text":"\ud800"}`, `{"Text":"\udc00"}`, `{"Text":"\ud800\u0000"}`, `{"Text":"x"} {}`, `{"Text":"x","Text":"x"}`} {
		if _, err := strictRecord([]byte(raw), []string{"Text"}); err == nil {
			t.Fatal("invalid source accepted")
		}
	}
}

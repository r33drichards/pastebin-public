// Command bolt-export reads an operator-supplied OFFLINE backup. It has no server,
// cloud SDK, credential discovery, write transaction, repair, or deletion mode.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
)

const (
	format           = "pbin-bolt-export-v1"
	maxDatabaseBytes = 1 << 30
	maxExportBytes   = 64 << 20
	maxContentBytes  = 32 << 20
	maxRecordBytes   = 4 << 20
	maxRecords       = 100000
)

var kinds = []string{"pastes", "diffs", "snapshots"}
var fields = map[string][]string{
	"pastes":    {"PK", "SK", "Language", "Text", "Title"},
	"diffs":     {"PK", "SK", "OldText", "NewText"},
	"snapshots": {"PK", "SK", "PasteID", "Name", "Language", "Text", "Title"},
}
var uuid = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
var timestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$`)

type Record struct {
	Kind   string   `json:"kind"`
	Fields []string `json:"fields"`
	SHA256 string   `json:"sha256"`
}
type Counts struct {
	Pastes    int `json:"pastes"`
	Diffs     int `json:"diffs"`
	Snapshots int `json:"snapshots"`
}
type Export struct {
	Format        string   `json:"format"`
	SourceSHA256  string   `json:"source_sha256"`
	Counts        Counts   `json:"counts"`
	ContentSHA256 string   `json:"content_sha256"`
	Records       []Record `json:"records"`
}

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func rowHash(kind string, values []string) string {
	h := sha256.New()
	fmt.Fprintf(h, "pbin-row-v1\x00%s\x00", kind)
	for _, value := range values {
		fmt.Fprintf(h, "%d:", len(value))
		io.WriteString(h, value)
	}
	return hex.EncodeToString(h.Sum(nil))
}
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", errors.New("cannot read supplied backup")
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxDatabaseBytes+1))
	if err != nil || n > maxDatabaseBytes {
		return "", errors.New("backup read failed or exceeds 1 GiB bound")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// encoding/json replaces invalid UTF-8 and lone UTF-16 surrogates. Refuse these
// rather than silently modifying legacy text, including duplicate object keys.
func strictRecord(raw []byte, expected []string) (map[string]string, error) {
	if !utf8.Valid(raw) || len(raw) > maxRecordBytes {
		return nil, errors.New("invalid UTF-8 or oversized source record")
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) || raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return nil, errors.New("invalid Unicode escape")
		}
		n, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return nil, errors.New("invalid Unicode escape")
		}
		i += 4
		if n >= 0xD800 && n <= 0xDBFF {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return nil, errors.New("unpaired Unicode surrogate")
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return nil, errors.New("unpaired Unicode surrogate")
			}
			i += 6
		} else if n >= 0xDC00 && n <= 0xDFFF {
			return nil, errors.New("unpaired Unicode surrogate")
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("expected source object")
	}
	result := make(map[string]string)
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return nil, errors.New("invalid source JSON")
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("invalid source field")
		}
		if _, found := result[key]; found {
			return nil, errors.New("duplicate source field")
		}
		var value any
		if d.Decode(&value) != nil {
			return nil, errors.New("invalid source JSON")
		}
		text, ok := value.(string)
		if !ok {
			return nil, errors.New("source fields must be strings, not absent/null/coerced")
		}
		result[key] = text
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, errors.New("invalid source JSON")
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errors.New("trailing source JSON")
	}
	if len(result) != len(expected) {
		return nil, errors.New("missing or unsupported source fields")
	}
	for _, key := range expected {
		if _, found := result[key]; !found {
			return nil, errors.New("missing or unsupported source fields")
		}
	}
	return result, nil
}

func validTimestamp(value string) bool {
	if len(value) > 30 || !timestamp.MatchString(value) {
		return false
	}
	// Go's parser accepts out-of-range offset hours/minutes in some versions.
	if value[len(value)-1] != 'Z' {
		offset := value[len(value)-5:]
		h, _ := strconv.Atoi(offset[:2])
		m, _ := strconv.Atoi(offset[3:])
		if h > 23 || m > 59 {
			return false
		}
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func exportBackup(path string) (_ []byte, result Export, err error) {
	result = Export{Format: format, Records: []Record{}}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxDatabaseBytes {
		return nil, result, errors.New("supply a regular offline backup of at most 1 GiB (not a symlink)")
	}
	db, err := bolt.Open(path, 0400, &bolt.Options{ReadOnly: true, Timeout: time.Second})
	if err != nil {
		return nil, result, errors.New("cannot open offline backup read-only; ensure no writer holds it")
	}
	defer db.Close()
	result.SourceSHA256, err = fileHash(path)
	if err != nil {
		return nil, result, err
	}
	err = db.View(func(tx *bolt.Tx) error {
		broken := false
		for problem := range tx.Check() {
			if problem != nil {
				broken = true
			}
		}
		if broken {
			return errors.New("Bolt consistency check failed; no export produced")
		}
		if err := tx.ForEach(func(name []byte, _ *bolt.Bucket) error {
			switch string(name) {
			case "pastes", "diffs", "snapshots", "snapshot_index":
				return nil
			}
			return errors.New("unsupported source bucket; no data silently skipped")
		}); err != nil {
			return err
		}
		parents := make(map[string]bool)
		snapshots := make(map[string]string)
		contentBytes := 0
		for _, kind := range kinds {
			bucket := tx.Bucket([]byte(kind))
			if bucket == nil {
				if kind == "snapshots" {
					continue
				}
				return fmt.Errorf("missing %s bucket", kind)
			}
			err := bucket.ForEach(func(key, value []byte) error {
				position := len(result.Records) + 1
				if position > maxRecords || value == nil {
					return errors.New("record bound exceeded or nested source bucket")
				}
				row, err := strictRecord(value, fields[kind])
				if err != nil {
					return fmt.Errorf("%s record %d: %w", kind, position, err)
				}
				if string(key) != row["PK"] || !uuid.MatchString(row["PK"]) {
					return fmt.Errorf("%s record %d: key/ID mismatch or unsupported UUID", kind, position)
				}
				if !validTimestamp(row["SK"]) {
					return fmt.Errorf("%s record %d: timestamp is invalid or exceeds schema width; no normalization allowed", kind, position)
				}
				if kind == "pastes" {
					parents[row["PK"]] = true
				}
				if kind == "snapshots" {
					if !parents[row["PasteID"]] {
						return fmt.Errorf("snapshot record %d: missing source parent", position)
					}
					snapshots[row["PK"]] = row["PasteID"] + "\x00" + row["SK"] + "\x00" + row["PK"]
				}
				values := make([]string, 0, len(fields[kind]))
				rowBytes := 0
				for _, field := range fields[kind] {
					values = append(values, row[field])
					rowBytes += len(row[field])
				}
				contentBytes += rowBytes
				if rowBytes > maxRecordBytes || contentBytes > maxContentBytes {
					return errors.New("content bound exceeded")
				}
				result.Records = append(result.Records, Record{kind, values, rowHash(kind, values)})
				switch kind {
				case "pastes":
					result.Counts.Pastes++
				case "diffs":
					result.Counts.Diffs++
				case "snapshots":
					result.Counts.Snapshots++
				}
				return nil
			})
			if err != nil {
				return err
			}
		}
		index := tx.Bucket([]byte("snapshot_index"))
		seen := make(map[string]bool)
		if index != nil {
			if err := index.ForEach(func(key, value []byte) error {
				id := string(value)
				expected, found := snapshots[id]
				if value == nil || !found || string(key) != expected || seen[id] {
					return errors.New("inconsistent snapshot index; explicit reconciliation required")
				}
				seen[id] = true
				return nil
			}); err != nil {
				return err
			}
		}
		if len(seen) != len(snapshots) {
			return errors.New("missing snapshot index entries; explicit reconciliation required")
		}
		return nil
	})
	if err != nil {
		return nil, result, err
	}
	after, err := fileHash(path)
	if err != nil || after != result.SourceSHA256 {
		return nil, result, errors.New("backup changed during read; supply a frozen offline copy")
	}
	h := sha256.New()
	io.WriteString(h, "pbin-content-v1\n")
	for _, row := range result.Records {
		io.WriteString(h, row.SHA256+"\n")
	}
	result.ContentSHA256 = hex.EncodeToString(h.Sum(nil))
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(result); err != nil {
		return nil, result, errors.New("cannot encode export")
	}
	if out.Len() > maxExportBytes {
		return nil, result, errors.New("export exceeds 64 MiB bound")
	}
	return out.Bytes(), result, nil
}

func writeNew(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".pbin-export-*")
	if err != nil {
		return errors.New("cannot create private export temporary file")
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if _, err = f.Write(data); err != nil {
		return errors.New("cannot write export")
	}
	if err = f.Sync(); err != nil {
		return errors.New("cannot sync export")
	}
	if err = f.Close(); err != nil {
		return errors.New("cannot close export")
	}
	// Link publishes a complete file only if the destination does not exist.
	if err = os.Link(name, path); err != nil {
		return errors.New("cannot publish export; destination must be new on the same filesystem")
	}
	return nil
}

func main() {
	backup := flag.String("backup", "", "explicit path to an offline BoltDB backup (read-only)")
	out := flag.String("out", "", "new private JSON file; never overwrites an existing file")
	flag.Parse()
	if *backup == "" || *out == "" || flag.NArg() != 0 || strings.TrimSpace(*backup) == "" {
		fmt.Fprintln(os.Stderr, "Supply --backup and --out; no default database is inspected")
		os.Exit(2)
	}
	data, result, err := exportBackup(*backup)
	if err == nil {
		err = writeNew(*out, data)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Export refused:", err)
		os.Exit(1)
	}
	receipt := struct {
		Format  string `json:"format"`
		Source  string `json:"source_sha256"`
		Export  string `json:"export_sha256"`
		Counts  Counts `json:"counts"`
		Content string `json:"content_sha256"`
	}{format, result.SourceSHA256, digest(data), result.Counts, result.ContentSHA256}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		fmt.Fprintln(os.Stderr, "Export file was created, but its receipt could not be written; inspect the file before retrying")
		os.Exit(1)
	}
}

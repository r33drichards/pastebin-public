// Synthetic compatibility-fixture writer ONLY. Never reads a real backup and
// is not linked into the maintained bbolt exporter. See ../../README.md.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/boltdb/bolt"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("supply a new synthetic database path only")
	}
	// Fixed checked-in synthetic data, not an operator-supplied record source.
	raw, err := os.ReadFile("../synthetic.json")
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != "6a2ec83183f816a9355fa2639f553c7be332b8cf9123b260a9568ded64c218fd" {
		return fmt.Errorf("checked-in synthetic fixture digest changed")
	}
	var source struct {
		Records []struct {
			Kind   string   `json:"kind"`
			Fields []string `json:"fields"`
		} `json:"records"`
	}
	if err = json.Unmarshal(raw, &source); err != nil {
		return err
	}
	f, err := os.OpenFile(os.Args[1], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	db, err := bolt.Open(os.Args[1], 0600, nil)
	if err != nil {
		return err
	}
	defer db.Close()
	names := map[string][]string{
		"pastes":    {"PK", "SK", "Language", "Text", "Title"},
		"diffs":     {"PK", "SK", "OldText", "NewText"},
		"snapshots": {"PK", "SK", "PasteID", "Name", "Language", "Text", "Title"},
	}
	return db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"pastes", "diffs", "snapshots", "snapshot_index"} {
			if _, err := tx.CreateBucket([]byte(name)); err != nil {
				return err
			}
		}
		for _, record := range source.Records {
			fields := names[record.Kind]
			if len(fields) != len(record.Fields) {
				return fmt.Errorf("bad synthetic shape")
			}
			row := map[string]string{}
			for i, name := range fields {
				row[name] = record.Fields[i]
			}
			encoded, err := json.Marshal(row)
			if err != nil {
				return err
			}
			if err = tx.Bucket([]byte(record.Kind)).Put([]byte(row["PK"]), encoded); err != nil {
				return err
			}
			if record.Kind == "snapshots" {
				if err = tx.Bucket([]byte("snapshot_index")).Put([]byte(row["PasteID"]+"\x00"+row["SK"]+"\x00"+row["PK"]), []byte(row["PK"])); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Synthetic fixture writer failed:", err)
		os.Exit(1)
	}
}

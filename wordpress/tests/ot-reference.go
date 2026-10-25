//go:build ignore

// Compile with the unmodified repository collab_ot.go in a temporary directory.
// It independently emits reference results for the PHP deterministic corpus.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"unicode/utf16"
)

func unitsHex(units []uint16) string {
	bytes := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(bytes[i*2:], unit)
	}
	return hex.EncodeToString(bytes)
}
func main() {
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 1024), 1<<20)
	output := json.NewEncoder(os.Stdout)
	for input.Scan() {
		var vector struct {
			Input struct {
				Doc string
				A   TextOp
				B   TextOp
			}
		}
		if err := json.Unmarshal(input.Bytes(), &vector); err != nil {
			panic(err)
		}
		doc := utf16.Encode([]rune(vector.Input.Doc))
		a, b := &vector.Input.A, &vector.Input.B
		ap, bp, err := TransformOps(a, b)
		if err != nil {
			panic(err)
		}
		da, err := a.Apply(doc)
		if err != nil {
			panic(err)
		}
		db, err := b.Apply(doc)
		if err != nil {
			panic(err)
		}
		result, err := bp.Apply(da)
		if err != nil {
			panic(err)
		}
		indices := make([]int, len(doc)+1)
		for i := range indices {
			indices[i] = a.TransformIndex(i)
		}
		if err := output.Encode(map[string]interface{}{"a": a, "b": b, "ap": ap, "bp": bp, "da": unitsHex(da), "db": unitsHex(db), "result": unitsHex(result), "indices": indices}); err != nil {
			panic(err)
		}
	}
	if err := input.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

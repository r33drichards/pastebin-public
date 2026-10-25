//go:build race

package main

// raceEnabled reports whether the race detector is on. boltdb/bolt v1.3.1
// trips checkptr under -race on modern Go, so Bolt-backed tests skip then.
const raceEnabled = true

package main

import (
	"encoding/json"
	"fmt"
	"unicode/utf16"
)

// Operational transformation for plain text, wire-compatible with ot.js.
//
// An operation is a list of components that walk over the whole document:
//   - a positive integer retains that many characters,
//   - a negative integer deletes that many characters,
//   - a string inserts that text.
//
// Lengths are measured in UTF-16 code units, which is what JavaScript strings
// and Monaco offsets use, so documents are stored as []uint16 on the server.

const (
	compRetain = iota
	compInsert
	compDelete
)

type opComponent struct {
	kind int
	n    int      // retain / delete count
	s    []uint16 // inserted text
}

func (c opComponent) length() int {
	if c.kind == compInsert {
		return len(c.s)
	}
	return c.n
}

// TextOp is a single text operation.
type TextOp struct {
	comps     []opComponent
	baseLen   int
	targetLen int
}

func (o *TextOp) Retain(n int) *TextOp {
	if n <= 0 {
		return o
	}
	o.baseLen += n
	o.targetLen += n
	if l := len(o.comps); l > 0 && o.comps[l-1].kind == compRetain {
		o.comps[l-1].n += n
	} else {
		o.comps = append(o.comps, opComponent{kind: compRetain, n: n})
	}
	return o
}

func (o *TextOp) Insert(s []uint16) *TextOp {
	if len(s) == 0 {
		return o
	}
	o.targetLen += len(s)
	l := len(o.comps)
	switch {
	case l > 0 && o.comps[l-1].kind == compInsert:
		o.comps[l-1].s = append(o.comps[l-1].s, s...)
	case l > 0 && o.comps[l-1].kind == compDelete:
		// Keep inserts before deletes so equivalent ops have one canonical form.
		if l > 1 && o.comps[l-2].kind == compInsert {
			o.comps[l-2].s = append(o.comps[l-2].s, s...)
		} else {
			del := o.comps[l-1]
			o.comps[l-1] = opComponent{kind: compInsert, s: append([]uint16(nil), s...)}
			o.comps = append(o.comps, del)
		}
	default:
		o.comps = append(o.comps, opComponent{kind: compInsert, s: append([]uint16(nil), s...)})
	}
	return o
}

func (o *TextOp) InsertString(s string) *TextOp {
	return o.Insert(utf16.Encode([]rune(s)))
}

func (o *TextOp) Delete(n int) *TextOp {
	if n <= 0 {
		return o
	}
	o.baseLen += n
	if l := len(o.comps); l > 0 && o.comps[l-1].kind == compDelete {
		o.comps[l-1].n += n
	} else {
		o.comps = append(o.comps, opComponent{kind: compDelete, n: n})
	}
	return o
}

// IsNoop reports whether the operation leaves the document unchanged.
func (o *TextOp) IsNoop() bool {
	return len(o.comps) == 0 || (len(o.comps) == 1 && o.comps[0].kind == compRetain)
}

// Apply applies the operation to doc and returns the new document.
func (o *TextOp) Apply(doc []uint16) ([]uint16, error) {
	if len(doc) != o.baseLen {
		return nil, fmt.Errorf("operation base length %d does not match document length %d", o.baseLen, len(doc))
	}
	out := make([]uint16, 0, o.targetLen)
	i := 0
	for _, c := range o.comps {
		switch c.kind {
		case compRetain:
			out = append(out, doc[i:i+c.n]...)
			i += c.n
		case compInsert:
			out = append(out, c.s...)
		case compDelete:
			i += c.n
		}
	}
	return out, nil
}

// TransformOps takes two operations a and b that apply to the same document
// and returns a' and b' such that apply(apply(S, a), b') == apply(apply(S, b), a').
// When both insert at the same position, a's insert goes first.
func TransformOps(a, b *TextOp) (*TextOp, *TextOp, error) {
	if a.baseLen != b.baseLen {
		return nil, nil, fmt.Errorf("both operations must have the same base length (%d != %d)", a.baseLen, b.baseLen)
	}
	ap, bp := &TextOp{}, &TextOp{}
	i1, i2 := 0, 0
	var c1, c2 *opComponent
	next := func(comps []opComponent, i *int) *opComponent {
		if *i >= len(comps) {
			return nil
		}
		c := comps[*i]
		*i++
		return &c
	}
	c1 = next(a.comps, &i1)
	c2 = next(b.comps, &i2)
	for c1 != nil || c2 != nil {
		if c1 != nil && c1.kind == compInsert {
			ap.Insert(c1.s)
			bp.Retain(len(c1.s))
			c1 = next(a.comps, &i1)
			continue
		}
		if c2 != nil && c2.kind == compInsert {
			ap.Retain(len(c2.s))
			bp.Insert(c2.s)
			c2 = next(b.comps, &i2)
			continue
		}
		if c1 == nil || c2 == nil {
			return nil, nil, fmt.Errorf("cannot transform operations: one is too short")
		}
		m := c1.n
		if c2.n < m {
			m = c2.n
		}
		switch {
		case c1.kind == compRetain && c2.kind == compRetain:
			ap.Retain(m)
			bp.Retain(m)
		case c1.kind == compDelete && c2.kind == compRetain:
			ap.Delete(m)
		case c1.kind == compRetain && c2.kind == compDelete:
			bp.Delete(m)
		}
		// delete/delete: both removed the same text, nothing to emit.
		c1.n -= m
		c2.n -= m
		if c1.n == 0 {
			c1 = next(a.comps, &i1)
		}
		if c2.n == 0 {
			c2 = next(b.comps, &i2)
		}
	}
	return ap, bp, nil
}

// TransformIndex maps a cursor position through the operation.
func (o *TextOp) TransformIndex(index int) int {
	newIndex, i := index, 0
	for _, c := range o.comps {
		if i > index {
			break
		}
		switch c.kind {
		case compRetain:
			i += c.n
		case compInsert:
			newIndex += len(c.s)
		case compDelete:
			d := c.n
			if index-i < d {
				d = index - i
			}
			newIndex -= d
			i += c.n
		}
	}
	return newIndex
}

func (o *TextOp) MarshalJSON() ([]byte, error) {
	parts := make([]interface{}, 0, len(o.comps))
	for _, c := range o.comps {
		switch c.kind {
		case compRetain:
			parts = append(parts, c.n)
		case compInsert:
			parts = append(parts, string(utf16.Decode(c.s)))
		case compDelete:
			parts = append(parts, -c.n)
		}
	}
	return json.Marshal(parts)
}

func (o *TextOp) UnmarshalJSON(data []byte) error {
	var parts []interface{}
	if err := json.Unmarshal(data, &parts); err != nil {
		return err
	}
	*o = TextOp{}
	for _, p := range parts {
		switch v := p.(type) {
		case float64:
			n := int(v)
			if float64(n) != v || n == 0 {
				return fmt.Errorf("invalid operation component %v", v)
			}
			if n > 0 {
				o.Retain(n)
			} else {
				o.Delete(-n)
			}
		case string:
			if v == "" {
				return fmt.Errorf("invalid empty insert")
			}
			o.InsertString(v)
		default:
			return fmt.Errorf("invalid operation component %v", p)
		}
	}
	return nil
}

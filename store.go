package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/dynamodb/dynamodbattribute"
	"github.com/aws/aws-sdk-go/service/dynamodb/dynamodbiface"
	"github.com/boltdb/bolt"
	petname "github.com/dustinkirkland/golang-petname"
	"github.com/google/uuid"
)

// DataStore is the interface for our database operations
type DataStore interface {
	GetPaste(id string) (*Paste, error)
	AddPaste(text, lang, title string) (string, error)
	UpdatePaste(id, text, lang, title string) error
	GetDiff(id string) (*Diff, error)
	AddDiff(oldText, newText string) (string, error)
	// Snapshots are immutable, timestamped copies of a paste. There is
	// deliberately no update or delete: once taken, a snapshot never changes.
	// An empty name gets an auto-generated petname.
	AddSnapshot(pasteID, name, text, lang, title string) (*Snapshot, error)
	GetSnapshot(id string) (*Snapshot, error)
	// ListSnapshots returns a paste's snapshots, newest first. Entries may
	// omit Text (listings only need metadata).
	ListSnapshots(pasteID string) ([]*Snapshot, error)
	Close() error
}

// Paste represents a paste item
type Paste struct {
	PK       string
	SK       string
	Language string
	Text     string
	Title    string
}

// Diff represents a diff item
type Diff struct {
	PK      string
	SK      string
	OldText string
	NewText string
}

// Snapshot is an immutable, timestamped copy of a paste. PK is the snapshot's
// own id and SK its creation time (RFC3339Nano, UTC), following the Paste and
// Diff conventions.
type Snapshot struct {
	PK       string
	SK       string
	PasteID  string
	Name     string
	Language string
	Text     string
	Title    string
}

// CreatedAt parses the snapshot's creation time out of SK.
func (s *Snapshot) CreatedAt() (time.Time, error) {
	return time.Parse(time.RFC3339Nano, s.SK)
}

// snapshotTimeFormat is RFC3339 with fixed-width nanoseconds (unlike
// RFC3339Nano, which drops trailing zeros), so snapshot keys sort
// chronologically as plain strings.
const snapshotTimeFormat = "2006-01-02T15:04:05.000000000Z07:00"

func newSnapshot(pasteID, name, text, lang, title string) *Snapshot {
	name = strings.TrimSpace(name)
	if name == "" {
		// e.g. "equally-cheerful-sailfish"
		name = petname.Generate(3, "-")
	}
	return &Snapshot{
		PK:       uuid.New().String(),
		SK:       time.Now().UTC().Format(snapshotTimeFormat),
		PasteID:  pasteID,
		Name:     name,
		Language: lang,
		Text:     text,
		Title:    title,
	}
}

// BoltStore implements DataStore using BoltDB
type BoltStore struct {
	db *bolt.DB
}

// DynamoStore implements DataStore using DynamoDB
type DynamoStore struct {
	svc       *dynamodb.DynamoDB
	tableName string
}

// NewDataStore creates a new DataStore based on the configuration
func NewDataStore() (DataStore, error) {
	dbType := os.Getenv("DB_TYPE")
	switch dbType {
	case "bolt":
		return NewBoltStore()
	case "dynamo":
		return NewDynamoStore()
	default:
		return NewBoltStore()
	}
}

// NewBoltStore creates a new BoltStore
func NewBoltStore() (*BoltStore, error) {
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "pbin.db"
	}
	// Time out instead of hanging if a previous process still holds the file
	// lock (e.g. during a redeploy); the platform will restart us.
	db, err := bolt.Open(dbPath, 0600, &bolt.Options{Timeout: 30 * time.Second})
	if err != nil {
		return nil, err
	}

	err = db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte("pastes"))
		if err != nil {
			return fmt.Errorf("create pastes bucket: %s", err)
		}
		_, err = tx.CreateBucketIfNotExists([]byte("diffs"))
		if err != nil {
			return fmt.Errorf("create diffs bucket: %s", err)
		}
		_, err = tx.CreateBucketIfNotExists([]byte("snapshots"))
		if err != nil {
			return fmt.Errorf("create snapshots bucket: %s", err)
		}
		_, err = tx.CreateBucketIfNotExists([]byte("snapshot_index"))
		if err != nil {
			return fmt.Errorf("create snapshot_index bucket: %s", err)
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	return &BoltStore{db: db}, nil
}

// NewDynamoStore creates a new DynamoStore
func NewDynamoStore() (*DynamoStore, error) {
	sess := session.Must(session.NewSession())
	limit := int64(10)
	tables, err := GetTables(sess, aws.Int64(limit))
	if err != nil {
		fmt.Println("Got an error retrieving table names:")
		fmt.Println(err)
		return nil, err
	}

	// create dynamodb table if it doesn't exist
	createTable := true
	for _, n := range tables {
		if strings.Compare(*n, PBIN_TABLE_NAME) == 0 {
			createTable = false
			break
		}
	}
	svc := dynamodb.New(sess)
	tableName := os.Getenv("DYNAMO_TABLE_NAME")
	if createTable {

		attributeDefinitions := []*dynamodb.AttributeDefinition{
			{
				AttributeName: aws.String("PK"),
				AttributeType: aws.String("S"),
			},
			{
				AttributeName: aws.String("SK"),
				AttributeType: aws.String("S"),
			},
		}

		keySchema := []*dynamodb.KeySchemaElement{
			{
				AttributeName: aws.String("PK"),
				KeyType:       aws.String("HASH"),
			},
			{
				AttributeName: aws.String("SK"),
				KeyType:       aws.String("RANGE"),
			},
		}

		go MakeTable(svc, attributeDefinitions, keySchema, aws.String(PBIN_TABLE_NAME))
	}
	return &DynamoStore{svc: svc, tableName: tableName}, nil
}

// GetTables retrieves a list of your Amazon DynamoDB tables
// Inputs:
//
//	sess is the current session, which provides configuration for the SDK's service clients
//	limit is the maximum number of tables to return
//
// Output:
//
//	If success, a list of the tables and nil
//	Otherwise, nil and an error from the call to ListTables
func GetTables(sess *session.Session, limit *int64) ([]*string, error) {
	svc := dynamodb.New(sess)

	result, err := svc.ListTables(&dynamodb.ListTablesInput{
		Limit: limit,
	})
	if err != nil {
		return nil, err
	}

	return result.TableNames, nil
}

// MakeTable creates an Amazon DynamoDB table
// Inputs:
//
//	sess is the current session, which provides configuration for the SDK's service clients
//	attributeDefinitions describe the table's attributes
//	keySchema defines the table schema
//	tableName is the name of the table
//
// Output:
//
//	If success, nil
//	Otherwise, an error from the call to CreateTable
func MakeTable(svc dynamodbiface.DynamoDBAPI, attributeDefinitions []*dynamodb.AttributeDefinition, keySchema []*dynamodb.KeySchemaElement, tableName *string) error {
	_, err := svc.CreateTable(&dynamodb.CreateTableInput{
		AttributeDefinitions: attributeDefinitions,
		KeySchema:            keySchema,
		TableName:            tableName,
		BillingMode:          aws.String(dynamodb.BillingModePayPerRequest),
	})
	return err
}

// GetPaste retrieves a paste from BoltDB
func (b *BoltStore) GetPaste(id string) (*Paste, error) {
	var paste Paste
	err := b.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("pastes"))
		v := bucket.Get([]byte(id))
		if v == nil {
			return fmt.Errorf("paste not found")
		}
		return json.Unmarshal(v, &paste)
	})
	if err != nil {
		return nil, err
	}
	return &paste, nil
}

// AddPaste adds a new paste to BoltDB
func (b *BoltStore) AddPaste(text, lang, title string) (string, error) {
	id := uuid.New().String()
	paste := Paste{
		PK:       id,
		SK:       time.Now().Format(time.RFC3339),
		Language: lang,
		Text:     text,
		Title:    title,
	}

	err := b.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("pastes"))
		encoded, err := json.Marshal(paste)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(id), encoded)
	})

	if err != nil {
		return "", err
	}
	return id, nil
}

// UpdatePaste updates an existing paste in BoltDB
func (b *BoltStore) UpdatePaste(id, text, lang, title string) error {
	return b.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("pastes"))
		v := bucket.Get([]byte(id))
		if v == nil {
			return fmt.Errorf("paste not found")
		}

		// Get existing paste to preserve PK and SK
		var existingPaste Paste
		if err := json.Unmarshal(v, &existingPaste); err != nil {
			return err
		}

		// Update fields
		existingPaste.Text = text
		existingPaste.Language = lang
		existingPaste.Title = title

		encoded, err := json.Marshal(existingPaste)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(id), encoded)
	})
}

// GetDiff retrieves a diff from BoltDB
func (b *BoltStore) GetDiff(id string) (*Diff, error) {
	var diff Diff
	err := b.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("diffs"))
		v := bucket.Get([]byte(id))
		if v == nil {
			return fmt.Errorf("diff not found")
		}
		return json.Unmarshal(v, &diff)
	})
	if err != nil {
		return nil, err
	}
	return &diff, nil
}

// AddDiff adds a new diff to BoltDB
func (b *BoltStore) AddDiff(oldText, newText string) (string, error) {
	id := uuid.New().String()
	diff := Diff{
		PK:      id,
		SK:      time.Now().Format(time.RFC3339),
		OldText: oldText,
		NewText: newText,
	}

	err := b.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("diffs"))
		encoded, err := json.Marshal(diff)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(id), encoded)
	})

	if err != nil {
		return "", err
	}
	return id, nil
}

// snapshotIndexKey orders a paste's snapshots by creation time in the
// snapshot_index bucket; the snapshot id breaks ties. NUL separates the parts
// because it can appear in none of them.
func snapshotIndexKey(pasteID, sk, id string) []byte {
	return []byte(pasteID + "\x00" + sk + "\x00" + id)
}

// AddSnapshot stores an immutable snapshot of a paste in BoltDB
func (b *BoltStore) AddSnapshot(pasteID, name, text, lang, title string) (*Snapshot, error) {
	snapshot := newSnapshot(pasteID, name, text, lang, title)
	err := b.db.Update(func(tx *bolt.Tx) error {
		// Databases created before snapshots existed lack the buckets.
		bucket, err := tx.CreateBucketIfNotExists([]byte("snapshots"))
		if err != nil {
			return err
		}
		index, err := tx.CreateBucketIfNotExists([]byte("snapshot_index"))
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		if err := bucket.Put([]byte(snapshot.PK), encoded); err != nil {
			return err
		}
		return index.Put(snapshotIndexKey(pasteID, snapshot.SK, snapshot.PK), []byte(snapshot.PK))
	})
	if err != nil {
		return nil, err
	}
	return snapshot, nil
}

// GetSnapshot retrieves a snapshot from BoltDB
func (b *BoltStore) GetSnapshot(id string) (*Snapshot, error) {
	var snapshot Snapshot
	err := b.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("snapshots"))
		if bucket == nil {
			return fmt.Errorf("snapshot not found")
		}
		v := bucket.Get([]byte(id))
		if v == nil {
			return fmt.Errorf("snapshot not found")
		}
		return json.Unmarshal(v, &snapshot)
	})
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// ListSnapshots returns a paste's snapshots from BoltDB, newest first
func (b *BoltStore) ListSnapshots(pasteID string) ([]*Snapshot, error) {
	var snapshots []*Snapshot
	err := b.db.View(func(tx *bolt.Tx) error {
		index := tx.Bucket([]byte("snapshot_index"))
		bucket := tx.Bucket([]byte("snapshots"))
		if index == nil || bucket == nil {
			return nil
		}
		prefix := []byte(pasteID + "\x00")
		c := index.Cursor()
		for k, id := c.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, id = c.Next() {
			v := bucket.Get(id)
			if v == nil {
				continue
			}
			var snapshot Snapshot
			if err := json.Unmarshal(v, &snapshot); err != nil {
				return err
			}
			snapshots = append(snapshots, &snapshot)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The index iterates oldest first; callers want newest first.
	for i, j := 0, len(snapshots)-1; i < j; i, j = i+1, j-1 {
		snapshots[i], snapshots[j] = snapshots[j], snapshots[i]
	}
	return snapshots, nil
}

// Close closes the BoltDB connection
func (b *BoltStore) Close() error {
	return b.db.Close()
}

// GetPaste retrieves a paste from DynamoDB
func (d *DynamoStore) GetPaste(id string) (*Paste, error) {
	result, err := d.svc.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(d.tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": {S: aws.String(id)},
		},
	})
	if err != nil {
		return nil, err
	}

	paste := &Paste{}
	err = dynamodbattribute.UnmarshalMap(result.Item, paste)
	if err != nil {
		return nil, err
	}

	return paste, nil
}

// AddPaste adds a new paste to DynamoDB
func (d *DynamoStore) AddPaste(text, lang, title string) (string, error) {
	id := uuid.New().String()
	paste := Paste{
		PK:       id,
		SK:       time.Now().Format(time.RFC3339),
		Language: lang,
		Text:     text,
		Title:    title,
	}

	av, err := dynamodbattribute.MarshalMap(paste)
	if err != nil {
		return "", err
	}

	_, err = d.svc.PutItem(&dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String(d.tableName),
	})
	if err != nil {
		return "", err
	}

	return id, nil
}

// UpdatePaste updates an existing paste in DynamoDB
func (d *DynamoStore) UpdatePaste(id, text, lang, title string) error {
	// First, get the existing paste to preserve SK
	existingPaste, err := d.GetPaste(id)
	if err != nil {
		return err
	}

	// Update fields
	existingPaste.Text = text
	existingPaste.Language = lang
	existingPaste.Title = title

	av, err := dynamodbattribute.MarshalMap(existingPaste)
	if err != nil {
		return err
	}

	_, err = d.svc.PutItem(&dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String(d.tableName),
	})
	return err
}

// GetDiff retrieves a diff from DynamoDB
func (d *DynamoStore) GetDiff(id string) (*Diff, error) {
	result, err := d.svc.GetItem(&dynamodb.GetItemInput{
		TableName: aws.String(d.tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": {S: aws.String(id)},
		},
	})
	if err != nil {
		return nil, err
	}

	diff := &Diff{}
	err = dynamodbattribute.UnmarshalMap(result.Item, diff)
	if err != nil {
		return nil, err
	}

	return diff, nil
}

// AddDiff adds a new diff to DynamoDB
func (d *DynamoStore) AddDiff(oldText, newText string) (string, error) {
	id := uuid.New().String()
	diff := Diff{
		PK:      id,
		SK:      time.Now().Format(time.RFC3339),
		OldText: oldText,
		NewText: newText,
	}

	av, err := dynamodbattribute.MarshalMap(diff)
	if err != nil {
		return "", err
	}

	_, err = d.svc.PutItem(&dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String(d.tableName),
	})
	if err != nil {
		return "", err
	}

	return id, nil
}

// snapshotListPK is the partition key that groups a paste's snapshots so
// they can be queried together, ordered by the timestamped sort key.
func snapshotListPK(pasteID string) string {
	return "snapshots#" + pasteID
}

// AddSnapshot stores an immutable snapshot of a paste in DynamoDB. The
// snapshot is written twice: once under its own id for direct lookup, and
// once under the paste's snapshot partition for listing in time order.
func (d *DynamoStore) AddSnapshot(pasteID, name, text, lang, title string) (*Snapshot, error) {
	snapshot := newSnapshot(pasteID, name, text, lang, title)

	av, err := dynamodbattribute.MarshalMap(snapshot)
	if err != nil {
		return nil, err
	}
	_, err = d.svc.PutItem(&dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String(d.tableName),
	})
	if err != nil {
		return nil, err
	}

	listItem := *snapshot
	listItem.PK = snapshotListPK(pasteID)
	listItem.SK = snapshot.SK + "#" + snapshot.PK
	av, err = dynamodbattribute.MarshalMap(&listItem)
	if err != nil {
		return nil, err
	}
	_, err = d.svc.PutItem(&dynamodb.PutItemInput{
		Item:      av,
		TableName: aws.String(d.tableName),
	})
	if err != nil {
		return nil, err
	}

	return snapshot, nil
}

// GetSnapshot retrieves a snapshot from DynamoDB
func (d *DynamoStore) GetSnapshot(id string) (*Snapshot, error) {
	result, err := d.svc.Query(&dynamodb.QueryInput{
		TableName:              aws.String(d.tableName),
		KeyConditionExpression: aws.String("PK = :pk"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(id)},
		},
		Limit: aws.Int64(1),
	})
	if err != nil {
		return nil, err
	}
	if len(result.Items) == 0 {
		return nil, fmt.Errorf("snapshot not found")
	}

	snapshot := &Snapshot{}
	err = dynamodbattribute.UnmarshalMap(result.Items[0], snapshot)
	if err != nil {
		return nil, err
	}
	return snapshot, nil
}

// ListSnapshots returns a paste's snapshots from DynamoDB, newest first
func (d *DynamoStore) ListSnapshots(pasteID string) ([]*Snapshot, error) {
	result, err := d.svc.Query(&dynamodb.QueryInput{
		TableName:              aws.String(d.tableName),
		KeyConditionExpression: aws.String("PK = :pk"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {S: aws.String(snapshotListPK(pasteID))},
		},
		ScanIndexForward: aws.Bool(false),
	})
	if err != nil {
		return nil, err
	}

	snapshots := make([]*Snapshot, 0, len(result.Items))
	for _, item := range result.Items {
		snapshot := &Snapshot{}
		if err := dynamodbattribute.UnmarshalMap(item, snapshot); err != nil {
			return nil, err
		}
		// Restore the snapshot's own keys from the list item's composite SK.
		if i := strings.Index(snapshot.SK, "#"); i >= 0 {
			snapshot.PK = snapshot.SK[i+1:]
			snapshot.SK = snapshot.SK[:i]
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

// Close is a no-op for DynamoDB as it doesn't require explicit closing
func (d *DynamoStore) Close() error {
	return nil
}
